# Auto-update + landing page — setup

The app checks GitHub releases on launch and offers an in-app download/install
(`src/features/updater/`, Tauri updater + process plugins). The release workflow
builds **signed** installers + a `latest.json` manifest; the updater verifies the
signature against a public key baked into the app. You must do a few one-time
steps before this works.

## 1. Generate the updater signing key (once)

```sh
# from the repo root (where src-tauri/ lives)
pnpm tauri signer generate -w ~/.tauri/bytetable-updater.key
```

This prints/writes two things:

- **Public key** — paste it into `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey`, replacing `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`.
- **Private key** (`~/.tauri/bytetable-updater.key`) + the password you chose —
  these are **secrets**; never commit them.

## 2. Add the private key as GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret                               | Value                                            |
| ------------------------------------ | ------------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | the **contents** of `~/.tauri/bytetable-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you set when generating it          |

## 3. Confirm the updater endpoint

`tauri.conf.json` → `plugins.updater.endpoints` points at:

```
https://github.com/rezwanul-Haque/byteTable/releases/latest/download/latest.json
```

The release workflow uploads `latest.json` to each release; this URL always
resolves to the most recent **published** (non-draft) release. The repo slug must
match `UPDATE_REPO` in `src/features/updater/api.ts` and the updater endpoint.

## 4. Cut a release

```sh
# bump version in src-tauri/tauri.conf.json (e.g. 0.1.0 → 0.2.0), commit, then:
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` builds macOS (universal) / Linux / Windows,
signs the updater artifacts, and creates a **draft** GitHub release with the
installers + `latest.json`. **Publish the draft** (un-draft it) so
`releases/latest` resolves to it — only then will running apps see the update.

> The app version the updater compares against is `src-tauri/tauri.conf.json` →
> `version`. Bump it for every release or the updater won't detect a newer one.

## 5. Landing page (GitHub Pages)

`landing/index.html` is deployed by `.github/workflows/pages.yml`. Enable it once:

Repo → Settings → Pages → **Build and deployment → Source: GitHub Actions**.

The page shows the latest release tag in its hero badge (fetched live from the
GitHub API, with a static fallback when offline / rate-limited).
