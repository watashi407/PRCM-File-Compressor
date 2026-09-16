# Deploy the browser app

Compression now runs entirely on the visitor's device. Vercel only serves HTML, CSS, JavaScript, and bundled libraries. Render is not used by this version.

## Vercel

1. Use the existing GitHub repository and `master` production branch.
2. Keep the root directory at the repository root.
3. Deploy the latest commit. The committed `vercel.json` overrides the old Python preset with these settings:
   - Framework: Other
   - Install: `npm ci --ignore-scripts`
   - Build: `npm run build`
   - Output: `dist`
4. Open the deployed site and choose an image, PDF, Word document, or ZIP.
5. Check the original/output sizes, then tap Download. On a phone, use its Downloads or Files app to find the saved file.

The old `COMPRESSION_API_URL`, `FRONTEND_ORIGINS`, and `ALLOWED_HOSTS` variables are unused by this static deployment and can be removed. No backend address or secrets are required.

The existing Render compression service can be suspended or removed after verifying this deployment. This repository update does not change your Render account or stop any paid service.

## Other static hosts

Run `npm ci --ignore-scripts` and `npm run build`, then publish the contents of `dist/` at the domain root. Use HTTPS. Serve JavaScript with the JavaScript MIME type and allow same-origin web workers and blob image/download URLs. Do not publish the whole repository or node_modules.

## Local preview

```sh
npm ci --ignore-scripts
npm run build
python -m http.server 8000 --bind 127.0.0.1 --directory dist
```

If port 8000 is already serving the old app, the updated frontend is also available there after `npm run build`, because that app serves `static/`. To preview a separate static-only server, use port 8002 instead.

## Limits

The input limit is 100 MB per file, with one active compression at a time. Large inputs can still exceed a phone's memory. Results exist only in the current tab and disappear on refresh or close. Files are not uploaded. Some documents and ZIPs cannot fit within 4.9 MB without changing their contents and will show a message instead of a download.
