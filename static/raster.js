/* Canvas work stays on the UI thread for Safari support; archive/PDF work uses a worker. */
window.PRCMRaster = async function raster(request, isCancelled = () => false) {
  if (request.type === 'word') return PRCMWord(request.blob, isCancelled);
  let source, release = () => {};
  const check = () => { if (isCancelled()) throw new Error('Cancelled'); };
  let canvas;
  try {
    check();
    if (request.pixels) {
      source = document.createElement('canvas');
      source.width = request.width; source.height = request.height;
      source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(request.pixels), request.width, request.height), 0, 0);
      release = () => { source.width = source.height = 1; };
    } else {
      let blob = request.blob;
      if (request.format === 'HEIC') {
        const {heicTo} = await import('/vendor/heic-to.js');
        check();
        blob = await heicTo({blob, type: 'image/jpeg', quality: .95});
      }
      const url = URL.createObjectURL(blob);
      source = new Image();
      release = () => { source.src = ''; URL.revokeObjectURL(url); };
      await new Promise((resolve, reject) => {
        source.onload = resolve;
        source.onerror = () => reject(new Error('This browser cannot decode this picture. Try exporting it as JPEG or PNG.'));
        source.src = url;
      });
    }
    check();
    const originalWidth = source.naturalWidth || source.width, originalHeight = source.naturalHeight || source.height;
    if (!originalWidth || !originalHeight) throw new Error('This picture could not be decoded.');
    const scale = Math.min(1, (request.dimension || 4096) / Math.max(originalWidth, originalHeight), Math.sqrt(12_000_000 / (originalWidth * originalHeight)));
    let width = Math.max(1, Math.round(originalWidth * scale)), height = Math.max(1, Math.round(originalHeight * scale));
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Picture compression is not supported in this browser.');
    const draw = () => {
      canvas.width = width; canvas.height = height;
      if (request.mime === 'image/jpeg' || request.outputType === 'image/jpeg') { context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); }
      context.drawImage(source, 0, 0, width, height);
    };
    const encode = (type, quality) => new Promise((resolve, reject) => {
      check();
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Your device could not encode this picture. Try a smaller image.')), type, quality);
    });
    draw();
    const type = request.outputType || (request.preserveType ? request.mime : request.mime === 'image/jpeg' || request.format === 'HEIC' ? 'image/jpeg' : 'image/webp');
    if (!request.target) {
      const blob = await encode(type, request.quality ?? .8);
      check();
      return {blob, width, height};
    }
    for (let round = 0; round < 8; round++) {
      draw();
      let blob = await encode(type, .92);
      if (blob.size <= request.target) return {blob, width, height};
      let low = .3, high = .92, best;
      for (let i = 0; i < 5; i++) {
        const quality = (low + high) / 2;
        blob = await encode(type, quality);
        check();
        if (blob.size <= request.target) { best = blob; low = quality; }
        else high = quality;
      }
      if (best) return {blob: best, width, height};
      width = Math.max(1, Math.floor(width * .78)); height = Math.max(1, Math.floor(height * .78));
    }
    throw new Error('This picture cannot reach 4.9 MB on this device. Try a smaller image.');
  } finally {
    release();
    if (canvas) canvas.width = canvas.height = 1;
  }
};
