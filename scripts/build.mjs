import { cp, mkdir, copyFile } from 'node:fs/promises';

await mkdir('static/vendor', { recursive: true });
for (const [source, destination] of [
  ['fflate/umd/index.js', 'fflate.js'],
  ['fflate/LICENSE', 'fflate-LICENSE.txt'],
  ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.js'],
  ['pdf-lib/LICENSE.md', 'pdf-lib-LICENSE.txt'],
  ['heic-to/dist/csp/heic-to.js', 'heic-to.js'],
  ['heic-to/LICENSE', 'heic-to-LICENSE.txt'],
]) await copyFile(`node_modules/${source}`, `static/vendor/${destination}`);
await mkdir('dist', { recursive: true });
await cp('static', 'dist', { recursive: true });
console.log('Built static site in dist/ and prepared local browser libraries.');
