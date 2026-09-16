import io
import time
import zipfile

from fastapi.testclient import TestClient

from app import app, allowed_hosts


def test_cross_origin_upload_preflight_and_response():
    client = TestClient(app)
    origin = 'https://prcm-file-compressor.vercel.app'
    response = client.options('/api/compress', headers={
        'origin': origin, 'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-file-name',
    })
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == origin
    response = client.post('/api/compress', content=b'', headers={'origin': origin})
    assert response.status_code == 400  # Empty file rejected after CORS admission.
    assert response.headers['access-control-allow-origin'] == origin


def test_vercel_routes_browser_to_separate_server(monkeypatch):
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.setenv('COMPRESSION_API_URL', 'https://compressor.example.com/')
    client = TestClient(app)
    assert client.get('/api/config').json() == {
        'api_url': 'https://compressor.example.com', 'available': True, 'upload_limit': 250_000_000,
    }
    assert client.post('/api/compress', content=b'do not queue on vercel').status_code == 503
    monkeypatch.delenv('COMPRESSION_API_URL')
    assert client.get('/api/config').json()['available'] is False


def test_invalid_and_insecure_server_config_is_rejected(monkeypatch):
    client = TestClient(app)
    for url in ['http://public.example.com', 'https://user:password@example.com',
                'https://example.com/api', 'https://example.com?token=secret']:
        monkeypatch.setenv('COMPRESSION_API_URL', url)
        assert client.get('/api/config').status_code == 503


def test_server_host_configuration(monkeypatch):
    monkeypatch.setenv('PUBLIC_HOSTNAME', 'compressor.example.com')
    monkeypatch.setenv('RENDER_EXTERNAL_HOSTNAME', 'prcm-backend.onrender.com')
    assert {'compressor.example.com', 'prcm-backend.onrender.com'} <= set(allowed_hosts())


def test_large_upload_and_download_from_public_frontend(api_client):
    origin = 'https://prcm-file-compressor.vercel.app'
    contents = b'Mobile upload over the Vercel body limit.\n' * 150_000
    assert len(contents) > 5_000_000
    response = api_client.post('/api/compress', content=contents,
                               headers={'origin': origin, 'x-file-name': 'phone-notes.txt'})
    assert response.status_code == 202
    assert response.headers['access-control-allow-origin'] == origin
    key = response.json()['id']
    for _ in range(200):
        state = api_client.get(f'/api/jobs/{key}', headers={'origin': origin}).json()
        if state['status'] in ('done', 'error'):
            break
        time.sleep(.05)
    assert state['status'] == 'done', state
    download = api_client.get(f'/api/jobs/{key}/download', headers={'origin': origin})
    assert download.status_code == 200
    assert len(download.content) <= 4_900_000
    assert 'attachment;' in download.headers['content-disposition']
    assert download.headers['access-control-allow-origin'] == origin
    with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
        assert archive.read('phone-notes.txt') == contents
