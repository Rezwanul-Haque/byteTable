# ADR-0052 — Signed in-app updates from GitHub Releases, cut by `make tag`

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-15 (`281d37f feat: updater & landing page added`)
- **Area:** App shell
- **Related:** ADR-0001, ADR-0053, `docs/AUTO_UPDATE.md`

## Context

A desktop app installed from GitHub needs a way to reach users with new builds. Tauri 2 provides
an updater plugin that verifies a minisign signature against a public key compiled into the app.
ByteTable has no server of its own, so GitHub Releases is both the distribution channel and the
update manifest host. Releases must also be hard to publish by accident from a fork or a non-main
commit.

## Decision

- **Plugins.** `src-tauri/Cargo.toml` adds `tauri-plugin-updater` and `tauri-plugin-process`. The
  comment there reads: "checks the GitHub release `latest.json`, downloads … desktop-only". Both
  are registered in `src-tauri/src/lib.rs`. `tauri.conf.json` → `plugins.updater` sets one
  endpoint,
  `https://github.com/rezwanul-Haque/byteTable/releases/latest/download/latest.json`, the `pubkey`,
  and `windows.installMode: "passive"`. `bundle.createUpdaterArtifacts: true` produces the
  signed bundles.
- **Renderer.** `src/features/updater/api.ts` wraps `check()` and is a no-op outside the Tauri
  shell (`__TAURI_INTERNALS__`). `App.tsx` checks once on launch. A found update always lights the
  rail indicator; the modal opens automatically only if that version was not skipped. The skip is
  stored in localStorage (`bytetable_skipped_version`). Help → Check for Updates re-runs the check
  and falls back to the About sheet. `components/UpdateModal.tsx` shows current → new version and
  renders `update.body` (the release notes) as Markdown. It then runs `downloadAndInstall` with a
  progress bar and calls `relaunch()`.
- **Single source for the repo slug.** `UPDATE_REPO` in `updater/api.ts` is reused by Report Issue
  (`report_issue/api.ts`, ADR-0053). `docs/AUTO_UPDATE.md` notes it must match the endpoint.
- **Cutting a release: `make tag VERSION=x.y.z`** (`Makefile`). It refuses to run unless the
  current branch is `dev`, the tree is clean, local `dev` is not behind `origin/dev`, and
  `origin/main` is an ancestor of `origin/dev`. It then:
  1. runs `scripts/bump-version.sh` over `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`,
     `package.json`, `index.html`, `updater/api.ts` (`FALLBACK_VERSION`) and `Rail.tsx`;
  2. commits `Release vX`, pushes `dev`, fast-forwards `main` to `dev`, creates the annotated tag
     `vX`, and pushes both.
- **`.github/workflows/release.yml`** (on `v*` tags) has four jobs:
  1. `create-release` runs only when `github.repository == 'Rezwanul-Haque/byteTable'`, and only if
     the tagged commit is an ancestor of `origin/main`. It builds grouped notes from
     conventional-commit subjects (feat → Added, fix → Fixes, …) and creates one draft release.
  2. `build` is a matrix: macOS universal, Linux x64, Linux arm64 and Windows. Each job stamps the
     tag version into the manifests and runs `tauri-action` with `TAURI_SIGNING_PRIVATE_KEY`. All
     jobs upload into the same `releaseId`. `releaseBody` is set so `latest.json.notes` is filled in.
  3. `publish-release` uploads `SHASUMS256.txt` and flips the draft to `make_latest`.
  4. `publish-packages` calls `publish-packages.yml` (Chocolatey and Homebrew cask). It can also be
     dispatched by hand, and it skips itself when its secrets are missing.
- **CI gate** (`.github/workflows/ci.yml`): pnpm lint, format:check, typecheck, test and build,
  then cargo fmt, clippy `-D warnings`, test and build, all with `--frozen-lockfile`.

## Alternatives considered

- **A matrix where each job creates its own release.** Rejected in `release.yml`'s header: jobs
  "race to create [their] OWN release (duplicate drafts, split assets)". The fix is one draft up
  front and uploads by id.
- **Trust `github.event.base_ref` to detect main.** Rejected in the workflow comment because it is
  "often null on tag pushes". The workflow checks ancestry with `git merge-base` instead.
- **Version only from the tag.** CI does stamp the tag version at build time. `bump-version.sh`
  still edits the committed source so it cannot drift: its comment cites "the
  v0.0.1-while-tags-hit-v0.0.9 bug".
- **A self-hosted update server.** Not considered in the code. Inferred: `releases/latest/download`
  gives a stable URL at no cost.

## Consequences

- **Positive:** Updates are signature-verified, and one command cuts a release across all OSes.
  Release notes appear both in the app and on GitHub. Forks and non-main tags cannot publish.
- **Negative / trade-offs:** The private signing key and its password are GitHub secrets, and
  losing them would strand installed clients on the old pubkey. Only the latest published release
  is ever offered, so there are no channels or staged rollout. The updater does nothing in plain
  browser dev.
- **Follow-ups:** `docs/AUTO_UPDATE.md` §4 is out of date. It still says to tag by hand and
  publish the draft manually, while `release.yml` now publishes automatically and `make tag` does
  the bump and tag.
