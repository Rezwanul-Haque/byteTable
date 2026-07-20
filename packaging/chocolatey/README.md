# Chocolatey package

Publishes ByteTable to the [Chocolatey Community Repository](https://community.chocolatey.org/).
The package **downloads** the official signed NSIS installer from the matching
GitHub release and verifies its SHA-256 (from `SHASUMS256.txt`) — it never embeds
the binary.

## Files

- `bytetable.nuspec.template` — package manifest. `__VERSION__` is filled in.
- `tools/chocolateyinstall.ps1.template` — download + silent install (`/S`).
  `__VERSION__` and `__CHECKSUM__` are filled in.

The generated `bytetable.nuspec`, `tools/chocolateyinstall.ps1`, and
`*.nupkg` are produced at build time and are git-ignored.

## Automated release (CI)

The `chocolatey` job in `.github/workflows/release.yml` runs on every `v*` tag
(after the release + `SHASUMS256.txt` are published): it reads the version from
the tag, pulls the `x64-setup.exe` checksum from `SHASUMS256.txt`, fills the
templates, then `choco pack` + `choco push`.

**Required repo secret:** `CHOCO_API_KEY` (from your community.chocolatey.org
account → API key). Without it, the job self-skips.

## Manual build / test (Windows + Chocolatey)

```powershell
$version  = '0.0.21'
$checksum = (Select-String "ByteTable_${version}_x64-setup.exe" SHASUMS256.txt).Line.Split(' ')[0]

(Get-Content bytetable.nuspec.template) -replace '__VERSION__', $version |
  Set-Content bytetable.nuspec
(Get-Content tools/chocolateyinstall.ps1.template) -replace '__VERSION__', $version -replace '__CHECKSUM__', $checksum |
  Set-Content tools/chocolateyinstall.ps1

choco pack
choco install bytetable -s . -y     # test install
choco uninstall bytetable -y        # test removal
choco push "bytetable.$version.nupkg" -s https://push.chocolatey.org/ --api-key <KEY>
```

First-time submissions go through Chocolatey moderation (automated checks + human
review) before they're publicly installable.
