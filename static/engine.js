/* The same compression routines run in a browser worker and in the regression tests. */
(function (root) {
  const zip = typeof module === 'object' ? require('fflate') : root.fflate;
  const pdf = typeof module === 'object' ? require('pdf-lib') : root.PDFLib;
  const TARGET = 4_800_000, MAXIMUM = 4_900_000, INPUT_LIMIT = 100_000_000;
  const EXPANDED_LIMIT = 120_000_000, PIXEL_LIMIT = 24_000_000;
  const text = (bytes) => new TextDecoder().decode(bytes);
  const starts = (b, signature) => signature.every((v, i) => b[i] === v);
  const tooLarge = () => new Error('This file cannot reach 4.9 MB with the available compression. Try reducing its pictures or splitting the document.');
  function nameFor(name, extension) {
    return (name.replace(/\.[^.]+$/, '') || 'file') + '-compressed.' + extension;
  }
  function imageDimensions(bytes, format) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (format === 'PNG' && bytes.length >= 24) return [view.getUint32(16), view.getUint32(20)];
    if (format === 'WebP' && bytes.length >= 30 && text(bytes.subarray(12, 16)) === 'VP8X') return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    if (format === 'JPEG') {
      let offset = 2;
      while (offset + 9 < bytes.length && bytes[offset] === 255) {
        const marker = bytes[offset + 1];
        if (marker === 255) { offset++; continue; }
        if (marker === 0xda || marker === 0xd9) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
        const length = view.getUint16(offset + 2);
        if (length < 2) break;
        offset += length + 2;
      }
    }
    return null;
  }
  function detect(bytes) {
    const head = text(bytes.subarray(0, 1024));
    if (head.includes('%PDF-')) return {kind: 'pdf', format: 'PDF', mime: 'application/pdf'};
    if (starts(bytes, [255, 216, 255])) return {kind: 'image', format: 'JPEG', mime: 'image/jpeg'};
    if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
      // Preserve animated PNGs instead of silently dropping their other frames.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 8;
      while (offset + 12 <= bytes.length) {
        const type = text(bytes.subarray(offset + 4, offset + 8));
        if (type === 'acTL') return {kind: 'other', format: 'Animated PNG'};
        if (type === 'IDAT') break;
        offset += 12 + view.getUint32(offset);
      }
      return {kind: 'image', format: 'PNG', mime: 'image/png'};
    }
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
      if (head.slice(12, 16) === 'VP8X' && (bytes[20] & 2)) return {kind: 'other', format: 'Animated WebP'};
      return {kind: 'image', format: 'WebP', mime: 'image/webp'};
    }
    if (head.startsWith('GIF8')) return {kind: 'other', format: 'GIF'};
    if (head.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1/.test(head.slice(8, 48))) return {kind: 'image', format: 'HEIC', mime: 'image/heic'};
    if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8, 48))) return {kind: 'other', format: 'AVIF'};
    if (starts(bytes, [80, 75, 3, 4]) || starts(bytes, [80, 75, 5, 6])) return {kind: 'zip', format: 'ZIP', mime: 'application/zip'};
    if (starts(bytes, [208, 207, 17, 224, 161, 177, 26, 225])) return {kind: 'other', format: 'Legacy Office'};
    return {kind: 'other', format: 'File'};
  }
  function crc32(data) {
    let c = -1;
    for (const byte of data) {
      c ^= byte;
      for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ -1) >>> 0;
  }
  function archiveInfo(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    const min = Math.max(0, end - 65535);
    for (; end >= min; end--) {
      if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
    }
    if (end < min) throw new Error('This ZIP file is damaged or incomplete.');
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true), expanded = 0;
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 65535 || offset === 0xffffffff) throw new Error('Split and ZIP64 archives cannot be recompressed in this app.');
    if (count > 2000) throw new Error('This archive contains too many entries for browser compression.');
    const items = [];
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('This ZIP file has an invalid directory.');
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
      const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
      const length = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
      if (offset + 46 + length + extra + comment > end) throw new Error('This ZIP file is incomplete.');
      const rawName = bytes.subarray(offset + 46, offset + 46 + length);
      if (!(flags & 2048) && rawName.some(byte => byte > 127)) throw new Error('This ZIP uses an older filename encoding. Re-save it as a UTF-8 ZIP first.');
      const name = text(rawName);
      if (seen.has(name)) throw new Error('This ZIP contains duplicate filenames and cannot be safely recompressed.');
      seen.add(name);
      if ((flags & 1) || ![0, 8].includes(method)) throw new Error('Encrypted ZIPs and this archive compression method are not supported.');
      expanded += size;
      if (expanded > EXPANDED_LIMIT || size === 0xffffffff || compressed === 0xffffffff) throw new Error('This archive expands beyond the 120 MB browser limit.');
      items.push({name, size, crc: view.getUint32(offset + 16, true)});
      offset += 46 + length + extra + comment;
    }
    return {items, word: seen.has('word/document.xml') && seen.has('[Content_Types].xml'), signed: [...seen].some(name => name.toLowerCase().startsWith('_xmlsignatures/'))};
  }
  function unpack(bytes, info) {
    const files = zip.unzipSync(bytes);
    for (const item of info.items) {
      if (!files[item.name] || files[item.name].length !== item.size || crc32(files[item.name]) !== item.crc) throw new Error('This archive failed its integrity check. Please choose the original file again.');
    }
    return files;
  }
  // Inflate only into an explicitly bounded output buffer, then undo PNG predictors.
  function pdfPixels(stream, width, height, channels, params) {
    const {PDFName} = pdf;
    const predictor = params?.lookup(PDFName.of('Predictor'))?.asNumber?.() || 1;
    if (predictor !== 1 && (predictor < 10 || predictor > 15)) return null;
    if (params) {
      const colors = params.lookup(PDFName.of('Colors'))?.asNumber?.() || 1;
      const columns = params.lookup(PDFName.of('Columns'))?.asNumber?.() || 1;
      const bits = params.lookup(PDFName.of('BitsPerComponent'))?.asNumber?.() || 8;
      if (predictor !== 1 && (colors !== channels || columns !== width || bits !== 8)) return null;
    }
    const stride = width * channels;
    const expected = (stride + (predictor === 1 ? 0 : 1)) * height;
    const raw = new Uint8Array(expected);
    let offset = 0;
    const inflater = new zip.Unzlib((chunk) => {
      if (offset + chunk.length > expected) throw new Error('Invalid PDF image dimensions.');
      raw.set(chunk, offset); offset += chunk.length;
    });
    for (let i = 0; i < stream.contents.length; i += 1024) inflater.push(stream.contents.subarray(i, i + 1024), i + 1024 >= stream.contents.length);
    if (offset !== expected) return null;
    const pixels = new Uint8Array(width * height * 4);
    let prior = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + (predictor === 1 ? 0 : 1));
      const filter = predictor === 1 ? 0 : raw[rowStart];
      if (filter > 4) return null;
      const row = raw.subarray(rowStart + (predictor === 1 ? 0 : 1), rowStart + (predictor === 1 ? 0 : 1) + stride);
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? row[x - channels] : 0, above = prior[x], corner = x >= channels ? prior[x - channels] : 0;
        if (filter === 1) row[x] += left;
        if (filter === 2) row[x] += above;
        if (filter === 3) row[x] += Math.floor((left + above) / 2);
        if (filter === 4) {
          const p = left + above - corner, a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - corner);
          row[x] += a <= b && a <= c ? left : b <= c ? above : corner;
        }
      }
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4, s = x * channels;
        pixels[p] = row[s]; pixels[p + 1] = row[s + (channels === 3 ? 1 : 0)]; pixels[p + 2] = row[s + (channels === 3 ? 2 : 0)]; pixels[p + 3] = 255;
      }
      prior = row;
    }
    return pixels;
  }
  async function compressPDF(bytes, raster, progress) {
    const {PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray} = pdf;
    let doc;
    try { doc = await PDFDocument.load(bytes, {updateMetadata: false}); }
    catch { throw new Error('This PDF is encrypted or could not be read. Use an unlocked, valid PDF.'); }
    const name = PDFName.of;
    const images = [];
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFRawStream ? object.dict : object;
      if (dict instanceof PDFDict && (dict.get(name('ByteRange')) || dict.get(name('Type')) === name('Sig') || (dict.get(name('FT')) === name('Sig') && dict.get(name('V'))))) throw new Error('This PDF is digitally signed. Compression could invalidate its signature. Use an unsigned copy.');
      if (!(object instanceof PDFRawStream) || dict.get(name('Subtype')) !== name('Image')) continue;
      const width = dict.lookup(name('Width'))?.asNumber?.(), height = dict.lookup(name('Height'))?.asNumber?.();
      const colorSpace = dict.lookup(name('ColorSpace'));
      const color = colorSpace?.toString();
      const filter = dict.lookup(name('Filter'))?.toString();
      // Raw ICC RGB samples can be encoded without color conversion. Keep the
      // original PDF profile on the replacement image so its meaning is retained.
      const iccRGB = filter === '/FlateDecode' && colorSpace instanceof PDFArray && colorSpace.lookup(0) === name('ICCBased') && colorSpace.lookup(1) instanceof PDFRawStream && colorSpace.lookup(1).dict.lookup(name('N'))?.asNumber?.() === 3;
      if (!width || !height || width * height > PIXEL_LIMIT || object.contents.length < 80_000) continue;
      if ((!['/DeviceRGB', '/DeviceGray'].includes(color) && !iccRGB) || dict.get(name('SMask')) || dict.get(name('Mask')) || dict.get(name('ImageMask')) || dict.get(name('Decode'))) continue;
      if (dict.lookup(name('BitsPerComponent'))?.asNumber?.() !== 8 || !['/DCTDecode', '/FlateDecode'].includes(filter)) continue;
      images.push({ref, object, width, height, color, filter, iccRGB});
    }
    let best = await doc.save({useObjectStreams: true});
    if (best.length <= TARGET) return {bytes: best, note: 'PDF optimized. Text and page layout retained.'};
    let changed = false;
    const passes = [{quality: .82, dimension: 2400}, {quality: .62, dimension: 1800}, {quality: .42, dimension: 1300}, {quality: .28, dimension: 1000}];
    for (let pass = 0; pass < passes.length && images.length; pass++) {
      for (let i = 0; i < images.length; i++) {
        progress(15 + (pass * images.length + i) / (passes.length * images.length) * 75, 'Optimizing PDF pictures; keeping text and pages');
        const image = images[i];
        try {
          const request = {mime: 'image/jpeg', ...passes[pass], preserveType: false};
          if (image.filter === '/DCTDecode') request.blob = new Blob([image.object.contents], {type: 'image/jpeg'});
          else {
            request.pixels = pdfPixels(image.object, image.width, image.height, image.color === '/DeviceRGB' || image.iccRGB ? 3 : 1, image.object.dict.lookup(name('DecodeParms')));
            if (!request.pixels) continue;
            request.width = image.width; request.height = image.height;
          }
          const output = await raster(request);
          if (output.blob.size >= image.object.contents.length) continue;
          const contents = new Uint8Array(await output.blob.arrayBuffer());
          const dict = image.object.dict.clone(doc.context);
          dict.set(name('Width'), doc.context.obj(output.width));
          dict.set(name('Height'), doc.context.obj(output.height));
          if (!image.iccRGB) dict.set(name('ColorSpace'), name('DeviceRGB'));
          dict.set(name('Filter'), name('DCTDecode'));
          dict.delete(name('DecodeParms'));
          dict.set(name('Length'), doc.context.obj(contents.length));
          doc.context.assign(image.ref, PDFRawStream.of(dict, contents));
          changed = true;
        } catch { /* Preserve an image when its encoding cannot be safely optimized. */ }
      }
      const candidate = await doc.save({useObjectStreams: true});
      if (candidate.length < best.length) best = candidate;
      if (best.length <= TARGET) break;
    }
    if (best.length > MAXIMUM) throw tooLarge();
    return {bytes: best, note: changed ? 'PDF pictures compressed. Text, links, and pages retained; picture quality may be lower.' : 'PDF optimized. Text and page layout retained.'};
  }
  async function compress(file, raster, progress = () => {}) {
    if (!file.size) throw new Error('This file is empty. Choose a file with content.');
    if (file.size > INPUT_LIMIT) throw new Error('Choose a file of 100 MB or less. Large files can exceed your device memory.');
    progress(3, 'Detecting file format on your device');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let detected = detect(bytes), info;
    if (detected.kind === 'zip') {
      // Small files need no archive expansion or modification.
      try { info = archiveInfo(bytes); if (info.word) detected = {...detected, format: 'Word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}; }
      catch (error) { if (file.size > MAXIMUM) throw error; }
    }
    if (file.size <= MAXIMUM) return {blob: file, name: file.name, format: detected.format, note: 'Already within 4.9 MB. Your file is unchanged.'};
    let blob, outputName, note;
    if (detected.kind === 'image') {
      const dimensions = imageDimensions(bytes, detected.format);
      if (dimensions && dimensions[0] * dimensions[1] > 40_000_000) throw new Error('This picture exceeds the 40 megapixel browser limit. Resize it before choosing it.');
      progress(15, 'Compressing your picture on this device');
      const result = await raster({blob: new Blob([bytes], {type: detected.mime}), mime: detected.mime, target: TARGET, format: detected.format});
      blob = result.blob;
      outputName = nameFor(file.name, blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg');
      note = 'Picture compressed on your device. Quality or dimensions may be reduced; metadata may be removed.';
    } else if (detected.kind === 'pdf') {
      const result = await compressPDF(bytes, raster, progress);
      blob = new Blob([result.bytes], {type: 'application/pdf'}); outputName = nameFor(file.name, 'pdf'); note = result.note;
    } else if (detected.kind === 'zip') {
      if (info.signed && info.word) throw new Error('This Word document is digitally signed. Use an unsigned copy to preserve the signature.');
      progress(10, 'Checking archive contents');
      const files = unpack(bytes, info);
      progress(20, 'Recompressing without removing files');
      let best = zip.zipSync(files, {level: 9});
      let changed = false;
      if (info.word && best.length > TARGET) {
        const originals = Object.entries(files).filter(([name, data]) => /^word\/media\//.test(name) && data.length > 80_000 && ['JPEG', 'PNG'].includes(detect(data).format));
        const passes = [{quality: .8, dimension: 2200}, {quality: .6, dimension: 1600}, {quality: .4, dimension: 1100}];
        for (let pass = 0; pass < passes.length; pass++) {
          for (let i = 0; i < originals.length; i++) {
            const [name, original] = originals[i];
            const image = detect(original);
            progress(25 + (pass * originals.length + i) / (passes.length * Math.max(1, originals.length)) * 65, 'Optimizing Word pictures; keeping document text');
            try {
              const result = await raster({blob: new Blob([original], {type: image.mime}), mime: image.mime, preserveType: true, ...passes[pass]});
              if (result.blob.type === image.mime && result.blob.size < files[name].length) {
                files[name] = new Uint8Array(await result.blob.arrayBuffer()); changed = true;
              }
            } catch { /* Keep unsupported images unchanged. */ }
          }
          const candidate = zip.zipSync(files, {level: 9});
          if (candidate.length < best.length) best = candidate;
          if (best.length <= TARGET) break;
        }
      }
      blob = new Blob([best], {type: detected.mime});
      // Keep macro-enabled document names and content types intact.
      const macro = info.word && Object.keys(files).some(name => name.toLowerCase() === 'word/vbaproject.bin');
      outputName = nameFor(file.name, info.word ? (macro ? 'docm' : 'docx') : 'zip');
      note = info.word ? (changed ? 'Word pictures compressed. Text and document structure retained; picture quality may be lower.' : 'Word document repacked. Contents retained.') : 'ZIP recompressed. All file contents retained.';
    } else {
      progress(25, 'Packing a lossless ZIP on your device');
      const files = Object.create(null);
      files[file.name.replace(/[\\/]/g, '_') || 'file'] = bytes;
      blob = new Blob([zip.zipSync(files, {level: 9})], {type: 'application/zip'});
      outputName = nameFor(file.name, 'zip');
      note = 'Packed into ZIP without changing the original file. Extract the ZIP to use it.';
    }
    if (!blob.size || blob.size > MAXIMUM) throw tooLarge();
    progress(100, 'Ready to download');
    return {blob, name: outputName, note, format: detected.format};
  }
  async function imagesToPDF(files, raster, progress = () => {}, outputName) {
    if (!files.length || files.length > 40) throw new Error('Choose between 1 and 40 pictures or document pages.');
    const budget = Math.floor((TARGET - 60_000) / files.length);
    const doc = await pdf.PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.size || file.size > INPUT_LIMIT) throw new Error('Each picture must contain data and be 100 MB or less.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = detect(bytes);
      if (kind.kind !== 'image') throw new Error(`${file.name || 'This file'} is not a supported still picture. Choose JPEG, PNG, WebP, or HEIC.`);
      const dimensions = imageDimensions(bytes, kind.format);
      if (dimensions && dimensions[0] * dimensions[1] > 40_000_000) throw new Error('This picture exceeds the 40 megapixel browser limit.');
      progress(10 + i / files.length * 85, `Creating PDF page ${i + 1} of ${files.length}`);
      const rendered = await raster({blob: new Blob([bytes], {type: kind.mime}), mime: kind.mime, format: kind.format, outputType: 'image/jpeg', target: budget});
      const image = await doc.embedJpg(await rendered.blob.arrayBuffer());
      const scale = Math.min(1, 842 / Math.max(image.width, image.height));
      const page = doc.addPage([image.width * scale, image.height * scale]);
      page.drawImage(image, {x: 0, y: 0, width: page.getWidth(), height: page.getHeight()});
    }
    const blob = new Blob([await doc.save()], {type: 'application/pdf'});
    if (blob.size > MAXIMUM) throw tooLarge();
    return {blob, name: outputName || (files.length === 1 ? nameFor(files[0].name, 'pdf').replace('-compressed.pdf', '.pdf') : 'combined-pictures.pdf'), format: 'PDF', note: `${files.length} ${files.length === 1 ? 'picture' : 'pictures'} converted to PDF in selection order. Picture quality may be reduced.`};
  }
  async function convertToPDF(files, raster, progress = () => {}) {
    if (!files.length) throw new Error('Choose a picture or Word document.');
    if (files.length > 1) return imagesToPDF(files, raster, progress);
    const file = files[0];
    if (!file.size || file.size > INPUT_LIMIT) throw new Error('Choose a nonempty file of 100 MB or less.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detect(bytes);
    if (kind.kind === 'pdf') return compress(file, raster, progress);
    if (kind.kind === 'image') return imagesToPDF(files, raster, progress);
    if (kind.kind === 'zip') {
      const info = archiveInfo(bytes);
      if (!info.word) throw new Error('Choose pictures or a Word .docx document. A ZIP archive cannot be converted to PDF.');
      if (info.signed) throw new Error('This document is digitally signed. Export it to PDF in Word to retain signature information.');
      const parts = unpack(bytes, info);
      if (Object.keys(parts).some(name => name.toLowerCase() === 'word/vbaproject.bin')) throw new Error('Save this macro-enabled document as .docx before converting.');
      progress(5, 'Preparing Word pages on your device');
      const rendered = await raster({type: 'word', blob: file});
      const result = await imagesToPDF(rendered.pages, raster, progress, nameFor(file.name, 'pdf').replace('-compressed.pdf', '.pdf'));
      result.note = 'Visual PDF copy of your Word document. Text is not selectable; fonts and page layout may differ. Review before sharing.';
      return result;
    }
    throw new Error('PDF conversion supports still pictures and Word .docx documents. Save older .doc files as .docx first.');
  }
  const engine = {compress, convertToPDF, imagesToPDF, detect, archiveInfo, unpack, crc32, pdfPixels, imageDimensions, TARGET, MAXIMUM, INPUT_LIMIT};
  if (typeof module === 'object') module.exports = engine;
  else root.PRCMEngine = engine;
})(typeof self === 'object' ? self : globalThis);
