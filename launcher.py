"""Serve the static browser app locally. No file uploads or compression API."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import urllib.request
import webbrowser

URL = 'http://127.0.0.1:8000'
ROOT = Path(__file__).resolve().parent / 'static'

if __name__ == '__main__':
    existing = False
    try:
        with urllib.request.urlopen(URL, timeout=1) as response:
            existing = b'PRCM File Compressor' in response.read(10000)
    except Exception:
        pass
    if existing:
        webbrowser.open(URL)
        print('Opened the existing PRCM File Compressor page.')
    else:
        server = ThreadingHTTPServer(('127.0.0.1', 8000), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
        threading.Timer(.5, lambda: webbrowser.open(URL)).start()
        print('PRCM File Compressor: ' + URL + '. Compression runs in your browser. Press Ctrl+C to close this preview.')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
