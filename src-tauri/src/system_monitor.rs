//! System health monitor: battery, CPU, memory and disk reminders for
//! long working sessions. Built for developers and Linux users who lose
//! track of time at the keyboard.
//!
//! Linux-first and dependency-light: battery and CPU/memory come from
//! `/sys` and `/proc` file reads; only disk free space needs `libc` for
//! `statvfs`. A single async task ticks every 60 seconds — these are
//! slow-moving conditions, so there is no hot polling.
//!
//! When an enabled `Schedule::System` reminder's condition holds and its
//! re-fire interval has elapsed, the monitor fires it through the normal
//! scheduler path (`fire_if_eligible`), so quiet hours, daily limit,
//! cooldown, history and the dock UI all behave exactly like they do for
//! time-based reminders.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::db;
use crate::scheduler::{self, SystemMetric};

/// Seconds between monitor ticks.
const TICK_SECS: u64 = 60;

/// Battery at or below this percent while discharging triggers.
const BATTERY_LOW_PCT: u8 = 20;
/// Sustained CPU usage above this percent triggers.
const CPU_HIGH_PCT: f64 = 85.0;
/// Available memory below this fraction of total triggers.
const MEM_LOW_FRAC: f64 = 0.10;
/// Disk free below this many bytes — or this fraction — triggers.
const DISK_LOW_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const DISK_LOW_FRAC: f64 = 0.10;

/// Minimum time between two firings of the same system reminder while
/// its condition keeps holding. Prevents nagging; the user can snooze
/// or toggle the reminder off.
fn refire_interval(metric: &SystemMetric) -> Duration {
    match metric {
        SystemMetric::BatteryLow => Duration::from_secs(30 * 60),
        SystemMetric::CpuHigh => Duration::from_secs(30 * 60),
        SystemMetric::MemoryHigh => Duration::from_secs(60 * 60),
        SystemMetric::DiskLow => Duration::from_secs(6 * 60 * 60),
    }
}

/// Pure condition helpers, unit-testable without touching /sys or /proc.
pub fn battery_low(capacity_pct: u8, discharging: bool) -> bool {
    discharging && capacity_pct <= BATTERY_LOW_PCT
}

pub fn cpu_high(usage_pct: f64) -> bool {
    usage_pct > CPU_HIGH_PCT
}

pub fn memory_low(total_kb: u64, available_kb: u64) -> bool {
    total_kb > 0 && (available_kb as f64) < (total_kb as f64) * MEM_LOW_FRAC
}

pub fn disk_low(free_bytes: u64, total_bytes: u64) -> bool {
    free_bytes < DISK_LOW_BYTES
        || (total_bytes > 0 && (free_bytes as f64) < (total_bytes as f64) * DISK_LOW_FRAC)
}

/// (capacity_percent, discharging) for the first battery found under
/// `/sys/class/power_supply`. None on desktops without a battery or
/// when sysfs can't be read — the condition is then simply false.
pub fn read_battery() -> Option<(u8, bool)> {
    let dir = std::fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in dir.flatten() {
        let base = entry.path();
        let kind = std::fs::read_to_string(base.join("type"))
            .unwrap_or_default()
            .trim()
            .to_string();
        if kind != "Battery" {
            continue;
        }
        let capacity: u8 = std::fs::read_to_string(base.join("capacity"))
            .ok()?
            .trim()
            .parse()
            .ok()?;
        let status = std::fs::read_to_string(base.join("status")).unwrap_or_default();
        return Some((capacity, status.trim() == "Discharging"));
    }
    None
}

/// Parse the aggregate `cpu` line of `/proc/stat` into
/// (total_jiffies, idle_jiffies). Pure over the file content.
pub fn parse_cpu_times(stat: &str) -> Option<(u64, u64)> {
    let mut fields = stat.lines().next()?.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let nums: Vec<u64> = fields.map(|f| f.parse().ok()).collect::<Option<_>>()?;
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    // idle + iowait both count as idle time.
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some((total, idle))
}

/// CPU usage percent between two samples. None when the counters didn't
/// advance (or went backwards).
pub fn cpu_usage_percent(prev: (u64, u64), curr: (u64, u64)) -> Option<f64> {
    let total_d = curr.0.checked_sub(prev.0)?;
    let idle_d = curr.1.checked_sub(prev.1)?;
    if total_d == 0 {
        return None;
    }
    Some(100.0 * (1.0 - idle_d as f64 / total_d as f64))
}

/// (total_kb, available_kb) from `/proc/meminfo`. Pure over the content.
pub fn parse_meminfo(meminfo: &str) -> Option<(u64, u64)> {
    let mut total = None;
    let mut available = None;
    for line in meminfo.lines() {
        let mut kv = line.split_whitespace();
        let Some(key) = kv.next() else { continue };
        let Some(val) = kv.next() else { continue };
        let Ok(val): Result<u64, _> = val.parse() else { continue };
        match key {
            "MemTotal:" => total = Some(val),
            "MemAvailable:" => available = Some(val),
            _ => {}
        }
    }
    Some((total?, available?))
}

/// (free_bytes, total_bytes) for the filesystem containing `path`,
/// via `statvfs`. `f_bavail` (unprivileged free) is the honest number.
pub fn disk_usage(path: &str) -> Option<(u64, u64)> {
    use std::ffi::CString;
    let c_path = CString::new(path).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let free = st.f_bavail as u64 * st.f_frsize as u64;
    let total = st.f_blocks as u64 * st.f_frsize as u64;
    Some((free, total))
}

struct MonitorState {
    /// Previous /proc/stat sample for the CPU delta.
    cpu_prev: Option<(u64, u64)>,
    /// Last fire time per system reminder id (in-memory re-fire latch).
    last_fired: HashMap<String, Instant>,
}

/// Snapshot the enabled system reminders: (id, metric).
fn system_reminders(app: &AppHandle) -> Vec<(String, SystemMetric)> {
    // Same E0515 note as scheduler::validate_store: the guard never
    // leaves the closure.
    app.try_state::<db::DbState>()
        .and_then(|st| {
            st.0.lock().ok().map(|conn| {
                db::list_reminders(&conn)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|r| r.enabled)
                    .filter_map(|r| {
                        match serde_json::from_str::<scheduler::Schedule>(&r.schedule) {
                            Ok(scheduler::Schedule::System { metric }) => {
                                Some((r.id, metric))
                            }
                            _ => None,
                        }
                    })
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Evaluate one metric against the live system. Pure conditions are
/// factored out above so they stay unit-testable.
fn condition_met(metric: &SystemMetric, state: &mut MonitorState) -> bool {
    match metric {
        SystemMetric::BatteryLow => {
            read_battery().map_or(false, |(pct, discharging)| battery_low(pct, discharging))
        }
        SystemMetric::CpuHigh => {
            let curr = std::fs::read_to_string("/proc/stat")
                .ok()
                .and_then(|s| parse_cpu_times(&s));
            let usage = match (state.cpu_prev, curr) {
                (Some(prev), Some(c)) => cpu_usage_percent(prev, c),
                _ => None,
            };
            // Always advance the sample so the next tick measures a
            // fresh 60-second window.
            if let Some(c) = curr {
                state.cpu_prev = Some(c);
            }
            usage.map_or(false, cpu_high)
        }
        SystemMetric::MemoryHigh => std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|s| parse_meminfo(&s))
            .map_or(false, |(total, avail)| memory_low(total, avail)),
        SystemMetric::DiskLow => disk_usage("/")
            .map_or(false, |(free, total)| disk_low(free, total)),
    }
}

async fn tick(app: &AppHandle, state: &mut MonitorState) {
    // Refresh the CPU baseline every tick even with no CPU reminder, so
    // the first evaluation after enabling measures a real window.
    if state.cpu_prev.is_none() {
        state.cpu_prev = std::fs::read_to_string("/proc/stat")
            .ok()
            .and_then(|s| parse_cpu_times(&s));
    }
    for (id, metric) in system_reminders(app) {
        if !condition_met(&metric, state) {
            continue;
        }
        let due = state
            .last_fired
            .get(&id)
            .map_or(true, |t| t.elapsed() >= refire_interval(&metric));
        if !due {
            continue;
        }
        // The normal scheduler path: eligibility (enabled, pause, quiet
        // hours, daily limit, cooldown), history, dock UI, sound.
        scheduler::fire_if_eligible(app, &id).await;
        state.last_fired.insert(id, Instant::now());
    }
}

/// Spawn the monitor task. Runs for the life of the app; each tick takes
/// one short DB lock and a few file reads.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut state = MonitorState {
            cpu_prev: None,
            last_fired: HashMap::new(),
        };
        loop {
            tick(&app, &mut state).await;
            tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn battery_condition() {
        assert!(battery_low(20, true));
        assert!(battery_low(5, true));
        assert!(!battery_low(21, true));
        // Charging (or full/idle) never triggers, however low.
        assert!(!battery_low(5, false));
    }

    #[test]
    fn cpu_times_parse_and_usage() {
        let a = "cpu  100 0 50 850 0 0 0 0 0 0\nintr 123\n";
        let b = "cpu  200 0 100 900 0 0 0 0 0 0\nintr 456\n";
        let pa = parse_cpu_times(a).unwrap();
        let pb = parse_cpu_times(b).unwrap();
        // total: 1000 -> 1200 (d=200); idle: 850 -> 900 (d=50)
        assert_eq!(pa, (1000, 850));
        assert_eq!(pb, (1200, 900));
        assert!((cpu_usage_percent(pa, pb).unwrap() - 75.0).abs() < 1e-9);
        assert!(cpu_high(90.0));
        assert!(!cpu_high(85.0));
        assert!(!cpu_high(10.0));
    }

    #[test]
    fn cpu_times_rejects_garbage() {
        assert!(parse_cpu_times("").is_none());
        assert!(parse_cpu_times("cpu 1 2\n").is_none());
        assert!(parse_cpu_times("intr 1 2 3 4\n").is_none());
        // Counters that didn't advance: no usage to report.
        let p = (1000, 850);
        assert!(cpu_usage_percent(p, p).is_none());
    }

    #[test]
    fn meminfo_parse_and_condition() {
        let info = "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    1500000 kB\nBuffers:           50000 kB\n";
        let (total, avail) = parse_meminfo(info).unwrap();
        assert_eq!(total, 16384000);
        assert_eq!(avail, 1500000);
        // 1.5M / 16.3M ≈ 9.2% < 10%: triggers.
        assert!(memory_low(total, avail));
        // 3M available ≈ 18%: fine.
        assert!(!memory_low(total, 3000000));
        assert!(parse_meminfo("MemTotal: 100 kB\n").is_none());
    }

    #[test]
    fn disk_condition() {
        let gib = 1024 * 1024 * 1024;
        // Below the 5 GiB floor triggers even on a huge disk.
        assert!(disk_low(4 * gib, 1000 * gib));
        // Below 10% triggers even above the byte floor.
        assert!(disk_low(8 * gib, 100 * gib));
        // Healthy disk: quiet.
        assert!(!disk_low(50 * gib, 100 * gib));
    }

    #[test]
    fn refire_intervals_are_sane() {
        assert!(refire_interval(&SystemMetric::BatteryLow) <= Duration::from_secs(3600));
        assert!(refire_interval(&SystemMetric::DiskLow) >= Duration::from_secs(3600));
    }
}
