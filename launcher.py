"""Open the app once its local server is ready."""
import json
import threading
import time
import urllib.request
import webbrowser

import uvicorn

URL = 'http://127.0.0.1:8000'


def running():
    try:
        with urllib.request.urlopen(URL + '/api/health', timeout=1) as response:
            data = json.load(response)
            return data.get('app') == 'smallside'
    except Exception:
        return False


def open_when_ready():
    for _ in range(60):
        if running():
            webbrowser.open(URL)
            return
        time.sleep(.25)


if __name__ == '__main__':
    if running():
        webbrowser.open(URL)
        print('Smallside is already running. Opened it in your browser.')
    else:
        threading.Thread(target=open_when_ready, daemon=True).start()
        uvicorn.run('app:app', host='127.0.0.1', port=8000)
