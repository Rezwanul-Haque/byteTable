#!/bin/sh
# ByteTable installer — downloads the right asset from the latest GitHub release
# for your OS/arch and installs it.
#
#   curl -fsSL https://raw.githubusercontent.com/rezwanul-Haque/byteTable/main/install.sh | sh
#
# macOS  → mounts the .dmg and copies ByteTable.app to /Applications.
# Linux  → drops the .AppImage into ~/.local/bin/bytetable (chmod +x; no sudo).
# Windows is not supported here — use the .exe / PowerShell line in the README.
set -eu

REPO="rezwanul-Haque/byteTable"
API="https://api.github.com/repos/${REPO}/releases/latest"

say() { printf '\033[1;32m▸\033[0m %s\n' "$1"; }
err() {
  printf '\033[1;31m✗\033[0m %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || err "curl is required."

OS="$(uname -s)"
ARCH="$(uname -m)"

say "Fetching the latest release…"
ASSETS="$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)".*/\1/')"
[ -n "${ASSETS}" ] || err "Could not read the latest release (offline, rate-limited, or no published release yet)."

# First asset URL matching the given extended-regex, or empty.
match() { printf '%s\n' "$ASSETS" | grep -iE "$1" | head -1; }

case "$OS" in
Darwin)
  URL="$(match '\.dmg$')"
  [ -n "$URL" ] || err "No macOS .dmg in the latest release."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  say "Downloading $(basename "$URL")…"
  curl -fSL# "$URL" -o "$TMP/ByteTable.dmg"
  say "Mounting…"
  MNT="$(hdiutil attach "$TMP/ByteTable.dmg" -nobrowse -quiet | grep -o '/Volumes/[^[:cntrl:]]*' | tail -1)"
  [ -n "$MNT" ] || err "Could not mount the disk image."
  APP="$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)"
  if [ -z "$APP" ]; then
    hdiutil detach "$MNT" -quiet || true
    err "No .app inside the disk image."
  fi
  say "Installing to /Applications…"
  rm -rf "/Applications/ByteTable.app"
  cp -R "$APP" /Applications/
  hdiutil detach "$MNT" -quiet || true
  # Unsigned/un-notarized build: clear the quarantine flag so Gatekeeper opens it.
  xattr -dr com.apple.quarantine "/Applications/ByteTable.app" 2>/dev/null || true
  say "Installed — launch ByteTable from /Applications (or: open -a ByteTable)."
  ;;
Linux)
  case "$ARCH" in
  x86_64 | amd64) APAT='amd64|x86_64' ;;
  aarch64 | arm64) APAT='aarch64|arm64' ;;
  *) APAT="$ARCH" ;;
  esac
  # Prefer an AppImage for this arch; fall back to any AppImage.
  URL="$(printf '%s\n' "$ASSETS" | grep -iE '\.AppImage$' | grep -iE "$APAT" | head -1)"
  [ -n "$URL" ] || URL="$(match '\.AppImage$')"
  [ -n "$URL" ] || err "No Linux .AppImage in the latest release. (For .deb, download it from the releases page.)"
  DEST="${HOME}/.local/bin"
  mkdir -p "$DEST"
  say "Downloading $(basename "$URL")…"
  curl -fSL# "$URL" -o "$DEST/bytetable"
  chmod +x "$DEST/bytetable"
  say "Installed to $DEST/bytetable."
  case ":${PATH}:" in
  *":${DEST}:"*) say "Run: bytetable" ;;
  *) say "Add $DEST to your PATH, then run: bytetable" ;;
  esac
  ;;
*)
  err "Unsupported OS '$OS'. On Windows, download the .exe from https://github.com/${REPO}/releases/latest"
  ;;
esac
