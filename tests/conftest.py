import pytest
from fastapi.testclient import TestClient

from app import app


@pytest.fixture(scope='session', autouse=True)
def api_client():
    # Keep one server lifecycle open until every integration check has finished.
    with TestClient(app) as client:
        yield client
