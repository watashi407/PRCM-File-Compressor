# Connect the Vercel site to a compression server

Uploads, job status, and downloads go directly from the browser to the compression server. Vercel serves the interface and `/api/config`. No uploaded file passes through a Vercel Function.

## Render

1. In Render, create a Web Service connected to `watashi407/PRCM-File-Compressor`, branch `master`.
2. Choose Docker as the runtime. The repository includes a Dockerfile with Python and FFmpeg. If you already selected Python, use `pip install -r requirements.txt` as the build command and `uvicorn app:app --host 0.0.0.0 --port $PORT --workers 1` as the start command. The Python install includes a bundled FFmpeg binary.
3. Choose a service size. 2 GB is a starting point for light image and video use, not a guarantee for every 250 MB input. A free instance is suitable for small tests only.
4. Set the health check path to `/api/health`. Use one instance. The Docker command already uses one worker.
5. Deploy. Render supplies the service hostname through `RENDER_EXTERNAL_HOSTNAME`, which the app accepts automatically.
6. Copy the service's HTTPS URL. Open `<service URL>/api/health` and confirm that it returns `status: ok`.
7. In the Vercel project's environment variables, set `COMPRESSION_API_URL` to that HTTPS URL, without a path. Apply it to Production and redeploy.
8. Open the Vercel site on your phone, select a file larger than 4.9 MB, wait for compression, and tap Download. The browser's download manager or Files app saves it.

The backend permits the production origin `https://prcm-file-compressor.vercel.app`. For additional frontend domains, set `FRONTEND_ORIGINS` on the backend to a comma-separated list of full HTTPS origins. Preview domains must be added explicitly if you want them to upload files.

## Existing server with Docker

Set `PUBLIC_HOSTNAME` to the backend hostname, then run `docker compose up -d --build`. The included Compose configuration binds the app to `127.0.0.1:8000`. Put an HTTPS reverse proxy in front of it.

The proxy must allow a 250,000,000-byte request body and enough upload time for slow phone connections. For Nginx, configure `client_max_body_size 250M;` and `client_body_timeout 600s;`. Forward the original Host header. Use a valid HTTPS certificate so phones and the Vercel frontend can connect.

Set `COMPRESSION_API_URL` on Vercel to the public backend origin and redeploy. Do not put server secrets or credentials in this value; it is sent to the browser.

## Runtime behavior

- Keep one process and one instance. Jobs and output files are not shared between instances.
- Restarting, redeploying, or sleeping the backend invalidates pending jobs and downloads. The app reports expired jobs. An always-on service is needed for regular use.
- The phone uploads files, then the server performs compression. Returning to the tab resumes status checks. Reloading the same tab restores accepted jobs using session storage, when the browser allows it. Uploads that have not finished must be selected again if the page closes.
- The app processes two jobs concurrently and queues the rest in the browser. It supports HEIC input for iPhone photos as well as the other documented formats.
- Device browsers choose where downloads are saved. The app uses a normal download link and an attachment response, without requiring the desktop-only File System Access API.
- This is a small single-server deployment. Before offering it at higher traffic, add per-user quotas and durable job/file storage, then load-test against the expected traffic.

## Verified locally

Automated checks cover host validation, allowed and blocked cross-origin requests, direct server configuration, and compression. Browser checks cover narrow layouts, file selection, download links, and restoring results. Physical iPhone and Android devices require a deployed backend and should be checked before a public launch.
