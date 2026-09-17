import { cp, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

await mkdir('static/vendor', { recursive: true });
await build({entryPoints: ['scripts/word-renderer.js'], outfile: 'static/vendor/word-renderer.js', bundle: true, minify: true, platform: 'browser', legalComments: 'linked'});
for (const [source, destination] of [
  ['fflate/umd/index.js', 'fflate.js'],
  ['fflate/LICENSE', 'fflate-LICENSE.txt'],
  ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.js'],
  ['pdf-lib/LICENSE.md', 'pdf-lib-LICENSE.txt'],
  ['heic-to/dist/csp/heic-to.js', 'heic-to.js'],
  ['heic-to/LICENSE', 'heic-to-LICENSE.txt'],
  ['docx-preview/LICENSE', 'docx-preview-LICENSE.txt'],
  ['html2canvas/LICENSE', 'html2canvas-LICENSE.txt'],
  ['jszip/LICENSE.markdown', 'jszip-LICENSE.txt'],
]) await copyFile(`node_modules/${source}`, `static/vendor/${destination}`);
await mkdir('dist', { recursive: true });
await cp('static', 'dist', { recursive: true });
// A header-only deployment can keep the HTML ETag unchanged. A subsequent 304
// may retain the browser's old CSP. Change HTML bytes when the policy changes.
const policyVersion = createHash('sha256').update(await readFile('vercel.json')).digest('hex').slice(0, 16);
for (const page of ['index.html', 'licenses.html']) {
  const html = await readFile(`dist/${page}`, 'utf8');
  await writeFile(`dist/${page}`, html.replace('</head>', `<meta name="prcm-policy-version" content="${policyVersion}">\n</head>`));
}
console.log('Built static site in dist/ and prepared local browser libraries.');
