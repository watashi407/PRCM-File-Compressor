importScripts('/vendor/fflate.js', '/vendor/pdf-lib.js', '/engine.js');
const requests = new Map();
let sequence = 0;
self.onmessage = async ({data}) => {
  if (data.type === 'raster-result') {
    const request = requests.get(data.id);
    if (!request) return;
    requests.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
    return;
  }
  if (data.type !== 'compress') return;
  try {
    const operation = data.mode === 'pdf' ? PRCMEngine.convertToPDF : PRCMEngine.compress;
    const result = await operation(data.mode === 'pdf' ? data.files : data.file, (request) => new Promise((resolve, reject) => {
      const id = ++sequence;
      requests.set(id, {resolve, reject});
      self.postMessage({type: 'raster', id, request});
    }), (progress, message) => self.postMessage({type: 'progress', progress, message}));
    self.postMessage({type: 'done', result});
  } catch (error) {
    self.postMessage({type: 'error', message: error.message || 'This file could not be compressed on this device.'});
  }
};
