$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Install Node.js 20 or newer, then run this launcher again.' }
if (-not (Test-Path -LiteralPath 'node_modules/pdf-lib')) {
    npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the browser libraries. Check your connection and try again.' }
}
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Could not build the browser app.' }
python launcher.py
