$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.10 or newer, then run this launcher again.' }
}
& $pythonPath -c 'import importlib.util, sys; sys.exit(not all(importlib.util.find_spec(name) for name in ("fastapi", "uvicorn", "PIL", "pymupdf", "imageio_ffmpeg")))'
if ($LASTEXITCODE -ne 0) {
    & $pythonPath -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies. Check your connection and try again.' }
}
& $pythonPath launcher.py
