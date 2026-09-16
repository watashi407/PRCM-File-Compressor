const $ = selector => document.querySelector(selector);
const input = $('#file-input'), dropzone = $('#dropzone'), queue = $('#queue');
const entries = new Map();
const initialHeading = $('#upload-heading').innerHTML;
const MAXIMUM = 4_900_000, INPUT_LIMIT = 100_000_000, QUEUE_LIMIT = 200_000_000;
let active = null;
const icons = {
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v5h4M9 12h6m-6 4h4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>'
};
const size = bytes => bytes > 0 && bytes < 10_000 ? '<0.01 MB' : `${(bytes / 1_000_000).toFixed(2)} MB`;
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function summary() {
  const files = [...entries.values()];
  const busy = files.some(entry => ['waiting', 'processing'].includes(entry.state));
  const done = files.filter(entry => entry.state === 'done').length;
  const errors = files.some(entry => entry.state === 'error');
  const state = busy ? 'processing' : done ? 'success' : errors ? 'error' : 'idle';
  dropzone.dataset.state = state;
  $('.file-illustration').hidden = state !== 'idle';
  $('.upload-status-icon').hidden = state === 'idle';
  if (state === 'idle') $('#upload-heading').innerHTML = initialHeading;
  else $('#upload-heading').textContent = busy ? 'Making your file smaller…' : done ? (done === 1 ? 'Your file is ready!' : 'Your files are ready!') : 'Your file needs attention.';
  $('#upload-description').textContent = busy ? 'Processing on your device. Keep this page open.' : done ? (errors ? 'Download the completed files below. Some files need your attention.' : `Compression complete. Download your ${done === 1 ? 'file' : 'files'} below.`) : errors ? 'Check the message below, then choose another file or try again.' : 'Images, PDFs, Word, and ZIP. Automatically detected.';
  const label = files.length ? 'Choose another file' : 'Choose files';
  $('#browse-label').textContent = label; input.setAttribute('aria-label', label);
  $('#view-downloads').hidden = !done;
  $('.upload-limit').hidden = state !== 'idle';
  $('#queue-section').hidden = !files.length;
  $('#file-count').textContent = files.length;
  $('#clear').disabled = !files.some(entry => ['done', 'error'].includes(entry.state));
}
function paint(entry) {
  const {file, row, state, result} = entry;
  row.className = `file-row ${state}`; row.replaceChildren();
  const icon = element('div', 'file-icon'); icon.innerHTML = icons.file;
  const main = element('div', 'file-main');
  const name = element('p', 'file-name', file.name); name.title = file.name;
  const meta = element('div', 'file-meta');
  const original = element('span', 'size-indicator original-size', `Original: ${size(file.size)}`);
  original.title = `${file.size.toLocaleString()} bytes`; meta.append(original);
  if (result) {
    meta.append(element('span', 'size-indicator saving', `${result.blob.size < file.size ? 'Compressed' : 'Output'}: ${size(result.blob.size)}`));
    const saved = Math.min(99.9, Math.round((1 - result.blob.size / file.size) * 100));
    if (saved > 0) meta.append(element('span', 'saving', `${saved}% smaller`));
    meta.append(element('span', 'format-label', result.format));
  }
  main.append(name, meta);
  if (['processing', 'waiting'].includes(state)) {
    const track = element('div', 'progress-track');
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', `${file.name}: ${entry.message}`);
    track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', Math.round(entry.progress || 0));
    const fill = element('div', 'progress-fill'); fill.style.width = `${Math.max(2, entry.progress || 0)}%`;
    track.append(fill); main.append(track);
  }
  main.append(element('p', 'file-message', result ? result.note : entry.message));
  const actions = element('div', 'file-actions');
  if (state === 'done') {
    const link = element('a', 'button download');
    link.href = entry.url; link.download = result.name;
    link.innerHTML = `${icons.download}<span>Download</span>`;
    link.setAttribute('aria-label', `Download ${result.name}`); actions.append(link);
  } else if (state === 'error') {
    const retry = element('button', 'button retry', 'Try again');
    retry.addEventListener('click', () => {
      entry.state = 'waiting'; entry.message = 'Waiting to compress'; entry.progress = 0;
      paint(entry); pumpQueue();
    });
    actions.append(retry);
  } else actions.append(element('span', 'status-label', state === 'waiting' ? 'In queue' : `${Math.round(entry.progress || 0)}%`));
  const remove = element('button', 'remove'); remove.innerHTML = icons.close;
  remove.setAttribute('aria-label', `${['waiting', 'processing'].includes(state) ? 'Cancel' : 'Remove'} ${file.name}`);
  remove.addEventListener('click', () => removeEntry(entry)); actions.append(remove);
  row.append(icon, main, actions); summary();
}
function releaseWorker(entry) {
  clearTimeout(entry.timer); entry.worker?.terminate(); entry.worker = null;
  if (active === entry) active = null;
}
function removeEntry(entry) {
  releaseWorker(entry);
  if (entry.url) URL.revokeObjectURL(entry.url);
  entries.delete(entry.id); entry.row.remove(); summary(); pumpQueue();
}
function fail(entry, message) {
  releaseWorker(entry);
  if (!entries.has(entry.id)) return;
  entry.state = 'error'; entry.message = message;
  paint(entry); $('#announcer').textContent = `${entry.file.name}: ${message}`; pumpQueue();
}
function pumpQueue() {
  if (active) return;
  const entry = [...entries.values()].find(item => item.state === 'waiting');
  if (!entry) return;
  active = entry;
  entry.state = 'processing'; entry.message = 'Starting compression on your device'; paint(entry);
  if (!entry.file.size) return fail(entry, 'This file is empty. Choose a file with content.');
  if (entry.file.size > INPUT_LIMIT) return fail(entry, 'Choose a file of 100 MB or less.');
  let worker;
  try { worker = new Worker('/compression-worker.js'); }
  catch { return fail(entry, 'Your browser could not start compression. Try a current browser with JavaScript enabled.'); }
  entry.worker = worker;
  entry.timer = setTimeout(() => fail(entry, 'This file took too long on this device. Try a smaller file or use a computer.'), 180_000);
  worker.onerror = event => {
    event.preventDefault();
    fail(entry, 'Could not load the compression tools or this device ran out of memory. Reload the page and try a smaller file.');
  };
  worker.onmessage = async ({data}) => {
    if (entry.worker !== worker || !entries.has(entry.id)) return;
    if (data.type === 'progress') { entry.progress = data.progress; entry.message = data.message; paint(entry); }
    if (data.type === 'raster') {
      try {
        const result = await PRCMRaster(data.request, () => entry.worker !== worker);
        if (entry.worker === worker) worker.postMessage({type: 'raster-result', id: data.id, result});
      } catch (error) {
        if (entry.worker === worker) worker.postMessage({type: 'raster-result', id: data.id, error: error.message});
      }
    }
    if (data.type === 'error') fail(entry, data.message);
    if (data.type === 'done') {
      if (!(data.result?.blob instanceof Blob) || !data.result.blob.size || data.result.blob.size > MAXIMUM) return fail(entry, 'This file did not pass the 4.9 MB size check.');
      releaseWorker(entry);
      entry.result = data.result; entry.url = URL.createObjectURL(data.result.blob); entry.state = 'done';
      paint(entry); $('#announcer').textContent = `${entry.file.name} is ready to download.`; pumpQueue();
    }
  };
  worker.postMessage({type: 'compress', file: entry.file});
}
function addFiles(files) {
  $('#selection-notice').hidden = true;
  let bytes = [...entries.values()].reduce((total, entry) => total + entry.file.size, 0);
  for (const file of files) {
    if (entries.size >= 10 || bytes + file.size > QUEUE_LIMIT || file.size > INPUT_LIMIT) {
      $('#selection-notice').textContent = 'Choose up to 10 files, 100 MB per file and 200 MB total. Clear finished files to make room.';
      $('#selection-notice').hidden = false; continue;
    }
    bytes += file.size;
    const entry = {id: crypto.randomUUID(), file, row: element('article', 'file-row'), state: 'waiting', message: 'Waiting to compress', progress: 0};
    entries.set(entry.id, entry); queue.prepend(entry.row); paint(entry);
  }
  pumpQueue();
}
input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
let dragDepth = 0;
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
dropzone.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => { if (--dragDepth <= 0) dropzone.classList.remove('dragover'); });
dropzone.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; dropzone.classList.remove('dragover'); addFiles(event.dataTransfer.files); });
$('#clear').addEventListener('click', () => { for (const entry of entries.values()) if (['done', 'error'].includes(entry.state)) removeEntry(entry); });
window.addEventListener('beforeunload', event => {
  if (entries.size) { event.preventDefault(); event.returnValue = ''; }
});
try { sessionStorage.removeItem('prcm-compressor-jobs-v1'); } catch { /* Storage can be disabled. */ }
