from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote, urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from compressor import CompressionError, MAXIMUM, compress

BASE = Path(__file__).parent
UPLOAD_LIMIT = 250_000_000
TTL = 3600
ROOT = Path(tempfile.mkdtemp(prefix='smallside-'))
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=2)


def cleanup():
    with LOCK:
        expired = [key for key, job in JOBS.items() if job['status'] in ('done', 'error') and time.time() - job['updated'] > TTL]
        for key in expired:
            shutil.rmtree(ROOT / key, ignore_errors=True)
            del JOBS[key]


@asynccontextmanager
async def lifespan(app):
    async def reap():
        while True:
            await asyncio.sleep(60)
            cleanup()
    task = asyncio.create_task(reap())
    yield
    task.cancel()
    POOL.shutdown(wait=True, cancel_futures=True)
    shutil.rmtree(ROOT, ignore_errors=True)


def allowed_hosts():
    hosts = {'localhost', '127.0.0.1', '[::1]', 'testserver',
             'prcm-file-compressor.vercel.app'}
    # Vercel supplies exact deployment, branch, and production hostnames.
    # Keep host validation enabled instead of trusting every vercel.app site.
    for key in ('VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL',
                'PUBLIC_HOSTNAME', 'RENDER_EXTERNAL_HOSTNAME', 'RAILWAY_PUBLIC_DOMAIN'):
        value = os.environ.get(key, '').strip()
        if value:
            hostname = urlparse(value if '://' in value else 'https://' + value).hostname
            if hostname:
                hosts.add(hostname)
    hosts.update(host.strip().lower() for host in os.environ.get('ALLOWED_HOSTS', '').split(',') if host.strip())
    return sorted(hosts)


app = FastAPI(title='PRCM File Compressor', lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts())
FRONTEND_ORIGINS = {'https://prcm-file-compressor.vercel.app'}
FRONTEND_ORIGINS.update(origin.strip().rstrip('/') for origin in os.environ.get('FRONTEND_ORIGINS', '').split(',') if origin.strip())
app.add_middleware(
    CORSMiddleware, allow_origins=sorted(FRONTEND_ORIGINS),
    allow_methods=['GET', 'POST', 'DELETE'],
    allow_headers=['Content-Type', 'X-File-Name'],
    expose_headers=['Content-Disposition'],
)


@app.middleware('http')
async def local_requests(request: Request, call_next):
    origin = request.headers.get('origin')
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin and urlparse(origin).netloc != request.headers.get('host') and origin not in FRONTEND_ORIGINS:
        from fastapi.responses import JSONResponse
        return JSONResponse({'detail': 'Upload files from the same address where you opened the app.'}, status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Cache-Control'] = 'no-store'
    return response


def run_job(key: str, source: Path, name: str):
    def update(progress, message, detected=None):
        with LOCK:
            JOBS[key].update(status='processing', progress=progress, message=message, updated=time.time())
            if detected:
                JOBS[key]['detected'] = detected
    try:
        result = compress(source, name, update)
        with LOCK:
            JOBS[key].update(status='done', result=result, progress=100, updated=time.time())
    except Exception as exc:
        if not isinstance(exc, CompressionError):
            logging.exception('Compression failed')
        with LOCK:
            JOBS[key].update(status='error', message=str(exc) if isinstance(exc, CompressionError) else 'This file could not be processed. It may be damaged or unsupported.', updated=time.time())
        shutil.rmtree(source.parent, ignore_errors=True)
    finally:
        source.unlink(missing_ok=True)


@app.get('/api/health')
def health():
    return {'app': 'smallside', 'status': 'ok', 'target': 4_800_000, 'maximum': MAXIMUM}


@app.get('/api/config')
def client_config():
    backend = os.environ.get('COMPRESSION_API_URL', '').strip().rstrip('/')
    if backend:
        parsed = urlparse(backend)
        if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise HTTPException(503, 'The compression server address is not configured correctly.')
        if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise HTTPException(503, 'The compression server needs an HTTPS address.')
    return {'api_url': backend, 'available': bool(backend) or os.environ.get('VERCEL') != '1',
            'upload_limit': UPLOAD_LIMIT}


@app.post('/api/compress', status_code=202)
async def upload(request: Request):
    if os.environ.get('VERCEL') == '1':
        raise HTTPException(503, 'The compression server is not connected yet. Please try again later.')
    name = unquote(request.headers.get('x-file-name', 'file')).replace('\\', '/').split('/')[-1]
    name = ''.join(c for c in name if c.isprintable() and c not in '<>:"|?*').strip('. ')[:180] or 'file'
    cleanup()
    key = uuid.uuid4().hex
    with LOCK:
        if sum(job['status'] in ('uploading', 'queued', 'processing') for job in JOBS.values()) >= 8:
            raise HTTPException(429, 'The queue is full. Wait for a file to finish and try again.')
        JOBS[key] = {'id': key, 'name': name, 'status': 'uploading', 'progress': 0, 'message': 'Uploading', 'updated': time.time()}
    directory = ROOT / key
    directory.mkdir()
    source = directory / 'source.input'
    size = 0
    try:
        with source.open('wb') as target:
            async for chunk in request.stream():
                size += len(chunk)
                if size > UPLOAD_LIMIT:
                    raise HTTPException(413, 'Choose a file smaller than 250 MB.')
                target.write(chunk)
        if not size:
            raise HTTPException(400, 'This file is empty. Choose a file with content.')
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        with LOCK:
            JOBS.pop(key, None)
        raise
    with LOCK:
        JOBS[key].update(status='queued', message='Waiting to compress', original_size=size)
    POOL.submit(run_job, key, source, name)
    return {'id': key}


@app.get('/api/jobs/{key}')
def status(key: str):
    with LOCK:
        job = JOBS.get(key)
        if not job:
            raise HTTPException(404, 'This file has expired. Upload it again.')
        public = {k: v for k, v in job.items() if k != 'result'}
        if 'result' in job:
            public['result'] = {k: v for k, v in job['result'].items() if k != 'path'}
        return public


@app.get('/api/jobs/{key}/download')
def download(key: str):
    with LOCK:
        job = JOBS.get(key)
        if not job or job['status'] != 'done':
            raise HTTPException(404, 'This file is not available. Upload it again.')
        result = job['result']
        path = Path(result['path'])
        if not path.exists() or path.stat().st_size > MAXIMUM:
            raise HTTPException(409, 'This file did not pass the 5 MB size check.')
        job['updated'] = time.time()
    return FileResponse(path, filename=result['name'], media_type='application/octet-stream')


@app.delete('/api/jobs/{key}')
def remove(key: str):
    with LOCK:
        job = JOBS.get(key)
        if not job:
            return {'deleted': True}
        if job['status'] not in ('done', 'error'):
            raise HTTPException(409, 'Wait for this file to finish before removing it.')
        del JOBS[key]
    shutil.rmtree(ROOT / key, ignore_errors=True)
    return {'deleted': True}


app.mount('/', StaticFiles(directory=BASE / 'static', html=True), name='web')
