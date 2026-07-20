# Homebrew Cask (macOS)

Distributes ByteTable via a **custom Homebrew tap**. The cask downloads the
official universal `.dmg` from the matching GitHub release and verifies its
SHA-256 — it never embeds the app.

## Install (users)

```sh
brew install --cask rezwanul-haque/tap/bytetable
# or:
brew tap rezwanul-haque/tap
brew install --cask bytetable
```

## One-time setup

1. Create a public repo named **`homebrew-tap`** under the same owner
   (`Rezwanul-Haque/homebrew-tap`). The `homebrew-` prefix is what makes
   `brew tap rezwanul-haque/tap` work. It just needs a `Casks/` directory.
2. Create a **fine-grained Personal Access Token** with **Contents: read/write**
   on that tap repo, and add it to THIS repo as the secret
   **`HOMEBREW_TAP_TOKEN`** (Settings → Secrets and variables → Actions).

> Without `HOMEBREW_TAP_TOKEN`, the release workflow's `homebrew` job self-skips.

## Automated release (CI)

The `homebrew` job in `.github/workflows/release.yml` runs on every `v*` tag
(after the release + `SHASUMS256.txt` are published): it reads the version from
the tag, pulls the `universal.dmg` checksum from `SHASUMS256.txt`, renders
`bytetable.rb.template`, and commits it to `Casks/bytetable.rb` in the tap repo.

## Manual render

```sh
version=0.0.21
sha=$(awk -v f="ByteTable_${version}_universal.dmg" '$2==f {print $1}' SHASUMS256.txt)
sed -e "s/__VERSION__/$version/g" -e "s/__SHA256__/$sha/g" \
  bytetable.rb.template > bytetable.rb
brew install --cask ./bytetable.rb   # local test
```

Note: the `.dmg` should be signed + notarized for a clean `brew install --cask`;
an unsigned build installs but macOS Gatekeeper may prompt on first launch.
