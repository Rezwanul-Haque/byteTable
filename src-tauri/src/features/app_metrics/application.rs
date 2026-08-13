//! Use-cases for the app-metrics slice (M33): sample this process's CPU and
//! resident memory, plus any webview process we can honestly attribute to
//! ourselves. No Tauri, no drivers.

use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// A read taken more than this long after the previous one is treated as cold:
/// the CPU delta would span the whole idle gap and read as a meaningless
/// near-zero, so the command primes a throwaway sample first.
const STALE_AFTER: Duration = Duration::from_secs(5);

/// Re-walk the full process table every N samples to pick up webview processes
/// that came or went. Every sample in between refreshes only our own PIDs,
/// which is the difference between reading ~5 processes and reading every
/// process on the machine — the monitor must not cost more than it measures.
const DISCOVERY_EVERY: u32 = 15;

/// A parent chain longer than this is assumed to be a cycle (a reused PID can
/// produce one) and abandoned, so discovery can never hang.
const MAX_PARENT_DEPTH: u32 = 8;

/// ByteTable's own resource use at one instant (mirrors the renderer's
/// `AppMetrics` in `src/features/app_metrics/api.ts`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMetrics {
    /// Summed across our processes, in the OS's native "percent of one core"
    /// unit — so it can exceed 100 on a multi-core machine. The renderer
    /// decides how to frame it; the backend does not editorialize.
    pub cpu_percent_of_core: f32,
    /// Logical cores, so the renderer can offer the "% of machine" framing
    /// without a second round trip.
    pub cpu_core_count: usize,
    /// Resident set size. NOT the number macOS Activity Monitor shows in its
    /// "Memory" column (that is `phys_footprint`); RSS counts shared pages and
    /// reads higher. The label in the UI says "resident" for this reason.
    pub memory_rss_bytes: u64,
    /// How many processes the numbers cover.
    pub process_count: usize,
    /// Whether the webview's process is included.
    ///
    /// False on macOS: WKWebView's content/GPU/networking processes are XPC
    /// services owned by launchd (verified: their PPID is 1, not ours), so a
    /// parent-chain walk cannot find them and no *public* API maps them back to
    /// the owning app. On Windows (WebView2) and Linux (WebKitGTK) they are our
    /// own children and the walk picks them up. The renderer uses this to label
    /// the readout honestly rather than implying it covers the whole app.
    pub webview_attributed: bool,
}

/// Owns the `System` across calls, because CPU usage is only defined relative
/// to a previous sample.
pub struct MetricsSampler {
    system: System,
    /// Our own PID plus every descendant found by the last discovery pass.
    pids: Vec<Pid>,
    self_pid: Pid,
    last_refresh: Option<Instant>,
    ticks: u32,
}

impl MetricsSampler {
    pub fn new() -> Self {
        Self {
            system: System::new(),
            pids: Vec::new(),
            self_pid: Pid::from_u32(std::process::id()),
            last_refresh: None,
            ticks: 0,
        }
    }

    /// Take a throwaway sample if the next read would otherwise have no recent
    /// baseline to diff against. Returns whether it did — the caller then waits
    /// out `MINIMUM_CPU_UPDATE_INTERVAL` before the real read.
    pub fn prime_if_stale(&mut self) -> bool {
        let stale = match self.last_refresh {
            None => true,
            Some(at) => at.elapsed() > STALE_AFTER,
        };
        if stale {
            self.refresh();
        }
        stale
    }

    /// Sample and total up.
    pub fn read(&mut self) -> AppMetrics {
        self.refresh();

        let mut cpu = 0.0_f32;
        let mut rss = 0_u64;
        let mut counted = 0_usize;
        for pid in &self.pids {
            if let Some(process) = self.system.process(*pid) {
                cpu += process.cpu_usage();
                rss += process.memory();
                counted += 1;
            }
        }

        AppMetrics {
            cpu_percent_of_core: cpu,
            // `available_parallelism` rather than sysinfo's CPU list: it needs
            // no extra refresh (which would cost a full CPU-stat read every
            // tick) and it is the same count the OS schedules us on.
            cpu_core_count: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1),
            memory_rss_bytes: rss,
            process_count: counted,
            webview_attributed: counted > 1,
        }
    }

    /// One refresh pass, widening to the whole process table only on the
    /// discovery tick (or before we know any PIDs at all).
    fn refresh(&mut self) {
        // `without_tasks` is load-bearing, not an optimization. On Linux sysinfo
        // lists every *thread* as a process of its own (`/proc/<pid>/task/*`)
        // whose parent is the owning process — so the discovery walk below
        // adopted all ~50 of our threads, and `read()` added the process's whole
        // RSS once per thread: a 104 MB app reported as 9.3 GB. macOS and
        // Windows have no equivalent, which is why only Linux was wrong. It is
        // also much cheaper: with tasks on, a discovery tick reads the task
        // directory of every process on the machine.
        let kind = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .without_tasks();
        let discovering = self.pids.is_empty() || self.ticks.is_multiple_of(DISCOVERY_EVERY);

        if discovering {
            self.system
                .refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
            self.discover();
        } else {
            self.system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&self.pids),
                true,
                kind,
            );
        }

        self.ticks = self.ticks.wrapping_add(1);
        self.last_refresh = Some(Instant::now());
    }

    /// Our PID plus every process whose parent chain leads back to it.
    ///
    /// Deliberately platform-agnostic: on Windows and Linux this finds the
    /// webview processes, on macOS it finds nothing (see
    /// `AppMetrics::webview_attributed`). One code path, and the result is
    /// self-describing either way.
    fn discover(&mut self) {
        let mut pids = vec![self.self_pid];
        for (pid, process) in self.system.processes() {
            if *pid == self.self_pid {
                continue;
            }
            // A thread shares its process's address space and reports that
            // process's RSS, so counting one would double-count memory we have
            // already added. `refresh` asks for no tasks, but the check stays:
            // it is the invariant, and it costs nothing.
            if process.thread_kind().is_some() {
                continue;
            }
            let mut parent = process.parent();
            let mut depth = 0;
            while let Some(current) = parent {
                if current == self.self_pid {
                    pids.push(*pid);
                    break;
                }
                depth += 1;
                if depth >= MAX_PARENT_DEPTH {
                    break;
                }
                parent = self.system.process(current).and_then(|p| p.parent());
            }
        }
        self.pids = pids;
    }
}

impl Default for MetricsSampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sampler must always find at least itself, on every platform.
    #[test]
    fn reads_its_own_process() {
        let mut sampler = MetricsSampler::new();
        sampler.prime_if_stale();
        let metrics = sampler.read();
        assert!(metrics.process_count >= 1);
        assert!(metrics.memory_rss_bytes > 0);
        assert!(metrics.cpu_core_count >= 1);
    }

    /// `webview_attributed` is a statement about coverage, so it must agree
    /// with the process count rather than being set independently.
    #[test]
    fn attribution_flag_tracks_the_process_count() {
        let mut sampler = MetricsSampler::new();
        let metrics = sampler.read();
        assert_eq!(metrics.webview_attributed, metrics.process_count > 1);
    }

    /// Threads must never enter the counted set. On Linux sysinfo reports each
    /// thread as a process parented to ours, and every one of them reports the
    /// whole process's RSS — so adopting them multiplied the memory readout by
    /// the thread count. Live threads are held open here so the platform has
    /// tasks to offer while the sampler discovers.
    #[test]
    fn threads_are_never_counted_as_processes() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let stop = Arc::new(AtomicBool::new(false));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let stop = Arc::clone(&stop);
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                })
            })
            .collect();

        let mut sampler = MetricsSampler::new();
        sampler.read();
        let offenders: Vec<_> = sampler
            .pids
            .iter()
            .filter(|pid| {
                sampler
                    .system
                    .process(**pid)
                    .is_some_and(|p| p.thread_kind().is_some())
            })
            .collect();

        stop.store(true, Ordering::Relaxed);
        for thread in threads {
            let _ = thread.join();
        }
        assert!(
            offenders.is_empty(),
            "threads counted as processes: {offenders:?}"
        );
    }
}
