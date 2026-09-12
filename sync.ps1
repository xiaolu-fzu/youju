# Copy the built web assets from the working project into this repo.
# Usage:  powershell -ExecutionPolicy Bypass -File .\sync.ps1
$ErrorActionPreference = 'Stop'
$SRC = 'E:\dev\project\project7\RAG\nianbao\web'
$DST = $PSScriptRoot

Write-Host 'Syncing web assets...' -ForegroundColor Cyan
foreach ($f in @('index.html','chat.html','engine.js')) {
    Copy-Item (Join-Path $SRC $f) (Join-Path $DST $f) -Force
    Write-Host ('  OK  ' + $f)
}
$srcData = Join-Path $SRC 'data'
$dstData = Join-Path $DST 'data'
New-Item -ItemType Directory -Force -Path $dstData | Out-Null
foreach ($f in (Get-ChildItem $srcData -File)) {
    Copy-Item $f.FullName (Join-Path $dstData $f.Name) -Force
    Write-Host ('  OK  data\' + $f.Name)
}

$size = (Get-ChildItem $DST -Recurse -File | Where-Object { $_.FullName -notmatch '\\.git\\' } | Measure-Object Length -Sum).Sum
Write-Host ''
Write-Host ('repo total: ' + [math]::Round($size / 1MB, 2) + ' MB') -ForegroundColor Green
