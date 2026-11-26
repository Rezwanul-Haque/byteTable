# ADR-0001 — Tauri 2 with a Rust core and a React/Vite renderer

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-12 (first commit that shipped the feature)
- **Area:** Architecture
- **Related:** ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0052, ADR-0053, `docs/M0-scaffold-design-system.md`

## Context

ByteTable is a local-first desktop database client (a TablePlus alternative) that
ships on macOS, Windows and Linux. It has to hold live driver connections to many
engines, keep credentials away from the UI, and render large grids and editors.

The stack was fixed as a requirement at project start: Rust + Tauri 2 with a
React + TypeScript renderer. A second requirement is that the renderer never sees
credentials, sockets, or driver handles; all I/O crosses the Tauri command
boundary. No written comparison with other shells exists in the repo.

The scaffold landed on 2026-06-12 (`a679058 feat: bootstrap Tauri 2 + React/TS/Vite
scaffold`, then `c51d329 feat: M0 — scaffold + design system`).

## Decision

- **Shell: Tauri 2.** `src-tauri/src/main.rs` is a thin binary that calls
  `bytetable_lib::run()`. `src-tauri/src/lib.rs` is the composition root: it
  registers plugins, managed state, engine connectors, and the single
  `tauri::generate_handler![…]` command list. The lib is named `bytetable_lib`
  with `crate-type = ["staticlib", "cdylib", "rlib"]` (`src-tauri/Cargo.toml`).
- **Core: Rust 2021, MSRV 1.89.** `rust-version = "1.89"` plus
  `resolver.incompatible-rust-versions = "fallback"` in `.cargo/config.toml`. The
  Cargo.toml comment records the reason: the AWS SDK raised the effective MSRV,
  and the fallback resolver picks the newest crates that still build on 1.89.
  Several dependencies are pinned for the same reason (`sysinfo` 0.38,
  `tauri-plugin-notification` held at 2.4.0).
- **Renderer: React 19 + TypeScript + Vite 6.** Vite runs on fixed port 1420
  (`strictPort`), wired through `tauri.conf.json` (`beforeDevCommand: pnpm dev:vite`,
  `devUrl: http://localhost:1420`, `frontendDist: ../dist`).
- **All database I/O is Rust-side.** Every driver (rusqlite, sqlx, tiberius,
  redis, aws-sdk-dynamodb, mongodb, scylla, reqwest) is a Rust crate behind the
  port traits (ADR-0003). The renderer only calls `invoke()` (ADR-0005).
- **Pure-Rust TLS throughout.** sqlx `tls-rustls`, redis `tokio-rustls-comp`,
  tiberius `rustls`, reqwest `rustls-tls` and russh all avoid an OpenSSL system
  dependency. The Cargo.toml comments give this as the reason for each choice.
- **Tauri plugins used:** opener, dialog, updater + process (ADR-0052),
  single-instance, os, notification (ADR-0027). The tray uses Tauri's
  `tray-icon` feature (ADR-0053).
- **Window:** `decorations: false`, `transparent: true` in `tauri.conf.json`. A
  custom title bar replaced the native one on 2026-07-01 (`f4b35e4`). This
  reverses the M0 doc's "not frameless" note.
- **Release profile tuned for size:** `opt-level = "s"`, `lto`,
  `codegen-units = 1`, `panic = "abort"`, `strip`.

## Alternatives considered

- **Electron.** Not evaluated in any repo document. Inferred trade-off: Electron
  bundles Chromium, which gives one rendering engine on every OS, but it produces
  larger binaries and puts DB drivers in Node. That would break the "renderer
  never sees sockets" rule unless a separate main-process layer were built.
- **A native toolkit (Qt, GTK, SwiftUI).** Not evaluated. Inferred: it would mean
  three UI codebases, or a heavy C++ toolkit, and would not reuse the HTML/CSS
  design.
- **Tauri 1.** Not evaluated. Tauri 2 was current when the project started.

The stack was fixed as a requirement at project start. README.md says only "small
binaries; macOS / Linux / Windows".

## Consequences

- **Positive:** small, signed, cross-OS bundles. Drivers, secrets and tunnels
  stay in one memory-safe process. A typed command boundary (ADR-0005). One
  Rust test suite covers every engine adapter (`cargo test --all-features`).
- **Negative / trade-offs:** each OS uses its own webview (WKWebView,
  WebView2, WebKitGTK), so rendering differs. Recorded case: schema-map PNG
  export is rasterised in Rust with `resvg` because "WebKitGTK on Linux cannot
  draw an SVG to `<canvas>`" (Cargo.toml). The MSRV pin keeps several crates
  behind their latest versions. Wire types are mirrored by hand between Rust and
  TS (ADR-0005).
- **Follow-ups:** the MSRV pins (`sysinfo`, `tauri-plugin-notification`,
  aws-sdk) need revisiting when the toolchain moves past 1.89.
