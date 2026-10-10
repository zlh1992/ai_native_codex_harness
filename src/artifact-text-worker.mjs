// Receives only an immutable blob on stdin; no project paths or inherited credentials.
import mammoth from 'mammoth';
import JSZip from 'jszip';

console.log = console.warn = console.error = () => {};

// pdfjs-dist imports its canvas backend even when the worker only extracts the
// text layer. The optional native canvas package is not available in every
// supported Node installation, so provide the small matrix/path surface that
// keeps the text-only code path loadable. Rendering is never requested here.
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(value) {
      const source = Array.isArray(value) || ArrayBuffer.isView(value) ? [...value]
        : value && typeof value === 'object' ? [value.a, value.b, value.c, value.d, value.e, value.f] : [];
      [this.a, this.b, this.c, this.d, this.e, this.f] = source.length >= 6 ? source : [1, 0, 0, 1, 0, 0];
    }
    multiplySelf(other) {
      const [a, b, c, d, e, f] = [this.a, this.b, this.c, this.d, this.e, this.f];
      this.a = a * other.a + c * other.b; this.b = b * other.a + d * other.b;
      this.c = a * other.c + c * other.d; this.d = b * other.c + d * other.d;
      this.e = a * other.e + c * other.f + e; this.f = b * other.e + d * other.f + f;
      return this;
    }
    preMultiplySelf(other) { return new DOMMatrix(other).multiplySelf(this).copyTo(this); }
    copyTo(target) { Object.assign(target, this); return target; }
    invertSelf() {
      const det = this.a * this.d - this.b * this.c;
      if (!det) { this.a = this.d = NaN; this.b = this.c = this.e = this.f = NaN; return this; }
      const { a, b, c, d, e, f } = this;
      this.a = d / det; this.b = -b / det; this.c = -c / det; this.d = a / det;
      this.e = (c * f - d * e) / det; this.f = (b * e - a * f) / det;
      return this;
    }
    translate(x = 0, y = 0) { return this.multiplySelf(new DOMMatrix([1, 0, 0, 1, x, y])); }
    scale(x = 1, y = x) { return this.multiplySelf(new DOMMatrix([x, 0, 0, y, 0, 0])); }
  };
}
globalThis.ImageData ||= class ImageData {};
globalThis.Path2D ||= class Path2D { addPath() {} };
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 32 * 1024 * 1024) process.exit(2);
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const limit = Math.min(128 * 1024, Number(process.argv[3]) || 65536);
let text = ''; let complete = true; let reason = null;
try {
  if (process.argv[2] === '.docx') {
    const zip = await JSZip.loadAsync(bytes);
    // Do not decompress unbounded archives or follow external relationships.
    const entries = Object.values(zip.files);
    if (entries.length > 2000 || entries.reduce((n, f) => n + (f._data?.uncompressedSize || 0), 0) > 32 * 1024 * 1024) throw new Error('limit');
    const result = await mammoth.extractRawText({ buffer: bytes }, { externalFileAccess: false });
    text = result.value;
    if (result.messages.length || entries.some(e => /^word\/(media|embeddings)\//.test(e.name))) {
      complete = false; reason = 'DOCX_NON_TEXT_CONTENT';
    }
  } else {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, verbosity: 0 });
    const pdf = await loading.promise;
    const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
    if (pdf.numPages > 100) { complete = false; reason = 'PAGE_LIMIT'; }
    for (let i = 1; i <= Math.min(pdf.numPages, 100); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const value = content.items.map(item => item.str || '').join(' ');
      const operations = await page.getOperatorList();
      if (!value.trim() || operations.fnArray.some(op => imageOps.has(op))) { complete = false; reason ||= 'PDF_NON_TEXT_CONTENT'; }
      text += `\n[Page ${i}]\n${value}\n`;
      page.cleanup();
      if (Buffer.byteLength(text) > limit) { complete = false; reason = 'TEXT_LIMIT'; break; }
    }
    await pdf.destroy();
  }
  if (!text.trim()) { complete = false; reason = 'NO_EXTRACTABLE_TEXT'; }
  if (Buffer.byteLength(text) > limit) { complete = false; reason = 'TEXT_LIMIT'; }
  const content = Buffer.from(text).subarray(0, limit).toString('utf8');
  process.stdout.write(JSON.stringify({ content, complete, reason }));
} catch {
  process.stdout.write(JSON.stringify({ content: '', complete: false, reason: 'EXTRACTION_FAILED' }));
}
