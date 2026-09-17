import {renderAsync} from 'docx-preview';
import html2canvas from 'html2canvas';
import JSZip from 'jszip';

let busy = false;
window.addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== location.origin || busy || !(event.data?.blob instanceof Blob)) return;
  busy = true;
  const {id, blob} = event.data;
  try {
    const archive = await JSZip.loadAsync(blob);
    for (const [path, file] of Object.entries(archive.files)) {
      if (!path.endsWith('.rels')) continue;
      const xml = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
      for (const relationship of xml.getElementsByTagName('Relationship')) {
        if (relationship.getAttribute('Type')?.endsWith('/aFChunk')) throw new Error('This Word document contains embedded content that cannot be rendered here. Export it from Word instead.');
        if (relationship.getAttribute('TargetMode') === 'External' && !relationship.getAttribute('Type')?.endsWith('/hyperlink')) throw new Error('This Word document uses linked external content. Embed those pictures in Word before converting.');
      }
    }
    const container = document.querySelector('#pages');
    await renderAsync(blob, container, undefined, {inWrapper: false, ignoreLastRenderedPageBreak: false, ignoreFonts: true, renderAltChunks: false, renderComments: false, useBase64URL: true});
    await Promise.all([...container.querySelectorAll('img')].map(image => image.decode().catch(() => { throw new Error('A Word picture could not be rendered. Export this document from Word instead.'); })));
    const pages = [];
    for (const section of container.querySelectorAll('section.docx')) {
      const rect = section.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const paperHeight = Math.ceil(parseFloat(getComputedStyle(section).minHeight) || width * 1.414);
      const height = Math.ceil(Math.max(section.scrollHeight, rect.height));
      if (width > 1800 || height > 50000 || width < 50) throw new Error('This Word page is too large for browser conversion. Export it from Word instead.');
      const topMargin = Math.min(paperHeight / 4, parseFloat(getComputedStyle(section).paddingTop) || 0);
      const bottomMargin = Math.min(paperHeight / 4, parseFloat(getComputedStyle(section).paddingBottom) || 0);
      const contentHeight = height > paperHeight ? height - bottomMargin : height;
      // Move a cut above any text line or table row crossing it, where practical.
      const boxes = [...section.querySelectorAll('tr,img')].map(element => element.getBoundingClientRect());
      const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        boxes.push(...range.getClientRects());
      }
      for (let y = 0; y < contentHeight;) {
        if (pages.length >= 40) throw new Error('Word conversion supports up to 40 pages. Split this document first.');
        const inset = y ? topMargin : 0;
        const capacity = paperHeight - inset - (height > paperHeight ? bottomMargin : 0);
        let end = Math.min(contentHeight, y + capacity);
        for (const box of boxes) if (box.top - rect.top < end && box.bottom - rect.top > end && box.top - rect.top > y + capacity * .5) end = Math.floor(box.top - rect.top);
        const canvas = await html2canvas(section, {backgroundColor: '#ffffff', scale: 1.3, width, height: end - y, y, windowWidth: 1200, windowHeight: 1600, logging: false, useCORS: false, allowTaint: false});
        // Keep the document's paper size even when a cut moves above a text line.
        const sheet = document.createElement('canvas');
        sheet.width = canvas.width; sheet.height = Math.floor(paperHeight * 1.3);
        const context = sheet.getContext('2d');
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, sheet.width, sheet.height);
        context.drawImage(canvas, 0, Math.floor(inset * 1.3));
        const picture = await new Promise(resolve => sheet.toBlob(resolve, 'image/jpeg', .95));
        sheet.width = sheet.height = 1;
        canvas.width = canvas.height = 1;
        if (!picture) throw new Error('This device could not render the Word document.');
        pages.push(new File([picture], `page-${pages.length + 1}.jpg`, {type: 'image/jpeg'}));
        y = end;
      }
    }
    if (!pages.length) throw new Error('No Word pages could be rendered.');
    parent.postMessage({id, pages}, location.origin);
  } catch (error) { parent.postMessage({id, error: error.message || 'This Word document could not be converted.'}, location.origin); }
});
