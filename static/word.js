window.PRCMWord = (blob, isCancelled) => new Promise((resolve, reject) => {
  const frame = document.createElement('iframe');
  frame.className = 'word-render-frame'; frame.title = 'Preparing Word PDF';
  frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
  const id = crypto.randomUUID();
  const finish = (error, pages) => {
    clearInterval(timer); window.removeEventListener('message', receive); frame.remove();
    if (error) reject(new Error(error)); else resolve({pages});
  };
  const receive = event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.id !== id) return;
    finish(event.data.error, event.data.pages);
  };
  window.addEventListener('message', receive);
  const timer = setInterval(() => { if (isCancelled()) finish('Cancelled'); }, 250);
  frame.onload = () => frame.contentWindow.postMessage({id, blob}, location.origin);
  frame.src = '/word-renderer.html'; document.body.append(frame);
});
