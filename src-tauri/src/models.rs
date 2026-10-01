//! Manual model provisioning for the local voice pipeline.
//!
//! The STT models (~80 MB: INT8 Conformer-CTC + tokens + Silero VAD) are
//! NOT shipped with the app and NOT committed to the repo. The user
//! downloads them once, manually, from Settings — the download option
//! only appears when the wake word is enabled — into the per-user app
//! data dir (`~/.local/share/nila/models/stt/` on Linux). Nila reuses
//! them across restarts and updates, and works fine without them: a
//! wake with no models present just points the user at Settings instead
//! of transcribing. Nothing downloads automatically.
//!
//! [`download_in_background`] runs the one-time fetch on a worker thread
//! (triggered by the `download_stt_models` command), reporting progress
//! on `nila://models-downloading` for the settings UI.
//!
//! Developers can still point at local files with `NILA_STT_MODEL_DIR`
//! (or the per-file `NILA_STT_MODEL` / `NILA_STT_TOKENS` /
//! `NILA_STT_VAD_MODEL`); explicit env paths always win and skip the
//! download entirely.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// Frontend event: model download progress. Payload
/// [`DownloadProgressPayload`]. Only emitted while a manual download
/// from Settings is actually running.
pub const EVENT_MODELS_DOWNLOADING: &str = "nila://models-downloading";
/// Frontend event: all voice models are present and verified.
pub const EVENT_MODELS_READY: &str = "nila://models-ready";
/// Frontend event: the download failed. Payload [`ModelsErrorPayload`].
pub const EVENT_MODELS_ERROR: &str = "nila://models-error";

/// Env var overriding the STT model directory (contains
/// `model.int8.onnx`, `tokens.txt`, `silero_vad.onnx`).
const ENV_MODEL_DIR: &str = "NILA_STT_MODEL_DIR";
/// Env vars overriding individual model files.
const ENV_MODEL: &str = "NILA_STT_MODEL";
const ENV_TOKENS: &str = "NILA_STT_TOKENS";
const ENV_VAD_MODEL: &str = "NILA_STT_VAD_MODEL";

pub const MODEL_FILE: &str = "model.int8.onnx";
pub const TOKENS_FILE: &str = "tokens.txt";
pub const VAD_FILE: &str = "silero_vad.onnx";

/// Upstream release assets (verified 2026-10-01).
const ASR_TARBALL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2";
const VAD_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

/// How long a single download may take overall (slow connections happen;
/// the 76 MB tarball is the big one).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

/// Serializes concurrent downloads (the launch-time background fetch and
/// a first-wake blocking ensure): whoever gets the lock downloads, the
/// other waits and then finds the models ready.
static DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());

/// Payload for [`EVENT_MODELS_DOWNLOADING`]. `total_bytes` is 0 when the
/// server didn't report a length.
#[derive(Clone, serde::Serialize)]
pub struct DownloadProgressPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub file: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

/// Payload for [`EVENT_MODELS_ERROR`].
#[derive(Clone, serde::Serialize)]
pub struct ModelsErrorPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub message: String,
}

/// Where downloaded models live: `<app-data>/models/stt/`
/// (`~/.local/share/nila/models/stt/` on Linux).
pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("models").join("stt"))
}

/// Directories searched for a complete model set, in order.
fn search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(v) = std::env::var(ENV_MODEL_DIR) {
        let p = PathBuf::from(v.trim());
        if p.is_dir() {
            return vec![p];
        }
        eprintln!(
            "nila: models: {ENV_MODEL_DIR}='{}' is not a directory",
            p.display()
        );
    }
    // The manual download target (preferred).
    if let Ok(d) = dir(app) {
        dirs.push(d);
    }
    // Dev fallbacks: next to the working directory / executable
    // (covers `cargo run` and `tauri dev`).
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("models").join("stt"));
        if let Some(parent) = cwd.parent() {
            dirs.push(parent.join("models").join("stt"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("models").join("stt"));
        }
    }
    dirs
}

/// Resolve one model file: the explicit env var wins on its own;
/// anything unset falls back to `dir/name`. A var that is set but points
/// at a missing file is a hard miss (fail fast instead of silently using
/// a different model).
fn resolve_one_file(env: &str, name: &str, dir: Option<&Path>) -> Option<PathBuf> {
    match std::env::var(env) {
        Ok(v) => {
            let p = PathBuf::from(v.trim());
            if p.is_file() {
                Some(p)
            } else {
                eprintln!(
                    "nila: models: {env} points at missing file '{}'",
                    p.display()
                );
                None
            }
        }
        Err(_) => dir.map(|d| d.join(name)),
    }
}

/// Resolve the three model files: `NILA_STT_MODEL_DIR` (or the first
/// complete `models/stt/` found by [`search_dirs`]) supplies the
/// defaults, and [`ENV_MODEL`]/[`ENV_TOKENS`]/[`ENV_VAD_MODEL`] each
/// override their own file independently.
pub fn resolve_models(app: &AppHandle) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let found = search_dirs(app).into_iter().find(|d| {
        d.join(MODEL_FILE).is_file()
            && d.join(TOKENS_FILE).is_file()
            && d.join(VAD_FILE).is_file()
    });
    let dir = found.as_deref();
    match (
        resolve_one_file(ENV_MODEL, MODEL_FILE, dir),
        resolve_one_file(ENV_TOKENS, TOKENS_FILE, dir),
        resolve_one_file(ENV_VAD_MODEL, VAD_FILE, dir),
    ) {
        (Some(model), Some(tokens), Some(vad)) => Some((model, tokens, vad)),
        _ => None,
    }
}

/// Start the one-time model download in the background. Called only
/// from the manual `download_stt_models` command (Settings) — nothing
/// in the app triggers a download on its own. No-op when the models are
/// already present. Failures are reported on [`EVENT_MODELS_ERROR`].
pub fn download_in_background(app: AppHandle) {
    std::thread::Builder::new()
        .name("nila-models-download".into())
        .spawn(move || {
            if let Err(e) = ensure_blocking(&app) {
                eprintln!("nila: models: background download failed: {e}");
                emit(
                    &app,
                    EVENT_MODELS_ERROR,
                    ModelsErrorPayload {
                        kind: "nila://models-error",
                        message: e,
                    },
                );
            }
        })
        .expect("failed to spawn model download thread");
}

/// Make sure the models exist, downloading them when this is a manual
/// settings-driven fetch. Serialized against concurrent callers; emits
/// [`EVENT_MODELS_DOWNLOADING`] progress and [`EVENT_MODELS_READY`] on
/// success.
pub fn ensure_blocking(app: &AppHandle) -> Result<(), String> {
    let _guard = DOWNLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if resolve_models(app).is_some() {
        return Ok(());
    }
    eprintln!("nila: models: downloading voice models (~80 MB, one time)");
    let dir = dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    // VAD first: small, validates the whole pipeline quickly.
    download_file(app, VAD_URL, &dir.join(VAD_FILE), VAD_FILE)?;
    download_asr_tarball(app, &dir)?;

    match resolve_models(app) {
        Some(_) => {
            eprintln!("nila: models: ready");
            emit(
                app,
                EVENT_MODELS_READY,
                serde_json::json!({"type": "nila://models-ready"}),
            );
            Ok(())
        }
        _ => Err("download finished but the model files are still missing".to_string()),
    }
}

/// Stream `url` to `dest` (via a `.part` file, renamed on success),
/// emitting progress events as it goes. A failed download never leaves a
/// half-written file behind.
fn download_file(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    label: &'static str,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("download {label}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("download {label}: HTTP {status}"));
    }
    let total = resp.content_length().unwrap_or(0);
    let part = dest.with_extension("part");
    let mut file =
        std::fs::File::create(&part).map_err(|e| format!("create {}: {e}", part.display()))?;
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    loop {
        match resp
            .chunk()
            .map_err(|e| format!("download {label}: {e}"))?
        {
            Some(bytes) => {
                file.write_all(&bytes)
                    .map_err(|e| format!("write {}: {e}", part.display()))?;
                downloaded += bytes.len() as u64;
                if last_emit.elapsed() >= Duration::from_millis(500) {
                    last_emit = Instant::now();
                    emit_progress(app, label, downloaded, total);
                }
            }
            None => break,
        }
    }
    emit_progress(app, label, downloaded, total);
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| format!("rename {}: {e}", part.display()))?;
    eprintln!("nila: models: downloaded {label} ({downloaded} bytes)");
    Ok(())
}

/// Download the Conformer-CTC tarball and extract just `model.int8.onnx`
/// + `tokens.txt` into `dir` (the full-precision model, test wavs and
/// scripts are skipped).
fn download_asr_tarball(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let tarball = std::env::temp_dir().join("nila-stt-asr.tar.bz2");
    download_file(app, ASR_TARBALL_URL, &tarball, MODEL_FILE)?;
    let result = extract_asr_tarball(&tarball, dir);
    // Never keep a tarball we couldn't use: the next launch re-downloads.
    std::fs::remove_file(&tarball).ok();
    result
}

fn extract_asr_tarball(tarball: &Path, dir: &Path) -> Result<(), String> {
    // Only the two files we need, matched by file name so the tarball's
    // top-level directory prefix doesn't matter. Destinations are fully
    // controlled — no path-traversal risk from archive members.
    let mut found_model = false;
    let mut found_tokens = false;
    let file =
        std::fs::File::open(tarball).map_err(|e| format!("open {}: {e}", tarball.display()))?;
    let decoder = bzip2::read::BzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().map_err(|e| format!("read tarball: {e}"))? {
        let mut entry = entry.map_err(|e| format!("read tarball entry: {e}"))?;
        let name = entry
            .path()
            .map_err(|e| format!("tarball entry path: {e}"))?
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let dest = match wanted_entry(&name) {
            Some(MODEL_FILE) => {
                found_model = true;
                dir.join(MODEL_FILE)
            }
            Some(TOKENS_FILE) => {
                found_tokens = true;
                dir.join(TOKENS_FILE)
            }
            _ => continue,
        };
        // Read the entry ourselves and write it to the controlled
        // destination (avoids `unpack` path semantics entirely).
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf)
            .map_err(|e| format!("extract {name}: {e}"))?;
        std::fs::write(&dest, &buf).map_err(|e| format!("write {}: {e}", dest.display()))?;
    }
    if !(found_model && found_tokens) {
        return Err("tarball didn't contain model.int8.onnx and tokens.txt".to_string());
    }
    let size = std::fs::metadata(dir.join(MODEL_FILE))
        .map_err(|e| format!("stat model: {e}"))?
        .len();
    if size < 10_000_000 {
        return Err(format!(
            "extracted model is only {size} bytes — corrupt download?"
        ));
    }
    Ok(())
}

/// Which tarball members we keep. Everything else (full-precision model,
/// test wavs, scripts, READMEs) is skipped.
fn wanted_entry(file_name: &str) -> Option<&'static str> {
    match file_name {
        n if n == MODEL_FILE => Some(MODEL_FILE),
        n if n == TOKENS_FILE => Some(TOKENS_FILE),
        _ => None,
    }
}

fn emit_progress(app: &AppHandle, file: &'static str, downloaded_bytes: u64, total_bytes: u64) {
    emit(
        app,
        EVENT_MODELS_DOWNLOADING,
        DownloadProgressPayload {
            kind: "nila://models-downloading",
            file,
            downloaded_bytes,
            total_bytes,
        },
    );
}

fn emit(app: &AppHandle, event: &str, payload: impl serde::Serialize) {
    if let Err(e) = app.emit(event, payload) {
        eprintln!("nila: models: failed to emit {event}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tarball_entry_matching_ignores_directory_prefix() {
        assert_eq!(wanted_entry("model.int8.onnx"), Some(MODEL_FILE));
        assert_eq!(wanted_entry("tokens.txt"), Some(TOKENS_FILE));
        // Everything else in the tarball is skipped.
        assert_eq!(wanted_entry("model.onnx"), None);
        assert_eq!(wanted_entry("README.md"), None);
        assert_eq!(wanted_entry("1.wav"), None);
        assert_eq!(wanted_entry(""), None);
    }

    #[test]
    fn resolve_one_file_env_wins_independently() {
        let tmp = std::env::temp_dir().join("nila-models-test-resolve");
        std::fs::create_dir_all(&tmp).unwrap();
        let custom = tmp.join("custom-model.onnx");
        let dir_model = tmp.join("model.int8.onnx");
        std::fs::write(&custom, b"fake").unwrap();
        std::fs::write(&dir_model, b"fake").unwrap();

        // A set var wins over the directory, on its own.
        std::env::set_var("NILA_MODELS_TEST_MODEL", custom.to_str().unwrap());
        let got = resolve_one_file("NILA_MODELS_TEST_MODEL", "model.int8.onnx", Some(&tmp));
        assert_eq!(got, Some(custom.clone()));

        // An unset var falls back to the directory.
        std::env::remove_var("NILA_MODELS_TEST_TOKENS");
        let got = resolve_one_file("NILA_MODELS_TEST_TOKENS", "model.int8.onnx", Some(&tmp));
        assert_eq!(got, Some(dir_model.clone()));

        // A set-but-missing path is a hard miss, not a silent fallback.
        std::env::set_var(
            "NILA_MODELS_TEST_VAD",
            tmp.join("nope.onnx").to_str().unwrap(),
        );
        let got = resolve_one_file("NILA_MODELS_TEST_VAD", "silero_vad.onnx", Some(&tmp));
        assert_eq!(got, None);

        std::env::remove_var("NILA_MODELS_TEST_MODEL");
        std::env::remove_var("NILA_MODELS_TEST_VAD");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn download_progress_payload_shape() {
        let p = DownloadProgressPayload {
            kind: "nila://models-downloading",
            file: "model.int8.onnx",
            downloaded_bytes: 42,
            total_bytes: 100,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["type"], "nila://models-downloading");
        assert_eq!(v["file"], "model.int8.onnx");
        assert_eq!(v["downloaded_bytes"], 42);
        assert_eq!(v["total_bytes"], 100);
    }
}
