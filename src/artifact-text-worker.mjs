// Receives only an immutable blob on stdin; no project paths or inherited credentials.
import mammoth from 'mammoth';
import JSZip from 'jszip';

console.log = console.warn = console.error = () => {};
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
