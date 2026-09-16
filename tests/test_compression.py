import io
import os
import time
import zipfile
from pathlib import Path

import pymupdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app
from compressor import CompressionError, MAXIMUM, TARGET, compress, detect, ffmpeg


def noisy_image(path, alpha=False):
    mode = 'RGBA' if alpha else 'RGB'
    img = Image.frombytes(mode, (1600, 1600), os.urandom(1600 * 1600 * len(mode)))
    img.save(path, format='PNG')
    return path


def test_small_file_is_identical(tmp_path):
    source = tmp_path / 'source.input'
    original = b'Keep my file exactly as it is.\n' * 10
    source.write_bytes(original)
    result = compress(source, 'notes.txt')
    assert Path(result['path']).read_bytes() == original
    assert result['name'] == 'notes.txt'


@pytest.mark.parametrize('alpha', [False, True])
def test_image_content_detection_and_real_output(tmp_path, alpha):
    source = noisy_image(tmp_path / 'not-an-image.txt', alpha)
    assert source.stat().st_size > MAXIMUM
    assert detect(source)['format'] == 'PNG'
    result = compress(source, 'not-an-image.txt')
    assert 0 < result['size'] <= TARGET
    with Image.open(result['path']) as img:
        img.load()
        assert img.size == (1600, 1600)
        assert img.format == ('WEBP' if alpha else 'JPEG')
        if alpha:
            assert 'A' in img.mode


def test_pdf_keeps_text_and_pages(tmp_path):
    image_path = noisy_image(tmp_path / 'photo.png')
    source = tmp_path / 'source.input'
    with pymupdf.open() as doc:
        for _ in range(2):
            page = doc.new_page()
            page.insert_text((30, 30), 'Selectable text survives compression')
            page.insert_image(pymupdf.Rect(30, 60, 550, 800), filename=str(image_path))
        doc.save(source)
    assert source.stat().st_size > MAXIMUM
    result = compress(source, 'document.dat')
    assert result['size'] <= MAXIMUM
    with pymupdf.open(result['path']) as doc:
        assert doc.page_count == 2
        assert 'Selectable text survives compression' in doc[0].get_text()


def test_generic_zip_roundtrip(tmp_path):
    source = tmp_path / 'source.input'
    contents = b'This is a compressible document.\n' * 200_000
    source.write_bytes(contents)
    result = compress(source, 'export.csv')
    assert result['size'] <= TARGET
    with zipfile.ZipFile(result['path']) as archive:
        assert archive.read('export.csv') == contents


def test_iphone_heic_content_detection_and_compression(tmp_path):
    source = tmp_path / 'iphone-photo.input'
    img = Image.frombytes('RGB', (2000, 2000), os.urandom(2000 * 2000 * 3))
    img.save(source, format='HEIF', quality=-1)
    assert source.stat().st_size > MAXIMUM
    assert detect(source)['format'] == 'HEIF'
    result = compress(source, 'iphone-photo.heic')
    assert result['name'].endswith('.jpg')
    assert result['size'] <= TARGET
    with Image.open(result['path']) as output:
        output.load()
        assert output.size == (2000, 2000)


def test_incompressible_file_never_returns_oversized_result(tmp_path):
    source = tmp_path / 'source.input'
    source.write_bytes(os.urandom(4_950_000))
    with pytest.raises(CompressionError, match='cannot be compressed below 4.9 MB'):
        compress(source, 'random.bin')


@pytest.mark.parametrize('video', [False, True])
def test_media_detection_and_decodable_output(tmp_path, video):
    source = tmp_path / ('source.avi' if video else 'source.wav')
    if video:
        generated = ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', '-c:v', 'rawvideo', '-c:a', 'pcm_s16le', str(source)])
    else:
        generated = ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '32', '-ac', '2', '-c:a', 'pcm_s16le', str(source)])
    assert generated.returncode == 0, generated.stderr
    assert source.stat().st_size > MAXIMUM
    renamed = tmp_path / 'source.input'
    source.rename(renamed)
    assert detect(renamed)['kind'] == ('video' if video else 'audio')
    result = compress(renamed, 'mystery.bin')
    assert result['size'] <= TARGET
    decoded = ffmpeg(['-v', 'error', '-i', result['path'], '-f', 'null', '-'])
    assert decoded.returncode == 0, decoded.stderr
    assert abs(detect(Path(result['path']))['duration'] - (4 if video else 32)) < .2


def test_api_upload_download_errors_and_limits(monkeypatch, api_client):
    client = api_client
    assert client.get('/').status_code == 200
    assert client.get('/api/health').json()['maximum'] == 4_900_000
    assert client.post('/api/compress', content=b'').status_code == 400
    assert client.post('/api/compress', content=b'hello', headers={'origin': 'https://example.com'}).status_code == 403
    monkeypatch.setattr(app, 'UPLOAD_LIMIT', 20)
    assert client.post('/api/compress', content=b'x' * 21).status_code == 413
    monkeypatch.setattr(app, 'UPLOAD_LIMIT', 250_000_000)
    contents = b'hello from the upload test'
    response = client.post('/api/compress', content=contents, headers={'x-file-name': '..%2Fnotes.txt'})
    assert response.status_code == 202
    key = response.json()['id']
    for _ in range(200):
        status = client.get(f'/api/jobs/{key}').json()
        if status['status'] in ('done', 'error'):
            break
        time.sleep(.05)
    assert status['status'] == 'done', status
    assert 'path' not in status['result']
    response = client.get(f'/api/jobs/{key}/download')
    assert response.content == contents
    assert 'notes.txt' in response.headers['content-disposition']
    assert client.delete(f'/api/jobs/{key}').status_code == 200
    assert client.get(f'/api/jobs/{key}/download').status_code == 404
