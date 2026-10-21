# Visual QA of the Tauri launcher on the owner's PC, without touching the real launcher setup.
#
#   powershell -ExecutionPolicy Bypass -File owner-qa.ps1 fake    # local fake feed: channels, install, options, Play
#   powershell -ExecutionPolicy Bypass -File owner-qa.ps1 real    # the real Live feed, migrating your Electron settings (read-only)
#
# Both modes keep the launcher's own settings in .\qa-data-* next to this script (--data-dir), so a
# later real install starts clean. "fake" installs only into .\qa-fake-game*; "real" reads
# %APPDATA%\mapleroot-launcher\settings.json but never writes it and moves no game folder.
param([ValidateSet('fake', 'real')][string]$Mode = 'fake')
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'SlumsMS Launcher.exe'
$repo = 'Z:\MSv83\SlumsMS-dev\launcher-tauri'
if ($Mode -eq 'real') {
  & $exe "--data-dir=$(Join-Path $here 'qa-data-real')"
  return
}
$feed = Join-Path $here 'qa-feed'
if (-not (Test-Path (Join-Path $feed 'manifest.json'))) {
  node (Join-Path $repo 'tauri\devtools\fake-feed.mjs') build $feed --files 300 --exe-from C:\Windows\System32\rundll32.exe
}
$server = Start-Process -FilePath node -ArgumentList @((Join-Path $repo 'tauri\devtools\fake-feed.mjs'), 'serve', $feed, '--port', '8787') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1
Write-Host 'Fake feed running. In Settings > Access key use: player-local (Live only) or dev-local (Live/Test/RC).'
try {
  & $exe "--data-dir=$(Join-Path $here 'qa-data-fake')" '--feed-url=http://127.0.0.1:8787/manifest.json' "--install-dir=$(Join-Path $here 'qa-fake-game')" | Out-Null
  Wait-Process -Name 'SlumsMS Launcher' -ErrorAction SilentlyContinue
} finally { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
