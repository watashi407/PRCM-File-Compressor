const $ = (selector) => document.querySelector(selector);
const input = $('#file-input');
const dropzone = $('#dropzone');
const queue = $('#queue');
const entries = new Map();
const icons = {
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v5h4M9 12h6m-6 4h4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>'
};
const size = (bytes) => bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function refreshCount() {
  $('#queue-section').hidden = !entries.size;
  $('#file-count').textContent = entries.size;
  $('#clear').disabled = ![...entries.values()].some(entry => ['done', 'error'].includes(entry.state));
}
function paint(entry) {
  const {row, file, state, progress, message, detected, result} = entry;
  row.className = `file-row ${state}`;
  row.replaceChildren();
  const icon = element('div', 'file-icon');
  icon.innerHTML = icons.file;
  const main = element('div', 'file-main');
  const name = element('p', 'file-name', file.name);
  name.title = file.name;
  const meta = element('div', 'file-meta');
  meta.append(element('span', '', size(file.size)));
  if (detected) meta.append(element('span', 'format-label', detected.format));
  if (result) {
    meta.append(element('span', '', '→'), element('span', 'saving', size(result.size)));
    const saved = Math.max(0, Math.min(99.9, Math.round((1 - result.size / file.size) * 100)));
    if (saved) meta.append(element('span', 'saving', `${saved}% smaller`));
  }
  main.append(name, meta);
  if (['uploading', 'queued', 'processing'].includes(state)) {
    const track = element('div', 'progress-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${file.name}: ${message}`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', Math.round(progress || 0));
    const fill = element('div', 'progress-fill');
    fill.style.width = `${Math.max(2, progress || 0)}%`;
    track.append(fill);
    main.append(track);
  }
  main.append(element('p', 'file-message', result ? result.note : message));
  const actions = element('div', 'file-actions');
  if (state === 'done') {
    const link = element('a', 'button download');
    link.href = `/api/jobs/${entry.jobId}/download`;
    link.download = result.name;
    link.innerHTML = `${icons.download}<span>Download</span>`;
    link.setAttribute('aria-label', `Download ${result.name}`);
    actions.append(link);
  } else if (state !== 'error') {
    actions.append(element('span', 'status-label', state === 'uploading' ? 'Uploading' : state === 'queued' ? 'In queue' : `${Math.round(progress || 0)}%`));
  }
  if (['done', 'error'].includes(state)) {
    const remove = element('button', 'remove');
    remove.innerHTML = icons.close;
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => removeEntry(entry));
    actions.append(remove);
  }
  row.append(icon, main, actions);
  refreshCount();
}
async function removeEntry(entry) {
  if (entry.jobId) {
    try {
      const response = await fetch(`/api/jobs/${entry.jobId}`, {method: 'DELETE'});
      if (!response.ok) throw new Error();
    } catch {
      $('#announcer').textContent = 'Could not remove the file. Try again.';
      return;
    }
  }
  clearTimeout(entry.timer);
  entry.row.remove();
  entries.delete(entry.id);
  refreshCount();
}
function fail(entry, message) {
  entry.state = 'error';
  entry.message = message;
  paint(entry);
  $('#announcer').textContent = `${entry.file.name}: ${message}`;
}
async function poll(entry) {
  try {
    const response = await fetch(`/api/jobs/${entry.jobId}`);
    if (!response.ok) {
      if (response.status === 404) return fail(entry, 'This file has expired. Choose it again.');
      throw new Error();
    }
    const data = await response.json();
    Object.assign(entry, {state: data.status, progress: data.progress, message: data.message, detected: data.detected, result: data.result, failures: 0});
    paint(entry);
    if (data.status === 'done' || data.status === 'error') {
      $('#announcer').textContent = data.status === 'done' ? `${entry.file.name} is ready to download.` : `${entry.file.name}: ${data.message}`;
      if (data.status === 'done') entry.timer = setTimeout(() => poll(entry), 60_000);
      return;
    }
  } catch {
    entry.failures = (entry.failures || 0) + 1;
    entry.message = 'Connection interrupted. Reconnecting…';
    paint(entry);
  }
  entry.timer = setTimeout(() => poll(entry), entry.failures ? 4000 : 800);
}
function upload(entry) {
  if (entry.file.size === 0) return fail(entry, 'This file is empty. Choose a file with content.');
  if (entry.file.size > 250_000_000) return fail(entry, 'Choose a file smaller than 250 MB.');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/compress');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(entry.file.name));
  xhr.upload.onprogress = event => {
    if (event.lengthComputable) {
      entry.progress = event.loaded / event.total * 100;
      entry.message = `Uploading ${size(event.loaded)} of ${size(event.total)}`;
      paint(entry);
    }
  };
  xhr.onload = () => {
    let data;
    try { data = JSON.parse(xhr.responseText); } catch { return fail(entry, 'The app could not read the response. Try again.'); }
    if (xhr.status !== 202) return fail(entry, data.detail || 'Upload failed. Try again.');
    entry.jobId = data.id;
    entry.state = 'queued';
    entry.message = 'Detecting file format';
    entry.progress = 0;
    paint(entry);
    poll(entry);
  };
  xhr.onerror = () => fail(entry, 'Could not reach the app. Make sure Smallside is running and try again.');
  xhr.send(entry.file);
}
function addFiles(files) {
  for (const file of files) {
    const entry = {id: crypto.randomUUID(), file, state: 'uploading', progress: 0, message: 'Preparing upload', row: element('article', 'file-row')};
    entries.set(entry.id, entry);
    queue.prepend(entry.row);
    paint(entry);
    upload(entry);
  }
}
$('#browse').addEventListener('click', () => input.click());
input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
let dragDepth = 0;
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
dropzone.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => { if (--dragDepth <= 0) dropzone.classList.remove('dragover'); });
dropzone.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; dropzone.classList.remove('dragover'); addFiles(event.dataTransfer.files); });
$('#clear').addEventListener('click', () => {
  for (const entry of entries.values()) if (['done', 'error'].includes(entry.state)) removeEntry(entry);
});
