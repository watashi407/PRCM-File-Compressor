from fastapi.testclient import TestClient

from app import app, allowed_hosts


def test_production_domain_serves_the_app():
    client = TestClient(app, base_url='https://prcm-file-compressor.vercel.app')
    response = client.get('/')
    assert response.status_code == 200
    assert 'PRCM File Compressor home' in response.text
    assert client.get('/api/health').status_code == 200
    # Reaching the empty-upload validation proves the same-origin POST is accepted.
    assert client.post('/api/compress', content=b'', headers={
        'origin': 'https://prcm-file-compressor.vercel.app',
    }).status_code == 400


def test_unrelated_hosts_and_cross_origin_uploads_remain_blocked():
    client = TestClient(app, base_url='https://prcm-file-compressor.vercel.app')
    assert client.get('/', headers={'host': 'unrelated.vercel.app'}).status_code == 400
    assert client.get('/', headers={'host': 'prcm-file-compressor.vercel.app.attacker.example'}).status_code == 400
    assert client.post('/api/compress', content=b'hello', headers={
        'origin': 'https://unrelated.vercel.app',
    }).status_code == 403


def test_deployment_domains_are_loaded_from_environment(monkeypatch):
    monkeypatch.setenv('VERCEL_URL', 'prcm-deployment-123.vercel.app')
    monkeypatch.setenv('VERCEL_BRANCH_URL', 'prcm-git-master.vercel.app')
    monkeypatch.setenv('VERCEL_PROJECT_PRODUCTION_URL', 'https://compressor.example.com')
    monkeypatch.setenv('ALLOWED_HOSTS', ' files.example.com, archive.example.com ')
    hosts = allowed_hosts()
    assert {'prcm-deployment-123.vercel.app', 'prcm-git-master.vercel.app',
            'compressor.example.com', 'files.example.com', 'archive.example.com'} <= set(hosts)
    assert '*' not in hosts
    assert '*.vercel.app' not in hosts
