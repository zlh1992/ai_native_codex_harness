import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { artifactText } from '../src/artifact-text.mjs';

function pdfFixture(text) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(source)); source += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source);
}

test('artifact text has explicit coverage for UTF8, truncation, unsupported and empty files', async () => {
  assert.deepEqual(await artifactText({ path: 'note.md', bytes: Buffer.from('evidence') }), { content: 'evidence', complete: true, reason: null });
  assert.equal((await artifactText({ path: 'note.md', bytes: Buffer.from('evidence') }, 3)).reason, 'TEXT_LIMIT');
  assert.equal((await artifactText({ path: 'image.png', bytes: Buffer.from('not a real image') })).complete, false);
  assert.equal((await artifactText({ path: 'blank.txt', bytes: Buffer.alloc(0) })).complete, false);
});

test('sandboxed PDF text layer and DOCX body extraction use fixed bytes and fail closed on corruption', async () => {
  const pdf = await artifactText({ path: 'report.pdf', bytes: pdfFixture('Immutable PDF evidence') });
  assert.equal(pdf.complete, true, JSON.stringify(pdf));
  assert.match(pdf.content, /Immutable PDF evidence/);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Immutable DOCX evidence</w:t></w:r></w:p></w:body></w:document>');
  const document = await artifactText({ path: 'report.docx', bytes: await zip.generateAsync({ type: 'nodebuffer' }) });
  assert.equal(document.complete, true, JSON.stringify(document));
  assert.match(document.content, /Immutable DOCX evidence/);
  zip.file('word/media/image.png', 'not evaluated');
  const partial = await artifactText({ path: 'report.docx', bytes: await zip.generateAsync({ type: 'nodebuffer' }) });
  assert.equal(partial.complete, false);
  assert.equal(partial.reason, 'DOCX_NON_TEXT_CONTENT');
  for (const ext of ['pdf', 'docx']) {
    const broken = await artifactText({ path: `broken.${ext}`, bytes: Buffer.from('broken') });
    assert.equal(broken.complete, false); assert.equal(broken.content, '');
  }
});
