import time
import uuid

import pytest

from app import JOBS, LOCK


@pytest.mark.parametrize('file_size, expected_status', [
    (4_899_999, 200),
    (4_900_000, 200),
    (4_900_001, 409),
    (5_000_000, 409),
])
def test_download_checks_actual_bytes_at_new_limit(api_client, tmp_path, file_size, expected_status):
    output = tmp_path / 'output.bin'
    with output.open('wb') as stream:
        stream.truncate(file_size)
    key = uuid.uuid4().hex
    with LOCK:
        JOBS[key] = {'status': 'done', 'updated': time.time(), 'result': {
            'path': str(output), 'name': 'output.bin',
            'size': 4_800_000,  # Stale metadata must not bypass the actual file check.
        }}
    try:
        response = api_client.get(f'/api/jobs/{key}/download')
        assert response.status_code == expected_status
        if expected_status == 200:
            assert len(response.content) == file_size
        else:
            assert '4.9 MB' in response.json()['detail']
    finally:
        with LOCK:
            JOBS.pop(key, None)
