# ByteTable installer for Windows — downloads the latest release's installer and
# runs it.
#
#   irm https://raw.githubusercontent.com/rezwanul-Haque/byteTable/main/install.ps1 | iex
#
# Prefers the NSIS .exe setup (installed silently); falls back to the .msi.
#Requires -Version 5
$ErrorActionPreference = 'Stop'
$repo = 'rezwanul-Haque/byteTable'

function Say($m) { Write-Host "▸ $m" -ForegroundColor Green }

Say 'Fetching the latest release...'
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" `
  -Headers @{ 'User-Agent' = 'bytetable-installer' }

# Prefer the NSIS setup .exe, then the WiX .msi.
$asset = $rel.assets | Where-Object { $_.name -match '\.exe$' } | Select-Object -First 1
if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -match '\.msi$' } | Select-Object -First 1 }
if (-not $asset) { throw 'No Windows installer (.exe / .msi) in the latest release (offline, or no published release yet).' }

$out = Join-Path $env:TEMP $asset.name
Say "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UseBasicParsing

# Verify against SHASUMS256.txt (sha256sum format: "<hash>  <name>"). Hashing is
# sub-second — no real effect on install time. Aborts on mismatch; skips if the
# release has no checksums file.
$sums = $rel.assets | Where-Object { $_.name -eq 'SHASUMS256.txt' } | Select-Object -First 1
if ($sums) {
  Say 'Verifying checksum...'
  $text = (Invoke-WebRequest -Uri $sums.browser_download_url -Headers @{ 'User-Agent' = 'bytetable-installer' } -UseBasicParsing).Content
  $line = $text -split "`n" | Where-Object { (($_ -split '\s+') | Select-Object -Index 1) -eq $asset.name } | Select-Object -First 1
  if (-not $line) { throw "No checksum listed for $($asset.name) in SHASUMS256.txt." }
  $expected = (($line -split '\s+')[0]).ToLower()
  $actual = (Get-FileHash -Path $out -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) {
    Remove-Item $out -Force
    throw "Checksum mismatch for $($asset.name) (expected $expected, got $actual). Aborted."
  }
  Write-Host '✓ Checksum verified.' -ForegroundColor Green
} else {
  Say 'No SHASUMS256.txt in the release — skipping checksum verification.'
}

Say 'Running the installer...'
if ($out -match '\.msi$') {
  Start-Process 'msiexec.exe' -ArgumentList "/i `"$out`" /qb" -Wait
} else {
  # Tauri's NSIS installer supports /S for a silent install.
  Start-Process -FilePath $out -ArgumentList '/S' -Wait
}

Write-Host '✓ ByteTable installed — launch it from the Start menu.' -ForegroundColor Green
