const $ = (selector) => document.querySelector(selector);
const input = $('#file-input');
const dropzone = $('#dropzone');
const queue = $('#queue');
const entries = new Map();
const idleUploadHeading = $('#upload-heading').innerHTML;
let uploadSummaryKey = '';
let apiBase = '';
let uploadLimit = 250_000_000;
let configError = '';
let connectionCheck = null;
let lastConnectionSuccess = 0;
let lastConnectionFailure = 0;
let retryInProgress = false;
const storageKey = 'prcm-compressor-jobs-v1';
let configuration = loadConfiguration();
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  const privacyLabel = document.querySelector('.panel-footer > span:first-child');
  privacyLabel.lastChild.textContent = 'Files processed on this server';
}
const icons = {
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v5h4M9 12h6m-6 4h4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>'
};
const size = (bytes) => bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
const sizeInMB = (bytes) => bytes > 0 && bytes < 10_000 ? '<0.01 MB' : `${(bytes / 1_000_000).toFixed(2)} MB`;
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
  updateUploadArea();
  saveSession();
}
function updateUploadArea() {
  const files = [...entries.values()];
  const uploading = files.filter(entry => ['waiting', 'uploading'].includes(entry.state)).length;
  const processing = files.filter(entry => ['queued', 'processing'].includes(entry.state)).length;
  const done = files.filter(entry => entry.state === 'done').length;
  const errors = files.filter(entry => entry.state === 'error').length;
  const key = [uploading, processing, done, errors].join(':');
  if (key === uploadSummaryKey) return;
  uploadSummaryKey = key;
  let state = 'idle';
  let heading = '';
  let description = 'Any file format. Automatically detected.';
  let label = 'Choose files';
  if (uploading || processing) {
    state = 'processing';
    heading = uploading ? (uploading === 1 ? 'Uploading your file…' : 'Uploading your files…') : 'Upload successful!';
    description = uploading ? 'Keep this page open while your files upload.' : "We're compressing your file. Your download will appear below.";
    if (!uploading && processing > 1) description = "We're compressing your files. Your downloads will appear below.";
    if (done) description = `${done === 1 ? 'One file is' : `${done} files are`} ready to download below. We're working on the rest.`;
    label = 'Upload another file';
  } else if (done) {
    state = 'success';
    heading = done === 1 ? 'Your file is ready!' : 'Your files are ready!';
    description = done === 1 ? 'Upload successful. Download your file below.' : 'Upload successful. Download your files below.';
    if (errors) {
      heading = `${done === 1 ? 'One file is' : `${done} files are`} ready to download.`;
      description = 'Download the completed files below. Some files need your attention.';
    }
    label = 'Upload another file';
  } else if (errors) {
    state = 'error';
    heading = 'Your file needs attention.';
    description = 'Check the message below, then try again or choose another file.';
    label = 'Upload another file';
  }
  dropzone.dataset.state = state;
  $('.file-illustration').hidden = state !== 'idle';
  $('.upload-status-icon').hidden = state === 'idle';
  if (state === 'idle') $('#upload-heading').innerHTML = idleUploadHeading;
  else $('#upload-heading').textContent = heading;
  $('#upload-description').textContent = description;
  $('#browse-label').textContent = label;
  input.setAttribute('aria-label', label);
  $('#view-downloads').hidden = !done;
  $('.upload-limit').hidden = state !== 'idle';
}
async function loadConfiguration() {
  configError = '';
  try {
    const {response, data: config} = await fetchJSON('/api/config', 15_000);
    if (!response.ok) throw new Error(config.detail || 'Could not connect to the compression service. Refresh to try again.');
    if (!config.available) throw new Error('The compression server is not connected yet. Please try again later.');
    apiBase = config.api_url || '';
    uploadLimit = config.upload_limit || uploadLimit;
  } catch (error) {
    configError = error instanceof TypeError || error.name === 'AbortError' || error instanceof SyntaxError
      ? 'Could not connect to the compression service. Check your connection, then retry.'
      : error.message || 'Could not connect to the compression service. Please retry.';
    showServiceNotice(configError);
  }
}
function showServiceNotice(message, connecting = false) {
  $('#service-message').textContent = message;
  $('#service-notice').hidden = false;
  $('#retry-connection').disabled = connecting;
  $('#retry-connection').textContent = connecting ? 'Connecting…' : 'Retry connection';
}
async function fetchJSON(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {signal: controller.signal, cache: 'no-store'});
    const data = await response.json();
    return {response, data};
  } finally {
    clearTimeout(timer);
  }
}
async function checkConnection(force = false) {
  if (connectionCheck) return connectionCheck;
  if (!force && Date.now() - lastConnectionSuccess < 15_000) return true;
  if (!force && Date.now() - lastConnectionFailure < 15_000) return false;
  // Probe the server before sending file bytes. A sleeping service can take time to start.
  connectionCheck = (async () => {
    const noticeTimer = setTimeout(() => showServiceNotice(
      'The server may be waking up. This can take about a minute. Keep this page open; your selected files will wait here.', true
    ), 1200);
    try {
      const {response, data} = await fetchJSON(api('/api/health'), 75_000);
      if (!response.ok || data.status !== 'ok' || data.app !== 'smallside') throw new Error('Server unavailable');
      lastConnectionSuccess = Date.now();
      lastConnectionFailure = 0;
      $('#service-notice').hidden = true;
      return true;
    } catch {
      lastConnectionSuccess = 0;
      lastConnectionFailure = Date.now();
      showServiceNotice('Could not reach the server. It may be asleep or temporarily unavailable. Check your connection, then retry. Your selected files are still here.');
      return false;
    } finally {
      clearTimeout(noticeTimer);
    }
  })();
  try { return await connectionCheck; }
  finally { connectionCheck = null; }
}
async function retryConnection() {
  if (retryInProgress) return;
  retryInProgress = true;
  showServiceNotice('Reconnecting to the server. It may need a moment to wake up.', true);
  try {
    if (configError) {
      configuration = loadConfiguration();
      await configuration;
      if (configError) return;
    }
    if (!await checkConnection(true)) return;
    for (const entry of entries.values()) {
      // Only resume uploads that never sent bytes. Failed transfers keep their own Try again button.
      if (entry.connectionRetry && !entry.jobId && entry.file instanceof File) {
        entry.connectionRetry = false;
        entry.state = 'waiting';
        entry.message = 'Waiting to upload';
        paint(entry);
      }
    }
    pumpQueue();
    resumeChecks();
  } finally {
    retryInProgress = false;
  }
}
function api(path) { return apiBase + path; }
function saveSession() {
  try {
    const jobs = [...entries.values()].filter(entry => entry.jobId && entry.state !== 'error').map(entry => ({
      id: entry.id, jobId: entry.jobId, name: entry.file.name, size: entry.file.size,
      apiBase, savedAt: Date.now()
    }));
    sessionStorage.setItem(storageKey, JSON.stringify(jobs));
  } catch { /* File processing does not depend on browser storage. */ }
}
async function restoreSession() {
  await configuration;
  if (configError) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
    for (const item of saved) {
      if (!/^[a-f0-9]{32}$/.test(item.jobId) || item.apiBase !== apiBase || Date.now() - item.savedAt > 3_600_000) continue;
      const entry = {id: item.id, jobId: item.jobId, file: {name: item.name, size: item.size},
        state: 'processing', progress: 0, message: 'Checking your file', row: element('article', 'file-row')};
      entries.set(entry.id, entry);
      queue.prepend(entry.row);
      paint(entry);
      poll(entry);
    }
  } catch { /* Invalid or disabled storage starts a fresh session. */ }
}
function pumpQueue() {
  let active = [...entries.values()].filter(entry => ['uploading', 'queued', 'processing'].includes(entry.state)).length;
  for (const entry of entries.values()) {
    if (active >= 2) break;
    if (entry.state !== 'waiting') continue;
    entry.state = 'uploading';
    entry.message = 'Preparing upload';
    paint(entry);
    active++;
    upload(entry);
  }
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
  const originalSize = element('span', 'size-indicator original-size', `Original: ${sizeInMB(file.size)}`);
  originalSize.title = `${file.size.toLocaleString()} bytes`;
  meta.append(originalSize);
  if (result) {
    const outputSize = element('span', 'size-indicator saving', `${result.size < file.size ? 'Compressed' : 'Output'}: ${sizeInMB(result.size)}`);
    outputSize.title = `${result.size.toLocaleString()} bytes`;
    meta.append(outputSize);
    const saved = Math.max(0, Math.min(99.9, Math.round((1 - result.size / file.size) * 100)));
    if (saved) meta.append(element('span', 'saving', `${saved}% smaller`));
  }
  if (detected) meta.append(element('span', 'format-label', detected.format));
  main.append(name, meta);
  if (['waiting', 'uploading', 'queued', 'processing'].includes(state)) {
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
    link.href = api(`/api/jobs/${entry.jobId}/download`);
    link.download = result.name;
    link.innerHTML = `${icons.download}<span>Download</span>`;
    link.setAttribute('aria-label', `Download ${result.name}`);
    actions.append(link);
  } else if (state !== 'error') {
    actions.append(element('span', 'status-label', state === 'uploading' ? 'Uploading' : ['waiting', 'queued'].includes(state) ? 'In queue' : `${Math.round(progress || 0)}%`));
  }
  if (state === 'error' && entry.file instanceof File) {
    const retry = element('button', 'button retry', 'Try again');
    retry.addEventListener('click', () => {
      if (entry.connectionRetry) { retryConnection(); return; }
      clearTimeout(entry.timer);
      entry.state = 'waiting';
      entry.message = 'Waiting to upload';
      entry.jobId = undefined;
      entry.progress = 0;
      paint(entry);
      pumpQueue();
    });
    actions.append(retry);
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
      const response = await fetch(api(`/api/jobs/${entry.jobId}`), {method: 'DELETE'});
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
function fail(entry, message, connectionRetry = false) {
  entry.state = 'error';
  entry.result = undefined;
  entry.message = message;
  entry.connectionRetry = connectionRetry;
  paint(entry);
  $('#announcer').textContent = `${entry.file.name}: ${message}`;
  pumpQueue();
}
async function poll(entry) {
  if (!entries.has(entry.id) || entry.polling) return;
  clearTimeout(entry.timer);
  entry.polling = true;
  try {
    const {response, data} = await fetchJSON(api(`/api/jobs/${entry.jobId}`), 20_000);
    if (!response.ok) {
      if (response.status === 404) return fail(entry, 'This file has expired. Choose it again.');
      throw new Error();
    }
    lastConnectionSuccess = Date.now();
    lastConnectionFailure = 0;
    if (!configError && !connectionCheck) $('#service-notice').hidden = true;
    Object.assign(entry, {state: data.status, progress: data.progress, message: data.message, detected: data.detected, result: data.result, failures: 0});
    paint(entry);
    if (data.status === 'done' || data.status === 'error') {
      $('#announcer').textContent = data.status === 'done' ? `${entry.file.name} is ready to download.` : `${entry.file.name}: ${data.message}`;
      if (data.status === 'done') entry.timer = setTimeout(() => poll(entry), 60_000);
      pumpQueue();
      return;
    }
  } catch {
    entry.failures = (entry.failures || 0) + 1;
    entry.message = 'Connection interrupted. Reconnecting…';
    showServiceNotice('The server is not responding. It may be waking up or your connection may have dropped. Retry to check your files.');
    paint(entry);
  } finally {
    entry.polling = false;
  }
  entry.timer = setTimeout(() => poll(entry), entry.failures ? 4000 : 800);
}
async function upload(entry) {
  await configuration;
  if (configError) return fail(entry, configError, true);
  if (entry.file.size === 0) return fail(entry, 'This file is empty. Choose a file with content.');
  if (entry.file.size > uploadLimit) return fail(entry, `Choose a file smaller than ${size(uploadLimit)}.`);
  entry.message = 'Connecting to the server. Your file is waiting here.';
  paint(entry);
  if (!await checkConnection()) return fail(entry, 'Server unavailable. Tap Retry connection above to continue with this file.', true);
  entry.connectionRetry = false;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', api('/api/compress'));
  xhr.timeout = 600_000;
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
    if (xhr.status >= 500) {
      lastConnectionSuccess = 0;
      showServiceNotice('The server could not finish the upload. It may be waking up. Retry the connection, then use Try again on your file.');
      return fail(entry, 'The server did not accept the upload. Your file is still selected; tap Try again.');
    }
    if (xhr.status === 413) return fail(entry, 'This upload exceeds the server limit. Try a smaller file.');
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
  xhr.onerror = () => {
    lastConnectionSuccess = 0;
    showServiceNotice('The connection was interrupted. The server may be waking up. Retry the connection, then use Try again on your file.');
    fail(entry, 'Could not upload. Your file is still selected. Check your connection and tap Try again.');
  };
  xhr.ontimeout = () => {
    lastConnectionSuccess = 0;
    showServiceNotice('The upload timed out. Check your connection, then retry. Your file is still selected.');
    fail(entry, 'The upload timed out. Check your connection and tap Try again.');
  };
  xhr.send(entry.file);
}
function addFiles(files) {
  for (const file of files) {
    const entry = {id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, state: 'waiting', progress: 0, message: 'Waiting to upload', row: element('article', 'file-row')};
    entries.set(entry.id, entry);
    queue.prepend(entry.row);
    paint(entry);
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
$('#clear').addEventListener('click', () => {
  for (const entry of entries.values()) if (['done', 'error'].includes(entry.state)) removeEntry(entry);
});
$('#retry-connection').addEventListener('click', retryConnection);
function resumeChecks() {
  if (document.hidden) return;
  for (const entry of entries.values()) if (entry.jobId && entry.state !== 'error') poll(entry);
}
document.addEventListener('visibilitychange', resumeChecks);
window.addEventListener('online', resumeChecks);
window.addEventListener('pageshow', resumeChecks);
window.addEventListener('beforeunload', event => {
  if ([...entries.values()].some(entry => ['waiting', 'uploading'].includes(entry.state))) {
    event.preventDefault();
    event.returnValue = '';
  }
});
restoreSession();
configuration.then(() => { if (!configError && apiBase) checkConnection(); });
