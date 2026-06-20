#!/usr/bin/env bash
# Bump the app version across every source that hard-codes it, so dev builds +
# the splash/rail show the right number. The release workflow also stamps the
# tag version into tauri.conf.json/Cargo.toml at BUILD time, but the committed
# source must not drift behind the tags (the v0.0.1-while-tags-hit-v0.0.9 bug).
#
#   Usage: scripts/bump-version.sh <version>   (e.g. 0.0.10 or v0.0.10)
#
# Targeted, minimal-diff edits (perl, no reformat) of the FIRST version field in
# each file. Run from `make tag`.
set -euo pipefail

V="${1:-}"
V="${V#v}"
[ -n "$V" ] || { echo "usage: $0 <version>  (e.g. 0.0.10)"; exit 1; }
echo "$V" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([-.+].*)?$' || {
  echo "error: '$V' is not a semver version"; exit 1;
}
export V
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# JSON manifests — first `"version": "…"` only.
for f in src-tauri/tauri.conf.json package.json; do
  perl -i -pe 'if(!$d && /"version"\s*:\s*"/){s/("version"\s*:\s*")[^"]*(")/${1}$ENV{V}${2}/;$d=1}' "$f"
done

# Cargo.toml — the [package] version (first line-anchored `version = "…"`).
perl -i -pe 'if(!$d && /^version = "/){s/"[^"]*"/"$ENV{V}"/;$d=1}' src-tauri/Cargo.toml

# JS fallbacks (shown only before the real version resolves / in browser dev).
perl -i -pe 's/(FALLBACK_VERSION = ")[^"]*(")/${1}$ENV{V}${2}/' src/features/updater/api.ts
perl -i -pe 's/(version \?\? ")[^"]*(")/${1}$ENV{V}${2}/' src/features/workspaces/components/Rail.tsx

# index.html splash footer — hardcoded (paints before any JS, so it can't read
# the real version).
perl -i -pe 's/(class="splash-foot">v)[0-9][^ ]*( ·)/${1}$ENV{V}${2}/' index.html

echo "Bumped version to $V"
