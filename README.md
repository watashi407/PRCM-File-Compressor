# PRCM-File-Compressor

PRCM Compressor is a minimalist file compression app.

A local file compressor with automatic format detection, a 4.8 MB target, and a strict 5 MB download limit. Drop multiple files, then download completed results while the rest process.

## Run on Windows

Double-click **Start Smallside.bat**. Python 3.10 or newer is required. On the first run, the launcher installs dependencies in `.venv`. Keep the launcher open while using the app. Close it to stop the app.

Alternatively, run:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. Files are processed locally. No cloud account or API key is needed. The app binds to localhost and is intended for personal desktop use.

## Compression behavior

- Format is detected from the uploaded contents, rather than trusting the filename.
- Files at or below 4,800,000 bytes are returned unchanged.
- Still images become JPEG or WebP. Compression searches image quality before reducing dimensions. Transparency is retained in WebP.
- PDFs first receive lossless optimization, then embedded image compression. Text, page structure, and links are retained. Signed PDFs requiring compression are rejected to avoid invalidating their signatures.
- Video becomes H.264 MP4 using two-pass encoding and a duration-based bitrate budget. The first video and audio tracks are kept. Audio becomes MP3.
- Other formats and animated or multi-page images are ZIP-compressed without changing the original contents.
- Some files cannot shrink to 5 MB. Those produce an explanation instead of an oversized download. Outputs are never padded to reach 4.8 MB.
- Each upload can be up to 250 MB. Two files process at once, with up to eight active or queued uploads. Results expire after one hour and can be removed immediately using Clear finished.
- Image/media conversion may remove metadata and reduce quality. PDF compression does not flatten pages into pictures. This app does not promise identical appearance after lossy compression.

The backend uses FastAPI, Pillow, PyMuPDF, and the FFmpeg binary provided by imageio-ffmpeg. Review their licenses before distributing the app, especially PyMuPDF's AGPL/commercial license and the bundled FFmpeg build.

## Hosting

The app accepts `prcm-file-compressor.vercel.app`, local addresses, and the exact hosts from Vercel's `VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL` environment variables. Add custom domains with a comma-separated `ALLOWED_HOSTS` environment variable, using hostnames without paths.

Fixing the allowed hosts lets the interface load on Vercel. The current compression backend still requires a persistent server. Its job queue and temporary files are local to one running process. Vercel Functions can route later requests to other instances, and their [4.5 MB request/response limit](https://vercel.com/docs/functions/limitations) is smaller than the app's upload allowance and maximum output size.

For public uploads, deploy the backend on a persistent server or redesign it around direct object-storage uploads, durable job storage, and a worker. The current 250 MB upload flow is not supported by a standalone Vercel Function. On a public server, files are processed on that server rather than the visitor's computer.

## Verify

```powershell
.\.venv\Scripts\python.exe -m pip install pytest httpx
.\.venv\Scripts\python.exe -m pytest -q
```

Compression details are implemented using the [PyMuPDF document API](https://pymupdf.readthedocs.io/en/latest/document.html) and [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg).
