# ADR-0053 — App shell: close-to-tray, single instance, splash, own-resource readout, report issue

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (`013ca3d feat(window): real app icon from BTLogo + system tray with minimize-to-tray`)
- **Area:** App shell
- **Related:** ADR-0001, ADR-0027, ADR-0040, ADR-0049, ADR-0050, ADR-0052

## Context

A database client often holds live connections and scheduled checks (ADR-0027) that should keep
running when the window is closed. Launching the app twice, for example by clicking the AppImage
again or double-clicking a `.sqlite` file, must not start a second process with its own connection
pool. Startup should not flash an empty window. These behaviours are spread across
`src-tauri/src/lib.rs`, `index.html`/`src/main.tsx` and three small slices, and are recorded
together here.

## Decision

- **Close hides to tray** (`013ca3d`, 2026-06-13). `on_window_event` intercepts
  `WindowEvent::CloseRequested`, calls `api.prevent_close()`, hides the window, and on macOS
  switches to `ActivationPolicy::Accessory`, which removes the Dock icon. The renderer can do the
  same through the `hide_to_tray` command. ⌘Q and tray Quit exit through `RunEvent::ExitRequested`.
  That handler first holds the quit if notebooks are unsaved (`notebooks::commands::hold_quit`),
  then `block_on`s `close_all()` on every connection before the process exits.
- **Tray** (`TrayIconBuilder::with_id("main-tray")`, Cargo feature `tray-icon`). Left-click toggles
  the main window. Right-click opens a native menu: Show, a Workspaces submenu, and Quit. The
  submenu has one `CheckMenuItem` per saved connection with id `ws:<connectionId>`, checked when
  that connection is open (`585882b`, 2026-06-18). The renderer (`src/features/workspaces/trayMenu.ts`)
  rebuilds the menu with `tray_update(workspaces, labels)` whenever the connection list or the
  language changes (ADR-0050). Picking an item emits `tray://select-workspace`.
- **A separate tray panel window was planned but not shipped.** That plan specified a
  second `tray-panel` webview and a `tray.html` entry. Neither exists, and left-click still
  toggles the window.
- **Single instance** (`b8957c3`, 2026-06-16). `tauri_plugin_single_instance` is registered as
  the first plugin, as the code comment requires. Its callback raises the existing window and
  forwards `args` to `file_open::queue_open`. On Windows and Linux that is how a double-clicked
  database reaches the running instance (ADR-0040).
- **macOS Dock Reopen.** `RunEvent::Reopen { has_visible_windows: false }` calls
  `show_main_window`, gated with `#[cfg(target_os = "macos")]`. Without it, a hidden window could
  only be brought back from the tray. `RunEvent::Opened` handles Finder file opens.
- **Splash** (`8d5069c`, 2026-06-16). `index.html` contains a static `#bt-splash`. After two
  `requestAnimationFrame`s, which is after React's first committed frame, `src/main.tsx` keeps it
  up until at least `minShow = 1400` ms have passed (a 1.4 s minimum), then
  fades it out and removes it. The window is `decorations: false, transparent: true`
  (`tauri.conf.json`), and the title bar is drawn by the renderer (ADR-0054).
- **Own-resource readout** (`8ef79c9`, 2026-08-11). `src-tauri/src/features/app_metrics/` exposes
  `app_metrics_read`. A long-lived `MetricsSampler` in `AppMetricsState` reads `sysinfo`. CPU is a
  delta between two samples, so a cold read primes first and sleeps
  `MINIMUM_CPU_UPDATE_INTERVAL`. Most samples refresh only ByteTable's own PIDs; every 15th sample
  re-walks the process table to find webview children. `webviewIncluded` is false on macOS,
  because WKWebView's processes are launchd XPC services with PPID 1, and the UI labels the reading
  accordingly. `sysinfo` is pinned to `0.38` for the 1.89 MSRV (Cargo.toml comment). On the
  renderer side, `hooks/useAppMetrics.ts` runs one shared 2 s poll, reference-counted across every
  workspace's status bar (`ResourceMeter`), and pauses while `document.hidden`, so a window hidden
  in the tray costs nothing.
- **Report issue** (`be78bcb`, 2026-07-21). `src/features/report_issue/` builds a prefilled
  `github.com/<UPDATE_REPO>/issues/new?template=…` URL for one of the forms in
  `.github/ISSUE_TEMPLATE/` (`bug_report.yml`, `feature_request.yml`, `question.yml`). It can
  optionally include diagnostics: version, OS, engine, theme and locale. The URL is opened in the
  browser with `tauri-plugin-opener`. Nothing is sent by the app itself, so no token or API write
  is needed. Severity is passed as the dropdown's label (`c9f4e86`), because issue-form dropdowns
  ignore other values.

## Alternatives considered

- **Quit on close.** Rejected: scheduled checks and the tray workspace switcher need a running
  process. The notification plugin comment in `Cargo.toml` makes the same point ("close-to-tray
  means the usual 3am run has no window to toast in").
- **A webview tray panel.** Planned but not built. The plan keeps the native menu in any
  case, as the accessible path and as a reliable way to Quit.
- **Measure the whole machine, or every process.** Rejected in `application.rs`: "the monitor must
  not cost more than it measures".
- **File issues through the GitHub API.** Rejected in `report_issue/api.ts`: a prefilled URL works
  for anonymous users and sends nothing silently.

## Consequences

- **Positive:** Connections and schedules survive a window close. A second launch, or a file
  opened while the app is running, reuses the same process. The first frame the user sees is
  themed. The resource readout is honest about what it covers.
- **Negative / trade-offs:** Users who expect close to mean quit have to learn ⌘Q or tray Quit.
  The splash adds up to 1.4 s to every launch, even fast ones. Memory is shown as RSS, which reads
  higher than Activity Monitor. The macOS figure leaves out the webview.
- **Follow-ups:** The webview tray panel is not built.
