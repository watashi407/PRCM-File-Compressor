const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {zipSync, unzipSync, strToU8, zlibSync} = require('fflate');
const {PDFDocument, PDFName, PDFRawStream} = require('pdf-lib');
const {compress, detect, archiveInfo, unpack, pdfPixels, MAXIMUM} = require('../static/engine.js');
const noRaster = () => { throw new Error('Unexpected image conversion'); };

test('size boundary returns unchanged bytes and never pads files', async () => {
  for (const size of [1, 4_800_000, MAXIMUM]) {
    const original = new File([new Uint8Array(size)], 'sample.bin');
    const result = await compress(original, noRaster);
    assert.equal(result.blob, original);
    assert.equal(result.name, 'sample.bin');
  }
});
test('empty and oversized inputs are rejected before processing', async () => {
  await assert.rejects(compress(new File([], 'empty'), noRaster), /empty/);
  await assert.rejects(compress({size: 100_000_001}, noRaster), /100 MB/);
});
test('unknown formats get a ZIP with byte-identical contents', async () => {
  const input = strToU8('original content\n'.repeat(330000));
  const result = await compress(new File([input], 'notes.txt'), noRaster);
  assert.ok(result.blob.size <= MAXIMUM);
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.deepEqual(files['notes.txt'], input);
});
test('ZIP recompression preserves every filename and byte', async () => {
  const files = {'one.txt': new Uint8Array(5_100_000).fill(65), 'folder/two.txt': strToU8('second entry')};
  const input = zipSync(files, {level: 0});
  const result = await compress(new File([input], 'archive.zip'), noRaster);
  assert.ok(result.blob.size <= MAXIMUM);
  assert.deepEqual(unzipSync(new Uint8Array(await result.blob.arrayBuffer())), files);
});
test('random data cannot produce an oversized download', async () => {
  await assert.rejects(compress(new File([randomBytes(5_000_000)], 'random.bin'), noRaster), /cannot reach 4.9 MB/);
});
test('Word is detected by contents even with a misleading extension', async () => {
  const xml = strToU8('<document>' + 'Preserve this text. '.repeat(300000) + '</document>');
  const files = {'[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': xml};
  const result = await compress(new File([zipSync(files, {level: 0})], 'renamed.bin'), noRaster);
  assert.equal(result.format, 'Word'); assert.match(result.name, /\.docx$/);
  assert.deepEqual(unzipSync(new Uint8Array(await result.blob.arrayBuffer()))['word/document.xml'], xml);
});
test('CRC failures are caught instead of producing corrupt archives', () => {
  const bytes = zipSync({'a.txt': strToU8('hello')}, {level: 0});
  const info = archiveInfo(bytes);
  bytes[35] ^= 1;
  assert.throws(() => unpack(bytes, info), /integrity/);
});
test('archive expansion and encryption limits are enforced', () => {
  const bytes = zipSync({'a.txt': strToU8('hello')}, {level: 0});
  const view = new DataView(bytes.buffer);
  const directory = view.getUint32(bytes.length - 6, true);
  view.setUint32(directory + 24, 120_000_001, true);
  assert.throws(() => archiveInfo(bytes), /120 MB/);
  view.setUint32(directory + 24, 5, true);
  view.setUint16(directory + 8, 1, true);
  assert.throws(() => archiveInfo(bytes), /Encrypted/);
});
test('PDF retains text, page count, and links when optimized', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage(); page.drawText('KEEP THIS TEXT');
  const annotation = doc.context.obj({Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], A: {S: 'URI', URI: doc.context.obj('https://example.com')}});
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annotation)]));
  const base = await doc.save({useObjectStreams: false});
  const padded = new Uint8Array(5_000_000); padded.fill(32); padded.set(base);
  const result = await compress(new File([padded], 'document.dat'), noRaster);
  assert.equal(result.format, 'PDF'); assert.ok(result.blob.size <= MAXIMUM);
  const output = await PDFDocument.load(await result.blob.arrayBuffer());
  assert.equal(output.getPageCount(), 1);
  assert.equal(output.getPage(0).node.Annots().size(), 1);
  assert.deepEqual(output.getPage(0).node.Contents().toString(), page.node.Contents().toString());
});
test('signed PDFs are not rewritten', async () => {
  const doc = await PDFDocument.create(); doc.addPage();
  doc.context.register(doc.context.obj({Type: 'Sig', ByteRange: [0, 1, 2, 3]}));
  const base = await doc.save();
  const bytes = new Uint8Array(5_000_000); bytes.fill(32); bytes.set(base);
  await assert.rejects(compress(new File([bytes], 'signed.pdf'), noRaster), /digitally signed/);
});
test('PDF raw RGB and PNG predictor rows are decoded correctly', async () => {
  const doc = await PDFDocument.create();
  const contents = Uint8Array.from([255, 0, 0, 0, 255, 0]);
  const stream = PDFRawStream.of(doc.context.obj({}), zlibSync(contents));
  assert.deepEqual(pdfPixels(stream, 2, 1, 3), Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]));
  const predicted = PDFRawStream.of(doc.context.obj({}), zlibSync(Uint8Array.from([1, 255, 0, 0, 1, 255, 0])));
  const params = doc.context.obj({Predictor: 15, Columns: 2, Colors: 3, BitsPerComponent: 8});
  assert.deepEqual(pdfPixels(predicted, 2, 1, 3, params), Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]));
});
test('file signature takes precedence over the extension', () => {
  assert.equal(detect(Uint8Array.from([255, 216, 255, 0])).format, 'JPEG');
  assert.equal(detect(strToU8('%PDF-1.7')).format, 'PDF');
});


test('PDF ICC RGB pictures are optimized without dropping their color profile', async () => {
  const doc = await PDFDocument.create();
  const samples = randomBytes(1300 * 1300 * 3);
  const profile = doc.context.register(PDFRawStream.of(doc.context.obj({N: 3, Alternate: 'DeviceRGB'}), new Uint8Array([1, 2, 3])));
  const image = doc.context.register(PDFRawStream.of(doc.context.obj({Type: 'XObject', Subtype: 'Image', Width: 1300, Height: 1300, BitsPerComponent: 8, ColorSpace: ['ICCBased', profile], Filter: 'FlateDecode'}), zlibSync(samples)));
  doc.addPage().node.set(PDFName.of('Resources'), doc.context.obj({XObject: {Photo: image}}));
  const input = new File([await doc.save()], 'icc.pdf');
  assert.ok(input.size > MAXIMUM);
  let calls = 0;
  const result = await compress(input, async request => {
    calls++;
    assert.equal(request.pixels.length, 1300 * 1300 * 4);
    assert.deepEqual([...request.pixels.slice(0, 3)], [...samples.slice(0, 3)]);
    return {blob: new Blob([Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkaKKK8o/Sz//Z', 'base64')], {type: 'image/jpeg'}), width: 1, height: 1};
  });
  assert.equal(calls, 1);
  const output = await PDFDocument.load(await result.blob.arrayBuffer());
  const images = output.context.enumerateIndirectObjects().map(([, object]) => object).filter(object => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  assert.equal(images.length, 1);
  assert.match(images[0].dict.lookup(PDFName.of('ColorSpace')).toString(), /ICCBased/);
  assert.equal(images[0].dict.lookup(PDFName.of('Width')).asNumber(), 1);
});
