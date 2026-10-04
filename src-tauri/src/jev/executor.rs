//! The trusted execution layer.
//!
//! Architecture:
//!
//! ```text
//! ValidatedAction → ActionExecutor
//!   ├── ApplicationExecutor  (allowlisted app registry, PATH-resolved binaries)
//!   ├── FileExecutor         (bounded std::fs walk — never a shell)
//!   ├── FolderExecutor       (known folders, xdg-open, validated mkdir)
//!   ├── ReminderExecutor     (existing SQLite reminder store)
//!   └── SystemExecutor       (system_monitor + /proc — read-only)
//! ```
//!
//! Security rules, enforced by construction:
//!
//! - Jev never learns how Linux performs an action; it only produces
//!   [`ValidatedAction`]s.
//! - NO shell is ever spawned. [`std::process::Command`] is only ever
//!   given an allowlisted or PATH-resolved binary plus validated
//!   arguments. Raw transcript text can never become a command.
//! - Filesystem access is bounded: a fixed set of user roots, a max
//!   depth, a max number of visited entries, and a deadline.
//! - Every result is machine-readable ([`ActionResult`]); the frontend
//!   turns `response_key` + `response_params` into EN/Manglish text.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri::Manager;

use super::context::{ConversationContext, SearchHit};
use super::schema::{SystemMetric, ValidatedAction};
use crate::{db, scheduler, system_monitor};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionStatus {
    Success,
    Error,
}

/// Machine-readable outcome. `response_key` names a frontend i18n
/// template (e.g. `"openingApp"`); `response_params` fills its
/// placeholders. Jev/the executor never render user-facing text.
#[derive(Debug, Clone)]
pub struct ActionResult {
    pub status: ActionStatus,
    pub response_key: &'static str,
    pub response_params: serde_json::Value,
    pub data: Option<serde_json::Value>,
}

impl ActionResult {
    pub(crate) fn ok(key: &'static str, params: serde_json::Value) -> Self {
        ActionResult {
            status: ActionStatus::Success,
            response_key: key,
            response_params: params,
            data: None,
        }
    }

    pub(crate) fn err(key: &'static str, params: serde_json::Value) -> Self {
        ActionResult {
            status: ActionStatus::Error,
            response_key: key,
            response_params: params,
            data: None,
        }
    }

    fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
}

fn obj(pairs: &[(&str, &str)]) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), serde_json::Value::String(v.to_string()));
    }
    serde_json::Value::Object(m)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Resolve a binary name through PATH without a shell. Returns the
/// first executable match.
fn resolve_in_path(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\0') {
        return None;
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// True when `path` is inside the user's home tree (lexically, after
/// resolving `.`/`..` components — symlinks are not followed by the
/// search, and opened paths are canonicalized first).
fn within_home(path: &Path) -> bool {
    let (Some(home), Ok(canon)) = (home_dir(), path.canonicalize()) else {
        return false;
    };
    canon.starts_with(home)
}

// ---------------------------------------------------------------------------
// ApplicationExecutor
// ---------------------------------------------------------------------------

struct AppEntry {
    /// Spoken names that map to this app.
    names: &'static [&'static str],
    /// Candidate binaries, tried in order through PATH.
    binaries: &'static [&'static str],
}

/// The allowlisted application registry. Extensible: add an entry, no
/// other code changes. Anything not listed here can never be launched.
const APP_REGISTRY: &[AppEntry] = &[
    AppEntry { names: &["firefox"], binaries: &["firefox"] },
    AppEntry {
        names: &["chrome", "google chrome"],
        binaries: &["google-chrome", "google-chrome-stable", "chrome"],
    },
    AppEntry {
        names: &["chromium"],
        binaries: &["chromium", "chromium-browser"],
    },
    AppEntry {
        names: &["code", "vscode", "visual studio code", "vs code"],
        binaries: &["code", "code-insiders"],
    },
    AppEntry {
        names: &["terminal", "command line"],
        binaries: &["gnome-terminal", "x-terminal-emulator", "konsole", "xterm"],
    },
    AppEntry {
        names: &["files", "nautilus", "file manager", "file explorer"],
        binaries: &["nautilus"],
    },
];

fn find_app(spoken: &str) -> Option<(&'static AppEntry, PathBuf)> {
    let spoken = spoken.to_lowercase();
    let entry = APP_REGISTRY
        .iter()
        .find(|e| e.names.iter().any(|n| *n == spoken))?;
    let bin = entry.binaries.iter().find_map(|name| resolve_in_path(name))?;
    Some((entry, bin))
}

/// True when the spoken name is in the allowlisted registry (ignoring
/// whether the binary is installed). Used by the intent parser to tell
/// "open firefox" (application) from "open my resume" (file).
pub(crate) fn is_known_app(spoken: &str) -> bool {
    let spoken = spoken.trim().to_lowercase();
    APP_REGISTRY
        .iter()
        .any(|e| e.names.iter().any(|n| *n == spoken))
}

fn spawn_detached(bin: &Path, args: &[&OsStr]) -> std::io::Result<()> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Detach: the child outlives the spawn; we never wait on it.
    let _child = cmd.spawn()?;
    Ok(())
}

struct ApplicationExecutor;

impl ApplicationExecutor {
    fn open(application: &str) -> ActionResult {
        let display = title_case(application);
        let Some((_entry, bin)) = find_app(application) else {
            return ActionResult::err("appNotFound", obj(&[("app", &display)]));
        };
        match spawn_detached(&bin, &[]) {
            Ok(()) => ActionResult::ok("openingApp", obj(&[("app", &display)])),
            Err(e) => {
                eprintln!("nila: jev: failed to launch {bin:?}: {e}");
                ActionResult::err("appLaunchFailed", obj(&[("app", &display)]))
            }
        }
    }

    /// Open a validated path in an allowlisted application. The path is
    /// passed as a single argv element — never a shell string.
    fn open_path(application: &str, path: &Path) -> ActionResult {
        let display = title_case(application);
        let Some((_entry, bin)) = find_app(application) else {
            return ActionResult::err("appNotFound", obj(&[("app", &display)]));
        };
        let name = path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("item")
            .to_string();
        match spawn_detached(&bin, &[path.as_os_str()]) {
            Ok(()) => ActionResult::ok(
                "openingInApp",
                obj(&[("app", &display), ("name", &name)]),
            ),
            Err(e) => {
                eprintln!("nila: jev: failed to launch {bin:?} with path: {e}");
                ActionResult::err("appLaunchFailed", obj(&[("app", &display)]))
            }
        }
    }

    fn close(application: &str) -> ActionResult {
        let display = title_case(application);
        let Some((_entry, bin)) = find_app(application) else {
            return ActionResult::err("appNotFound", obj(&[("app", &display)]));
        };
        let Some(pkill) = resolve_in_path("pkill") else {
            return ActionResult::err("appCloseUnsupported", obj(&[("app", &display)]));
        };
        // Exact process-name match only, on the allowlisted binary's own
        // file name. No shell, no pattern, no user text in the command.
        let proc_name = bin
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("");
        if proc_name.is_empty() {
            return ActionResult::err("appNotFound", obj(&[("app", &display)]));
        }
        match Command::new(&pkill)
            .arg("-x")
            .arg(proc_name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
        {
            Ok(out) if out.status.success() => {
                ActionResult::ok("closingApp", obj(&[("app", &display)]))
            }
            Ok(_) => ActionResult::err("appNotRunning", obj(&[("app", &display)])),
            Err(e) => {
                eprintln!("nila: jev: pkill failed: {e}");
                ActionResult::err("appCloseFailed", obj(&[("app", &display)]))
            }
        }
    }
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

// ---------------------------------------------------------------------------
// FileExecutor — bounded, shell-free filesystem search
// ---------------------------------------------------------------------------

/// Search roots: the user's own accessible locations. Never `/`.
fn search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home_dir() {
        roots.push(home.join("Documents"));
        roots.push(home.join("Downloads"));
        roots.push(home.join("Desktop"));
        roots.push(home);
    }
    roots.into_iter().filter(|p| p.is_dir()).collect()
}

const SEARCH_MAX_DEPTH: usize = 5;
const SEARCH_MAX_VISITED: usize = 50_000;
const SEARCH_DEADLINE: Duration = Duration::from_secs(8);
const SEARCH_MAX_HITS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchKind {
    NameContains,
    Extension,
    /// Match directory names instead of file names.
    DirNameContains,
    /// Match both files and directories in one walk; directory hits
    /// are preferred by the caller.
    EitherNameContains,
}

/// Strip "folder"/"file" kind words from a spoken target: "folder nila",
/// "nila folder" → "nila". Used by the intent parser and the executor's
/// target resolution.
pub(crate) fn strip_kind_word(s: &str) -> String {
    let s = s.trim();
    let s = s
        .strip_prefix("folder ")
        .or_else(|| s.strip_prefix("file "))
        .unwrap_or(s);
    let s = s
        .strip_suffix(" folder")
        .or_else(|| s.strip_suffix(" file"))
        .unwrap_or(s);
    s.trim().to_string()
}

struct FileExecutor;

impl FileExecutor {
    /// Walk the search roots with `std::fs` only. Symlinks are never
    /// followed (avoids loops and escapes). Stops at depth/visited
    /// count/deadline limits.
    fn search(kind: MatchKind, needle: &str) -> (Vec<SearchHit>, usize) {
        let deadline = Instant::now() + SEARCH_DEADLINE;
        let needle = needle.to_lowercase();
        let mut hits = Vec::new();
        let mut total = 0usize;
        let mut visited = 0usize;
        // (path, depth)
        let mut stack: Vec<(PathBuf, usize)> = search_roots().into_iter().map(|r| (r, 0)).collect();

        'outer: while let Some((dir, depth)) = stack.pop() {
            if Instant::now() > deadline || visited >= SEARCH_MAX_VISITED {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                if visited >= SEARCH_MAX_VISITED || Instant::now() > deadline {
                    break 'outer;
                }
                // symlink_metadata: never follow links.
                let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                if meta.file_type().is_symlink() {
                    continue;
                }
                let path = entry.path();
                if meta.is_dir() {
                    if depth < SEARCH_MAX_DEPTH {
                        stack.push((path.clone(), depth + 1));
                    }
                    if matches!(
                        kind,
                        MatchKind::DirNameContains | MatchKind::EitherNameContains
                    ) {
                        let name = entry.file_name().to_string_lossy().to_lowercase();
                        if name.contains(&needle) {
                            total += 1;
                            if hits.len() < SEARCH_MAX_HITS {
                                hits.push(SearchHit {
                                    name: entry.file_name().to_string_lossy().into_owned(),
                                    path,
                                    is_dir: true,
                                });
                            }
                        }
                    }
                    continue;
                }
                if !meta.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_lowercase();
                let matched = match kind {
                    MatchKind::NameContains | MatchKind::EitherNameContains => {
                        name.contains(&needle)
                    }
                    MatchKind::Extension => path
                        .extension()
                        .and_then(OsStr::to_str)
                        .map(|e| e.to_lowercase() == needle)
                        .unwrap_or(false),
                    // Directories are matched in the branch above.
                    MatchKind::DirNameContains => false,
                };
                if matched {
                    total += 1;
                    if hits.len() < SEARCH_MAX_HITS {
                        hits.push(SearchHit {
                            name: entry.file_name().to_string_lossy().into_owned(),
                            path,
                            is_dir: false,
                        });
                    }
                }
            }
        }
        // Most recently modified first — the file you mean is usually
        // the newest one.
        hits.sort_by_key(|h| {
            std::fs::metadata(&h.path)
                .and_then(|m| m.modified())
                .map(|t| std::cmp::Reverse(t))
                .unwrap_or(std::cmp::Reverse(std::time::SystemTime::UNIX_EPOCH))
        });
        (hits, total)
    }

    fn find(query: &str, ctx: &mut ConversationContext) -> ActionResult {
        let (hits, total) = Self::search(MatchKind::NameContains, query);
        ctx.remember_search(hits.clone());
        Self::search_result(query, &hits, total)
    }

    fn search_by_extension(extension: &str, ctx: &mut ConversationContext) -> ActionResult {
        let (hits, total) = Self::search(MatchKind::Extension, extension);
        ctx.remember_search(hits.clone());
        let label = format!(".{extension} files");
        Self::search_result(&label, &hits, total)
    }

    fn search_result(query: &str, hits: &[SearchHit], total: usize) -> ActionResult {
        if hits.is_empty() {
            return ActionResult::err("noFilesFound", obj(&[("query", query)]));
        }
        let files: Vec<serde_json::Value> = hits
            .iter()
            .map(|h| {
                serde_json::json!({
                    "name": h.name,
                    "path": h.path.to_string_lossy(),
                })
            })
            .collect();
        ActionResult::ok(
            "filesFound",
            serde_json::json!({ "query": query, "count": total }),
        )
        .with_data(serde_json::json!({ "files": files, "total": total }))
    }

    /// Open a file by search query (or "it" via context). Never opens
    /// during search — only on this explicit intent.
    fn open(query: &str, ctx: &mut ConversationContext) -> ActionResult {
        let path = if is_pronoun(query) {
            match ctx.resolve_it() {
                Some(p) => p,
                None => return ActionResult::err("noFileInContext", obj(&[])),
            }
        } else {
            let (hits, _) = Self::search(MatchKind::NameContains, query);
            match hits.into_iter().next() {
                Some(h) => h.path,
                None => return ActionResult::err("fileNotFound", obj(&[("query", query)])),
            }
        };
        // Validate: exists, is a file, inside the user's home.
        let valid = path.is_file() && within_home(&path);
        if !valid {
            return ActionResult::err("fileNotFound", obj(&[("query", query)]));
        }
        let name = path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("file")
            .to_string();
        ctx.remember_file(path.clone());
        match open_with_os(&path) {
            Ok(()) => ActionResult::ok("openingFile", obj(&[("name", &name)])),
            Err(e) => {
                eprintln!("nila: jev: open file failed: {e}");
                ActionResult::err("fileOpenFailed", obj(&[("name", &name)]))
            }
        }
    }

    /// Resolve a spoken target to a path: known folder → directory
    /// search (best hit) → file search (best hit). Folders win ties:
    /// "open X in an editor" usually means the project folder.
    fn resolve_target(query: &str) -> Option<PathBuf> {
        let q = strip_kind_word(query);
        if q.is_empty() {
            return None;
        }
        if let Some(d) = FolderExecutor::known_folder(&q) {
            if d.is_dir() {
                return Some(d);
            }
        }
        // One bounded walk for both; directory hits win.
        let (hits, _) = Self::search(MatchKind::EitherNameContains, &q);
        hits
            .iter()
            .find(|h| h.is_dir)
            .or_else(|| hits.first())
            .map(|h| h.path.clone())
    }

    /// Open a file or folder (by search query, or "it" via context) in
    /// a specific allowlisted application. The app is checked before
    /// the filesystem is touched; the path always comes from search
    /// results or known folders and is re-validated before launch.
    fn open_in_app(
        query: &str,
        application: &str,
        ctx: &mut ConversationContext,
    ) -> ActionResult {
        if find_app(application).is_none() {
            return ActionResult::err(
                "appNotFound",
                obj(&[("app", &title_case(application))]),
            );
        }
        let path = if is_pronoun(query) {
            match ctx.resolve_it() {
                Some(p) => p,
                None => return ActionResult::err("noFileInContext", obj(&[])),
            }
        } else {
            match Self::resolve_target(query) {
                Some(p) => p,
                None => return ActionResult::err("targetNotFound", obj(&[("query", query)])),
            }
        };
        // Validate: exists, inside the user's home. The path came from
        // search results, but re-check — the filesystem may have
        // changed since.
        if !path.exists() || !within_home(&path) {
            return ActionResult::err("targetNotFound", obj(&[("query", query)]));
        }
        ctx.remember_file(path.clone());
        ApplicationExecutor::open_path(application, &path)
    }
}

fn is_pronoun(query: &str) -> bool {
    matches!(query.trim().to_lowercase().as_str(), "it" | "that" | "that one")
}

/// Open a path with the OS default handler (`xdg-open` on Linux),
/// resolved via PATH. The path is a single validated argument —
/// never a shell string.
fn open_with_os(path: &Path) -> std::io::Result<()> {
    let opener = resolve_in_path("xdg-open").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "xdg-open not found")
    })?;
    spawn_detached(&opener, &[path.as_os_str()])
}

// ---------------------------------------------------------------------------
// FolderExecutor
// ---------------------------------------------------------------------------

struct FolderExecutor;

impl FolderExecutor {
    fn known_folder(query: &str) -> Option<PathBuf> {
        let home = home_dir()?;
        let q = query.trim().to_lowercase();
        let q = q.strip_suffix(" folder").unwrap_or(&q);
        let dir = match q {
            "downloads" => home.join("Downloads"),
            "documents" => home.join("Documents"),
            "desktop" => home.join("Desktop"),
            "pictures" | "photos" => home.join("Pictures"),
            "music" => home.join("Music"),
            "videos" => home.join("Videos"),
            "home" => home,
            _ => return None,
        };
        Some(dir)
    }

    fn open(query: &str) -> ActionResult {
        // Known folder names, or an absolute path under home.
        let dir = if let Some(d) = Self::known_folder(query) {
            d
        } else {
            let p = PathBuf::from(query.trim());
            if !(p.is_absolute() && p.is_dir() && within_home(&p)) {
                return ActionResult::err("folderNotFound", obj(&[("query", query)]));
            }
            p
        };
        if !dir.is_dir() {
            return ActionResult::err("folderNotFound", obj(&[("query", query)]));
        }
        let name = dir
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("folder")
            .to_string();
        match open_with_os(&dir) {
            Ok(()) => ActionResult::ok("openingFolder", obj(&[("name", &name)])),
            Err(e) => {
                eprintln!("nila: jev: open folder failed: {e}");
                ActionResult::err("folderOpenFailed", obj(&[("name", &name)]))
            }
        }
    }

    fn create(name: &str) -> ActionResult {
        // Name already validated by the schema (single segment, no
        // traversal). Parent is always the user's home.
        let Some(home) = home_dir() else {
            return ActionResult::err("folderCreateFailed", obj(&[("name", name)]));
        };
        let dir = home.join(name);
        if dir.is_dir() {
            return ActionResult::ok("folderExists", obj(&[("name", name)]));
        }
        match std::fs::create_dir_all(&dir) {
            Ok(()) => ActionResult::ok("folderCreated", obj(&[("name", name)])),
            Err(e) => {
                eprintln!("nila: jev: create folder failed: {e}");
                ActionResult::err("folderCreateFailed", obj(&[("name", name)]))
            }
        }
    }
}

/// True when the query names a known folder. Module-level (not an
/// associated fn on the private `FolderExecutor`) so the intent parser
/// can use it to tell "open downloads" (folder) from "open my resume"
/// (file).
pub(crate) fn is_known_folder(query: &str) -> bool {
    let q = query.trim().to_lowercase();
    let q = q.strip_suffix(" folder").unwrap_or(&q);
    matches!(
        q,
        "downloads"
            | "documents"
            | "desktop"
            | "pictures"
            | "photos"
            | "music"
            | "videos"
            | "home"
    )
}

// ---------------------------------------------------------------------------
// ReminderExecutor — on the existing SQLite reminder store
// ---------------------------------------------------------------------------

struct ReminderExecutor;

impl ReminderExecutor {
    fn set(
        app: &AppHandle,
        ctx: &mut ConversationContext,
        title: &str,
        at: &chrono::DateTime<chrono::Local>,
    ) -> ActionResult {
        let id = format!("r-jev-{}", chrono::Utc::now().timestamp_millis());
        let schedule = serde_json::json!({
            "type": "once",
            "at": at.to_rfc3339(),
        })
        .to_string();
        let reminder = db::Reminder {
            id: id.clone(),
            title: title.to_string(),
            message: title.to_string(),
            kind: "custom".to_string(),
            schedule,
            enabled: true,
        };
        let stored = (|| -> Result<(), String> {
            let state = app
                .try_state::<db::DbState>()
                .ok_or("reminder store unavailable")?;
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            db::upsert_reminder(&conn, &reminder).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match stored {
            Ok(()) => {
                scheduler::notify_data_changed(app);
                ctx.remember_reminder(id);
                ActionResult::ok(
                    "reminderSet",
                    serde_json::json!({
                        "title": title,
                        "at": at.format("%-I:%M %p").to_string(),
                    }),
                )
            }
            Err(e) => {
                eprintln!("nila: jev: set reminder failed: {e}");
                ActionResult::err("reminderSetFailed", obj(&[("title", title)]))
            }
        }
    }

    fn cancel(app: &AppHandle, ctx: &mut ConversationContext) -> ActionResult {
        let Some(id) = ctx.last_reminder.clone() else {
            return ActionResult::err("noReminderToCancel", obj(&[]));
        };
        let removed = (|| -> Result<(), String> {
            let state = app
                .try_state::<db::DbState>()
                .ok_or("reminder store unavailable")?;
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            // Only cancel if it's still there and enabled.
            match db::get_reminder(&conn, &id).map_err(|e| e.to_string())? {
                Some(_) => db::delete_reminder(&conn, &id).map_err(|e| e.to_string()),
                None => Err("already gone".to_string()),
            }
        })();
        match removed {
            Ok(()) => {
                scheduler::notify_data_changed(app);
                ctx.forget_reminder();
                ActionResult::ok("reminderCancelled", obj(&[]))
            }
            Err(_) => ActionResult::err("noReminderToCancel", obj(&[])),
        }
    }
}

// ---------------------------------------------------------------------------
// SystemExecutor — read-only system information
// ---------------------------------------------------------------------------

struct SystemExecutor;

impl SystemExecutor {
    fn info(metric: SystemMetric) -> ActionResult {
        match metric {
            SystemMetric::Ram => Self::ram(),
            SystemMetric::Cpu => Self::cpu(),
            SystemMetric::Disk => Self::disk(),
            SystemMetric::Battery => Self::battery(),
            SystemMetric::All => Self::all(),
        }
    }

    fn ram() -> ActionResult {
        let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let Some((total_kb, avail_kb)) = system_monitor::parse_meminfo(&meminfo) else {
            return ActionResult::err("systemInfoFailed", obj(&[("metric", "RAM")]));
        };
        let used_kb = total_kb.saturating_sub(avail_kb);
        let pct = if total_kb > 0 {
            (used_kb as f64 / total_kb as f64 * 100.0).round() as u64
        } else {
            0
        };
        ActionResult::ok(
            "ramUsage",
            serde_json::json!({
                "used_gb": format!("{:.1}", used_kb as f64 / 1_048_576.0),
                "total_gb": format!("{:.1}", total_kb as f64 / 1_048_576.0),
                "pct": pct,
            }),
        )
    }

    fn cpu() -> ActionResult {
        let sample = || {
            std::fs::read_to_string("/proc/stat")
                .ok()
                .and_then(|s| system_monitor::parse_cpu_times(&s))
        };
        let (Some(a), Some(b)) = (sample(), {
            std::thread::sleep(Duration::from_millis(400));
            sample()
        }) else {
            return ActionResult::err("systemInfoFailed", obj(&[("metric", "CPU")]));
        };
        match system_monitor::cpu_usage_percent(a, b) {
            Some(pct) => ActionResult::ok(
                "cpuUsage",
                serde_json::json!({ "pct": pct.round() as u64 }),
            ),
            None => ActionResult::err("systemInfoFailed", obj(&[("metric", "CPU")])),
        }
    }

    fn disk() -> ActionResult {
        match system_monitor::disk_usage("/") {
            Some((free_b, total_b)) => {
                let used_b = total_b.saturating_sub(free_b);
                let pct = if total_b > 0 {
                    (used_b as f64 / total_b as f64 * 100.0).round() as u64
                } else {
                    0
                };
                ActionResult::ok(
                    "diskUsage",
                    serde_json::json!({
                        "free_gb": format!("{:.1}", free_b as f64 / 1_073_741_824.0),
                        "total_gb": format!("{:.1}", total_b as f64 / 1_073_741_824.0),
                        "pct": pct,
                    }),
                )
            }
            None => ActionResult::err("systemInfoFailed", obj(&[("metric", "disk")])),
        }
    }

    fn battery() -> ActionResult {
        match system_monitor::read_battery() {
            Some((pct, discharging)) => ActionResult::ok(
                "batteryStatus",
                serde_json::json!({ "pct": pct, "discharging": discharging }),
            ),
            None => ActionResult::err("noBattery", obj(&[])),
        }
    }

    fn all() -> ActionResult {
        // Compose from the individual readers; each degrades on its own.
        let mut parts = serde_json::Map::new();
        for (key, r) in [
            ("ram", Self::ram()),
            ("cpu", Self::cpu()),
            ("disk", Self::disk()),
            ("battery", Self::battery()),
        ] {
            if r.status == ActionStatus::Success {
                parts.insert(key.to_string(), r.response_params);
            }
        }
        ActionResult {
            status: ActionStatus::Success,
            response_key: "systemSummary",
            response_params: serde_json::Value::Object(parts),
            data: None,
        }
    }
}

// ---------------------------------------------------------------------------
// ActionExecutor — the single entry point
// ---------------------------------------------------------------------------

pub struct ActionExecutor;

impl ActionExecutor {
    /// Execute a validated action. Runs on a background thread (the
    /// service spawns one per command); never on the Tauri/UI thread.
    pub fn execute(
        app: &AppHandle,
        ctx: &mut ConversationContext,
        action: ValidatedAction,
    ) -> ActionResult {
        match action {
            ValidatedAction::OpenApplication { application } => {
                let r = ApplicationExecutor::open(&application);
                if r.status == ActionStatus::Success {
                    ctx.remember_application(application);
                }
                r
            }
            ValidatedAction::CloseApplication { application } => {
                ApplicationExecutor::close(&application)
            }
            ValidatedAction::FindFile { query } => FileExecutor::find(&query, ctx),
            ValidatedAction::SearchFiles { extension } => {
                FileExecutor::search_by_extension(&extension, ctx)
            }
            ValidatedAction::OpenFile { query } => FileExecutor::open(&query, ctx),
            ValidatedAction::OpenInApplication { query, application } => {
                FileExecutor::open_in_app(&query, &application, ctx)
            }
            ValidatedAction::OpenFolder { query } => FolderExecutor::open(&query),
            ValidatedAction::CreateFolder { name } => FolderExecutor::create(&name),
            ValidatedAction::SetReminder { title, at } => {
                ReminderExecutor::set(app, ctx, &title, &at)
            }
            ValidatedAction::CancelReminder => ReminderExecutor::cancel(app, ctx),
            ValidatedAction::SystemInfo { metric } => SystemExecutor::info(metric),
            ValidatedAction::Cancel => ActionResult::ok("okayCancelled", obj(&[])),
            ValidatedAction::Unknown => ActionResult::err("unknownCommand", obj(&[])),
            // Conversation and UI actions are routed before the
            // executor; reaching here means a routing bug. Never
            // execute — degrade to unknown.
            ValidatedAction::Conversation { .. }
            | ValidatedAction::UiNewReminder { .. }
            | ValidatedAction::UiShowReminders
            | ValidatedAction::UiOpenSettings
            | ValidatedAction::UiHelp => {
                ActionResult::err("unknownCommand", obj(&[]))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_app_is_never_launched() {
        // Not in the registry → error, no process spawned.
        let r = ApplicationExecutor::open("definitely-not-a-real-app-xyz");
        assert_eq!(r.status, ActionStatus::Error);
        assert_eq!(r.response_key, "appNotFound");
    }

    #[test]
    fn registry_lookup_never_panics_on_hostile_input() {
        // Hostile strings must not match and must not panic.
        assert!(find_app("firefox; rm -rf ~").is_none());
        assert!(find_app("fire").is_none());
        assert!(find_app("").is_none());
    }

    #[test]
    fn path_resolution_rejects_separators() {
        assert!(resolve_in_path("a/b").is_none());
        assert!(resolve_in_path("").is_none());
    }

    #[test]
    fn folder_open_rejects_outside_home() {
        let r = FolderExecutor::open("/etc");
        assert_eq!(r.status, ActionStatus::Error);
        assert_eq!(r.response_key, "folderNotFound");
    }

    #[test]
    fn folder_open_rejects_nonexistent() {
        let r = FolderExecutor::open("/home/definitely-not-here-xyz-123");
        assert_eq!(r.status, ActionStatus::Error);
    }

    #[test]
    fn search_roots_never_include_filesystem_root() {
        for r in search_roots() {
            assert_ne!(r, PathBuf::from("/"));
            assert!(r.starts_with(home_dir().unwrap()));
        }
    }

    #[test]
    fn open_in_app_rejects_unknown_app_first() {
        // The app is checked before the filesystem is touched: no
        // search runs, no process spawns.
        let mut ctx = ConversationContext::default();
        let r = FileExecutor::open_in_app("nila", "definitely-not-a-real-app-xyz", &mut ctx);
        assert_eq!(r.status, ActionStatus::Error);
        assert_eq!(r.response_key, "appNotFound");
    }

    #[test]
    fn open_path_rejects_unknown_app() {
        let r = ApplicationExecutor::open_path(
            "definitely-not-a-real-app-xyz",
            Path::new("/home/user/nila"),
        );
        assert_eq!(r.status, ActionStatus::Error);
        assert_eq!(r.response_key, "appNotFound");
    }

    #[test]
    fn kind_word_stripping() {
        assert_eq!(strip_kind_word("folder nila"), "nila");
        assert_eq!(strip_kind_word("nila folder"), "nila");
        assert_eq!(strip_kind_word("file report"), "report");
        assert_eq!(strip_kind_word("report file"), "report");
        assert_eq!(strip_kind_word("folder"), "folder");
        assert_eq!(strip_kind_word(""), "");
    }

    #[test]
    fn pronoun_detection() {
        assert!(is_pronoun("it"));
        assert!(is_pronoun("That"));
        assert!(!is_pronoun("resume"));
    }
}
