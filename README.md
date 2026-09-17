# PRCM File Compressor

A minimalist browser-based file compressor. Files stay on the user's device. No uploads, compression API, Render service, or account is needed.

The app targets 4,800,000 bytes and only offers downloads of 4,900,000 bytes or less. Files already within the maximum are returned unchanged. Files that cannot reach the limit show an explanation, not an oversized download.

## Supported files

- **Pictures:** JPEG, PNG, WebP, and HEIC. Quality is reduced before further resizing. PNG/WebP transparency is retained when the browser can encode WebP, otherwise PNG. Conversion can remove metadata. Animated formats are ZIP-packed instead of losing their frames.
- **PDF:** Object and stream packing, plus recompression of supported embedded RGB/grayscale JPEG and Flate images. Text, page structure, and links are retained. Images with masks or unsupported color spaces remain untouched. PDFs are never flattened into screenshots. Encrypted or signed PDFs that require changes are rejected.
- **Word:** DOCX/DOCM archives are detected from their contents. Embedded JPEG/PNG pictures can be optimized without changing document XML or image relationships. Macro contents are retained. Signed documents requiring changes are rejected. Legacy DOC files use lossless ZIP packing.
- **ZIP:** Recompresses entries and checks their CRCs without altering file contents. Already compressed archives may not shrink. Encrypted, split, ZIP64, duplicate-name, and unsupported filename-encoding archives cannot be recompressed.
- **Other files:** Tries lossless ZIP packing. There is no video/audio transcoding.

No compression method can guarantee an arbitrary file will fit under 4.9 MB while preserving its contents. Large or complex PDFs, photo-heavy documents, and incompressible ZIPs may need manual changes.

## Convert to PDF

Choose **Convert to PDF** before selecting files. JPEG, PNG, WebP, and HEIC pictures become PDF pages, including pictures already below the size limit. Enable **Combine selected pictures into one PDF** to create one PDF in selection order; otherwise each file gets its own download. Transparent areas become white and picture quality may be reduced to meet the 4.9 MB limit.

Word `.docx` files produce a visual PDF copy entirely in the browser. Text is not selectable, and fonts, pagination, fields, charts, or complex layouts may differ from Word. Review the output before sharing; use Word's own PDF export when exact layout or accessibility is required. Older `.doc` files must first be saved as `.docx`. Signed documents, macros, linked external pictures, and embedded HTML content are rejected. Up to 40 rendered pages are supported. Existing PDFs use the normal PDF compression path.

Word rendering runs in a temporary, separate same-origin frame with external requests and document scripts blocked. That frame is removed on completion or cancellation. This works within the authorized Zoho People embedding policy.

## Phone and desktop behavior

Native file selection, drag and drop, original/output MB indicators, cancellation, retry, and individual downloads. One file processes at a time in a worker, with image encoding through browser canvas. The app accepts up to 10 files, 100 MB per file, 200 MB selected in total, and 120 MB of expanded archive contents. JPEG/PNG/extended WebP headers are checked against a 40 megapixel input limit before decoding. Device memory can impose lower practical limits.

Save downloads before closing or refreshing the tab. Files and output blobs live only in tab memory. No files or download links are saved to a server or browser storage. An internet connection is needed to load the site and its compression libraries; offline startup is not provided.

## Run locally

Node.js 20+ and Python 3.10+ are needed for the Windows launcher. Double-click **Start Smallside.bat**, or run:

```sh
npm ci --ignore-scripts
npm run build
python -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:8000. Python only serves static assets. All compression runs in the browser.

## Hosting

Connect the repository to Vercel. `vercel.json` selects the Other framework preset, runs `npm ci --ignore-scripts` and `npm run build`, and publishes only `dist/`. No Python functions or compression backend are deployed. See [DEPLOYMENT.md](DEPLOYMENT.md).

The earlier Python compression implementation remains in the repository for reference and its existing tests, but the browser app does not call it. Existing Render resources are not automatically stopped by this update.

## Verify

```sh
npm test
npm run build
```

The browser engine tests cover byte limits, format detection, archive integrity, Word contents, PDF preservation, and signed-document handling. Test real image conversion and downloads in a browser too.

## Libraries

Pinned dependencies are installed from npm and served from the same website. There are no third-party CDN requests. See [the library notices](static/licenses.html) for licenses and source links. `fflate` and `pdf-lib` use the MIT license; `heic-to` and its libheif components have LGPL and included third-party terms. Their license notices ship with the app. The old Python backend has separate dependencies described in `requirements.txt`.
