#!/usr/bin/env bash
# Self-sign the macOS dev binary with a STABLE identity so the login-keychain
# ACL sticks across rebuilds.
#
# Why: `make dev` / `cargo build` produce an ad-hoc-signed binary whose
# "designated requirement" changes every rebuild, so macOS keeps re-prompting
# for keychain access (sometimes twice per open). Signing every dev build with
# the same self-signed certificate gives a stable designated requirement: once
# you click "Always Allow", every future build signed with the same identity
# satisfies the ACL and never prompts again.
#
#   ./scripts/codesign-dev.sh setup   # one-time: create the identity
#   ./scripts/codesign-dev.sh sign    # sign target/debug/bytetable
#
# `make build-debug` / `make run` call `sign` automatically on macOS.
set -euo pipefail

IDENTITY="ByteTable Dev"
BUNDLE_ID="com.bytetable.app"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../src-tauri/target/debug/bytetable"
LOGIN_KC="$HOME/Library/Keychains/login.keychain-db"

# Only meaningful on macOS; no-op elsewhere so the Makefile can call it blindly.
if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

# The identity to sign with: an explicit override, else the first VALID
# codesigning identity already in the keychain (Apple Development / Developer ID
# / a previously-created self-signed one). Any stable identity makes the ACL
# stick — we don't require our own self-signed cert if a real one exists.
pick_identity() {
  if [ -n "${BYTETABLE_DEV_IDENTITY:-}" ]; then
    echo "$BYTETABLE_DEV_IDENTITY"
    return
  fi
  security find-identity -v -p codesigning 2>/dev/null \
    | grep -m1 -E '^\s*[0-9]+\)' | sed -E 's/.*"(.*)".*/\1/'
}

self_signed_present() {
  security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"
}

setup() {
  local existing
  existing="$(pick_identity)"
  if [ -n "$existing" ]; then
    echo "A codesigning identity is already available: '$existing'."
    echo "Dev builds will be signed with it (set BYTETABLE_DEV_IDENTITY to override)."
    return 0
  fi
  echo "No codesigning identity found — creating self-signed '$IDENTITY'…"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # Self-signed cert with the codeSigning EKU (no CA, signature-only).
  openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -subj "/CN=$IDENTITY" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1
  # `-legacy` (SHA1 MAC + 3DES PBE) so Apple's Security framework accepts the
  # bundle — OpenSSL 3's default PKCS#12 MAC is rejected by `security import`.
  # A throwaway passphrase avoids the empty-password MAC quirk.
  openssl pkcs12 -export -legacy -out "$tmp/id.p12" \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -passout pass:bytetable-dev >/dev/null 2>&1

  # -A: let any tool (codesign) use the imported key without a per-use prompt.
  # The cert need not be "trusted" — codesign only needs the identity present;
  # the keychain ACL matches on the cert, not on trust settings.
  security import "$tmp/id.p12" -k "$LOGIN_KC" -P "bytetable-dev" -A -T /usr/bin/codesign >/dev/null

  if self_signed_present; then
    echo "Done. '$IDENTITY' is now a codesigning identity in your login keychain."
    echo "Next: make run, then click \"Always Allow\" on the keychain prompt — it"
    echo "will not ask again on future signed builds."
  else
    echo "ERROR: could not create a usable codesigning identity. Create one in" >&2
    echo "Keychain Access → Certificate Assistant → Create a Certificate," >&2
    echo "type 'Code Signing', then re-run. (Or set BYTETABLE_DEV_IDENTITY.)" >&2
    exit 1
  fi
}

sign() {
  local id
  id="$(pick_identity)"
  if [ -z "$id" ]; then
    echo "No codesigning identity — run: ./scripts/codesign-dev.sh setup" >&2
    exit 1
  fi
  if [ ! -f "$BIN" ]; then
    echo "Binary not found: $BIN — build it first (make build-debug)." >&2
    exit 1
  fi
  codesign --force --sign "$id" --identifier "$BUNDLE_ID" "$BIN"
  echo "Signed $(basename "$BIN") with '$id'."
}

case "${1:-}" in
  setup) setup ;;
  sign) sign ;;
  *)
    echo "usage: $0 {setup|sign}" >&2
    exit 2
    ;;
esac
