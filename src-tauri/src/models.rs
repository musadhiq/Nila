//! Manual model provisioning for the local voice pipeline.
//!
//! The STT models (~160 MB: INT8 Whisper base.en encoder+decoder +
//! tokens + Silero VAD) are NOT shipped with the app and NOT committed to the repo. The user
//! downloads them once, manually, from Settings — the download option
//! only appears when the wake word is enabled — into the per-user app
//! data dir (`~/.local/share/nila/models/stt/` on Linux). Nila reuses
//! them across restarts and updates, and works fine without them: a
//! wake with no models present just points the user at Settings instead
//! of transcribing. Nothing downloads automatically.
//!
//! The [`ModelManager`] is the single place that knows where model
//! files live and what state they are in:
//!
//! ```text
//! ModelManager
//! ├── is_installed()   — files present AND verified
//! ├── get_status()     — NotInstalled / Downloading / Installed (+ error)
//! ├── download()       — blocking manual fetch with progress events
//! ├── download_in_background()
//! ├── verify()         — size/shape sanity before a set counts as installed
//! ├── delete()         — remove the managed files (never env overrides)
//! ├── get_path()       — the app-managed model directory
//! └── get_size()       — total bytes of the installed set
//! ```
//!
//! Downloads are staged: every file lands as a `.part` file first and
//! is atomically renamed only after it verifies. An interrupted
//! download (or an interrupted extraction) can therefore never leave a
//! half-written file that counts as installed. Stale `.part` files are
//! cleaned at the start of each download.
//!
//! Developers can still point at local files with `NILA_STT_MODEL_DIR`
//! (or the per-file `NILA_STT_MODEL` / `NILA_STT_TOKENS` /
//! `NILA_STT_VAD_MODEL`); explicit env paths always win and skip the
//! download entirely. `delete()` never touches env-pointed files.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
/// `whisper-encoder.int8.onnx`, `whisper-decoder.int8.onnx`,
/// `tokens.txt`, `silero_vad.onnx`).
const ENV_MODEL_DIR: &str = "NILA_STT_MODEL_DIR";
/// Env vars overriding individual model files.
const ENV_ENCODER: &str = "NILA_STT_ENCODER";
const ENV_DECODER: &str = "NILA_STT_DECODER";
const ENV_TOKENS: &str = "NILA_STT_TOKENS";
const ENV_VAD_MODEL: &str = "NILA_STT_VAD_MODEL";

/// Canonical local file names (the tarball's upstream names are
/// normalized to these on extraction).
pub const ENCODER_FILE: &str = "whisper-encoder.int8.onnx";
pub const DECODER_FILE: &str = "whisper-decoder.int8.onnx";
pub const TOKENS_FILE: &str = "tokens.txt";
pub const VAD_FILE: &str = "silero_vad.onnx";
/// Legacy Conformer-CTC model file (pre-Whisper). Removed on the next
/// successful download or explicit delete so it doesn't sit orphaned.
const LEGACY_MODEL_FILE: &str = "model.int8.onnx";

/// Upstream release assets (verified 2026-10-02). Whisper base.en was
/// chosen over the Conformer-CTC small model for its far better
/// handling of Indian English accents (trained on 680k hours of
/// diverse multilingual audio vs. LibriSpeech audiobooks).
const ASR_TARBALL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2";
const VAD_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

/// How long a single download may take overall (slow connections happen;
/// the 208 MB tarball is the big one).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(3600);

/// Verification floors/ceilings (k2-fsa/sherpa-onnx `asr-models`
/// release, checked 2026-10-02: encoder 29,120,534 bytes, decoder
/// 130,669,978 bytes, VAD 643,854 bytes). A truncated or wrong file
/// fails these and never counts as installed; the real check — loading
/// the model — happens on first wake, which surfaces `model_error` if
/// the bytes are corrupt.
const EXPECTED_ENCODER_MIN_BYTES: u64 = 20_000_000; // real file is ~29 MB
const EXPECTED_DECODER_MIN_BYTES: u64 = 100_000_000; // real file is ~130 MB
const EXPECTED_VAD_MIN_BYTES: u64 = 600_000; // real file is 643,854 bytes
const EXPECTED_TOKENS_MAX_BYTES: u64 = 2_000_000; // real file is 835,554 bytes

/// Serializes concurrent downloads: whoever gets the lock downloads,
/// the other waits and then finds the models ready.
static DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());
/// True while a download thread is actively fetching.
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
/// The last download failure, if any (surfaced via [`ModelManager::get_status`]).
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

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

/// The four model files, in load order.
#[derive(Clone, Debug)]
pub struct ModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub tokens: PathBuf,
    pub vad: PathBuf,
}

/// Lifecycle state of the STT model set. "Update available" is not
/// supported: the upstream release is pinned, so there is nothing to
/// check against.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    NotInstalled,
    Downloading,
    Installed,
}

/// What Settings shows: status, size when installed, and the last
/// download error (if any) so failures are visible without re-running.
#[derive(Clone, serde::Serialize)]
pub struct ModelInfo {
    pub status: ModelStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The single owner of model lifecycle knowledge. The voice pipeline
/// asks the manager for paths; it never locates files itself.
pub struct ModelManager {
    app: AppHandle,
}

impl ModelManager {
    pub fn new(app: &AppHandle) -> Self {
        Self { app: app.clone() }
    }

    /// The app-managed directory downloads go to. Never the
    /// source/project directory.
    pub fn get_path(&self) -> Result<PathBuf, String> {
        dir(&self.app)
    }

    /// The installed file set, if every file resolves.
    pub fn resolve(&self) -> Option<ModelPaths> {
        resolve_models(&self.app)
            .map(|(encoder, decoder, tokens, vad)| ModelPaths { encoder, decoder, tokens, vad })
    }

    /// True only when the files resolve AND pass verification. A
    /// half-written or truncated set never counts as installed.
    pub fn is_installed(&self) -> bool {
        self.verify().is_ok()
    }

    /// Verify a resolved set: every file exists and has a sane size.
    /// Returns the paths on success.
    pub fn verify(&self) -> Result<ModelPaths, String> {
        let paths = self
            .resolve()
            .ok_or_else(|| "STT model files are missing".to_string())?;
        verify_paths(&paths)?;
        Ok(paths)
    }

    /// Total bytes of the installed set, for the Settings UI.
    pub fn get_size(&self) -> Option<u64> {
        let paths = self.resolve()?;
        let total = [paths.encoder, paths.decoder, paths.tokens, paths.vad]
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum();
        Some(total)
    }

    /// Snapshot for Settings: NotInstalled / Downloading / Installed,
    /// plus size and the last download error.
    pub fn get_status(&self) -> ModelInfo {
        let downloading = DOWNLOADING.load(Ordering::SeqCst);
        let status = if downloading {
            ModelStatus::Downloading
        } else if self.is_installed() {
            ModelStatus::Installed
        } else {
            ModelStatus::NotInstalled
        };
        let error = LAST_ERROR.lock().ok().and_then(|g| g.clone());
        ModelInfo {
            status,
            size_bytes: if status == ModelStatus::Installed {
                self.get_size()
            } else {
                None
            },
            // A stale error from an old attempt shouldn't linger once the
            // models are actually installed.
            error: if status == ModelStatus::Installed {
                None
            } else {
                error
            },
        }
    }

    /// Blocking manual download (Settings → Download). Serialized;
    /// no-op when the models are already installed and verified. Emits
    /// [`EVENT_MODELS_DOWNLOADING`] progress and [`EVENT_MODELS_READY`]
    /// on success, [`EVENT_MODELS_ERROR`] on failure.
    pub fn download(&self) -> Result<(), String> {
        let _guard = DOWNLOAD_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.is_installed() {
            eprintln!("nila: models: already installed and verified — skipping download");
            return Ok(());
        }
        DOWNLOADING.store(true, Ordering::SeqCst);
        if let Ok(mut last) = LAST_ERROR.lock() {
            last.take();
        }
        let result = self.download_locked();
        DOWNLOADING.store(false, Ordering::SeqCst);
        if let Err(e) = &result {
            eprintln!("nila: models: download failed: {e}");
            *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
            emit(
                &self.app,
                EVENT_MODELS_ERROR,
                ModelsErrorPayload {
                    kind: "nila://models-error",
                    message: e.clone(),
                },
            );
        }
        result
    }

    /// The actual fetch. The caller holds [`DOWNLOAD_LOCK`].
    fn download_locked(&self) -> Result<(), String> {
        eprintln!("nila: models: downloading voice models (~80 MB, one time)");
        let dir = self.get_path()?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        // A previous interrupted run may have left `.part` files behind;
        // they are stale by definition (a good file is renamed away).
        clean_stale_parts(&dir);

        // VAD first: small, validates the whole pipeline quickly.
        download_file(&self.app, VAD_URL, &dir.join(VAD_FILE), VAD_FILE)?;
        download_asr_tarball(&self.app, &dir)?;

        match self.verify() {
            Ok(_) => {
                eprintln!("nila: models: ready");
                emit(
                    &self.app,
                    EVENT_MODELS_READY,
                    serde_json::json!({"type": "nila://models-ready"}),
                );
                Ok(())
            }
            Err(e) => Err(format!("download finished but verification failed: {e}")),
        }
    }

    /// Start the one-time model download in the background. Called only
    /// from the manual `download_stt_models` command (Settings) —
    /// nothing in the app triggers a download on its own. No-op when a
    /// download is already running or the models are installed.
    pub fn download_in_background(&self) {
        if DOWNLOADING.load(Ordering::SeqCst) {
            eprintln!("nila: models: download already running");
            return;
        }
        if self.is_installed() {
            return;
        }
        let mgr = ModelManager::new(&self.app);
        std::thread::Builder::new()
            .name("nila-models-download".into())
            .spawn(move || {
                if let Err(e) = mgr.download() {
                    eprintln!("nila: models: background download failed: {e}");
                }
            })
            .expect("failed to spawn model download thread");
    }

    /// Delete the downloaded model files from the app-managed
    /// directory. Env-override paths are NEVER touched: if the models
    /// resolve outside the managed dir there is nothing to delete.
    /// Returns true when at least one file was removed.
    pub fn delete(&self) -> Result<bool, String> {
        let dir = self.get_path()?;
        let mut removed = false;
        for name in [ENCODER_FILE, DECODER_FILE, TOKENS_FILE, VAD_FILE, LEGACY_MODEL_FILE] {
            let p = dir.join(name);
            // Only files inside the managed dir, never env overrides.
            if p.is_file() {
                std::fs::remove_file(&p).map_err(|e| format!("delete {}: {e}", p.display()))?;
                removed = true;
            }
            // A stale `.part` next to it goes too.
            let part = p.with_extension("part");
            if part.is_file() {
                std::fs::remove_file(&part).ok();
            }
        }
        if removed {
            eprintln!("nila: models: deleted downloaded models from {}", dir.display());
        }
        Ok(removed)
    }
}

fn file_len(p: &Path) -> Result<u64, String> {
    std::fs::metadata(p)
        .map(|m| m.len())
        .map_err(|e| format!("stat {}: {e}", p.display()))
}

/// Size/shape sanity for a resolved model set. Pure function over
/// paths so it is unit-testable without a Tauri [`AppHandle`].
fn verify_paths(paths: &ModelPaths) -> Result<(), String> {
    let encoder_len = file_len(&paths.encoder)?;
    let decoder_len = file_len(&paths.decoder)?;
    let vad_len = file_len(&paths.vad)?;
    let tokens_len = file_len(&paths.tokens)?;
    if encoder_len < EXPECTED_ENCODER_MIN_BYTES {
        return Err(format!(
            "whisper-encoder.int8.onnx is only {encoder_len} bytes — incomplete download?"
        ));
    }
    if decoder_len < EXPECTED_DECODER_MIN_BYTES {
        return Err(format!(
            "whisper-decoder.int8.onnx is only {decoder_len} bytes — incomplete download?"
        ));
    }
    if vad_len < EXPECTED_VAD_MIN_BYTES {
        return Err(format!(
            "silero_vad.onnx is only {vad_len} bytes — incomplete download?"
        ));
    }
    if tokens_len == 0 || tokens_len > EXPECTED_TOKENS_MAX_BYTES {
        return Err(format!(
            "tokens.txt has an unexpected size ({tokens_len} bytes)"
        ));
    }
    Ok(())
}

/// Remove stale `.part` staging files left by an interrupted download.
fn clean_stale_parts(dir: &Path) {
    for name in [ENCODER_FILE, DECODER_FILE, TOKENS_FILE, VAD_FILE] {
        let part = dir.join(name).with_extension("part");
        if part.is_file() {
            eprintln!("nila: models: removing stale {}", part.display());
            std::fs::remove_file(&part).ok();
        }
    }
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
///
/// Prefer [`ModelManager::verify`] when "installed" must mean "usable":
/// this only checks presence, not integrity.
pub fn resolve_models(app: &AppHandle) -> Option<(PathBuf, PathBuf, PathBuf, PathBuf)> {
    let found = search_dirs(app).into_iter().find(|d| {
        d.join(ENCODER_FILE).is_file()
            && d.join(DECODER_FILE).is_file()
            && d.join(TOKENS_FILE).is_file()
            && d.join(VAD_FILE).is_file()
    });
    let dir = found.as_deref();
    match (
        resolve_one_file(ENV_ENCODER, ENCODER_FILE, dir),
        resolve_one_file(ENV_DECODER, DECODER_FILE, dir),
        resolve_one_file(ENV_TOKENS, TOKENS_FILE, dir),
        resolve_one_file(ENV_VAD_MODEL, VAD_FILE, dir),
    ) {
        (Some(encoder), Some(decoder), Some(tokens), Some(vad)) => {
            Some((encoder, decoder, tokens, vad))
        }
        _ => None,
    }
}

/// Start the one-time model download in the background. Called only
/// from the manual `download_stt_models` command (Settings) — nothing
/// in the app triggers a download on its own. No-op when the models are
/// already present. Failures are reported on [`EVENT_MODELS_ERROR`].
pub fn download_in_background(app: AppHandle) {
    ModelManager::new(&app).download_in_background();
}

/// Make sure the models exist, downloading them when this is a manual
/// settings-driven fetch. Serialized against concurrent callers; emits
/// [`EVENT_MODELS_DOWNLOADING`] progress and [`EVENT_MODELS_READY`] on
/// success.
pub fn ensure_blocking(app: &AppHandle) -> Result<(), String> {
    ModelManager::new(app).download()
}

/// Stream `url` to `dest` (via a `.part` staging file, atomically
/// renamed on success), emitting progress events as it goes. A failed
/// or interrupted download never leaves a half-written file behind —
/// the `.part` is removed on error and cleaned at the next start.
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
    // `blocking::Response` implements `std::io::Read`: stream the body
    // in chunks so progress stays live on large model files.
    let mut buf = [0u8; 32 * 1024];
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("download {label}: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("write {}: {e}", part.display()))?;
        downloaded += n as u64;
        if last_emit.elapsed() >= Duration::from_millis(500) {
            last_emit = Instant::now();
            emit_progress(app, label, downloaded, total);
        }
    }
    emit_progress(app, label, downloaded, total);
    drop(file);
    // `verify()` runs after the whole set lands; the rename itself is
    // the atomic commit point — an interrupted download leaves only the
    // `.part`, which never counts as installed.
    std::fs::rename(&part, dest).map_err(|e| format!("rename {}: {e}", part.display()))?;
    eprintln!("nila: models: downloaded {label} ({downloaded} bytes)");
    Ok(())
}

/// Download the Whisper base.en tarball and extract just the INT8
/// `*-encoder.int8.onnx`, `*-decoder.int8.onnx` + `*-tokens.txt` (the
/// full-precision models, test wavs and scripts are skipped). The
/// tarball itself goes to the OS temp dir, never the project tree.
fn download_asr_tarball(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let tarball = std::env::temp_dir().join("nila-stt-asr.tar.bz2");
    let result = (|| -> Result<(), String> {
        download_file(app, ASR_TARBALL_URL, &tarball, ENCODER_FILE)?;
        extract_asr_tarball(&tarball, dir)
    })();
    // Never keep a tarball we couldn't use: the next attempt re-downloads.
    std::fs::remove_file(&tarball).ok();
    result
}

/// Extract the two wanted members straight into `.part` staging files
/// (streamed, no 44 MB transient buffer), then verify and atomically
/// rename. An interrupted extraction leaves only `.part` files behind.
fn extract_asr_tarball(tarball: &Path, dir: &Path) -> Result<(), String> {
    // Only the two files we need, matched by file name so the tarball's
    // top-level directory prefix doesn't matter. Destinations are fully
    // controlled — no path-traversal risk from archive members.
    let mut found_encoder = false;
    let mut found_decoder = false;
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
        let dest_name = match wanted_entry(&name) {
            Some(ENCODER_FILE) => {
                found_encoder = true;
                ENCODER_FILE
            }
            Some(DECODER_FILE) => {
                found_decoder = true;
                DECODER_FILE
            }
            Some(TOKENS_FILE) => {
                found_tokens = true;
                TOKENS_FILE
            }
            _ => continue,
        };
        // Stream straight to a `.part` staging file — no giant buffer,
        // and the rename below is the atomic commit point.
        let part = dir.join(dest_name).with_extension("part");
        let mut out =
            std::fs::File::create(&part).map_err(|e| format!("create {}: {e}", part.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("extract {name}: {e}"))?;
        drop(out);
    }
    if !(found_encoder && found_decoder && found_tokens) {
        clean_stale_parts(dir);
        return Err(
            "tarball didn't contain whisper encoder, decoder and tokens.txt".to_string(),
        );
    }
    // Verify sizes BEFORE the rename: a truncated member must never
    // become the installed model.
    let encoder_part = dir.join(ENCODER_FILE).with_extension("part");
    let decoder_part = dir.join(DECODER_FILE).with_extension("part");
    let tokens_part = dir.join(TOKENS_FILE).with_extension("part");
    let encoder_len = file_len(&encoder_part)?;
    let decoder_len = file_len(&decoder_part)?;
    let tokens_len = file_len(&tokens_part)?;
    if encoder_len < EXPECTED_ENCODER_MIN_BYTES {
        clean_stale_parts(dir);
        return Err(format!(
            "extracted encoder is only {encoder_len} bytes — corrupt download?"
        ));
    }
    if decoder_len < EXPECTED_DECODER_MIN_BYTES {
        clean_stale_parts(dir);
        return Err(format!(
            "extracted decoder is only {decoder_len} bytes — corrupt download?"
        ));
    }
    if tokens_len == 0 || tokens_len > EXPECTED_TOKENS_MAX_BYTES {
        clean_stale_parts(dir);
        return Err(format!(
            "extracted tokens.txt has an unexpected size ({tokens_len} bytes)"
        ));
    }
    std::fs::rename(&encoder_part, dir.join(ENCODER_FILE))
        .map_err(|e| format!("rename encoder: {e}"))?;
    std::fs::rename(&decoder_part, dir.join(DECODER_FILE))
        .map_err(|e| format!("rename decoder: {e}"))?;
    std::fs::rename(&tokens_part, dir.join(TOKENS_FILE))
        .map_err(|e| format!("rename tokens: {e}"))?;
    // Drop the legacy Conformer model if it's still around — the new
    // tokens.txt already overwrote the old one above.
    let legacy = dir.join(LEGACY_MODEL_FILE);
    if legacy.is_file() {
        std::fs::remove_file(&legacy).ok();
        eprintln!("nila: models: removed legacy {LEGACY_MODEL_FILE}");
    }
    Ok(())
}

/// Which tarball members we keep. Everything else (full-precision
/// encoder/decoder, test wavs, READMEs) is skipped. Matched by suffix
/// so the exact upstream prefix (e.g. `base.en-`) doesn't matter.
fn wanted_entry(file_name: &str) -> Option<&'static str> {
    if file_name.ends_with("-encoder.int8.onnx") {
        Some(ENCODER_FILE)
    } else if file_name.ends_with("-decoder.int8.onnx") {
        Some(DECODER_FILE)
    } else if file_name.ends_with("-tokens.txt") {
        Some(TOKENS_FILE)
    } else {
        None
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

fn emit(app: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    if let Err(e) = app.emit(event, payload) {
        eprintln!("nila: models: failed to emit {event}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tarball_entry_matching_ignores_directory_prefix() {
        assert_eq!(
            wanted_entry("base.en-encoder.int8.onnx"),
            Some(ENCODER_FILE)
        );
        assert_eq!(
            wanted_entry("base.en-decoder.int8.onnx"),
            Some(DECODER_FILE)
        );
        assert_eq!(wanted_entry("base.en-tokens.txt"), Some(TOKENS_FILE));
        // Everything else in the tarball is skipped (full-precision
        // variants, test wavs, READMEs).
        assert_eq!(wanted_entry("base.en-encoder.onnx"), None);
        assert_eq!(wanted_entry("base.en-decoder.onnx"), None);
        assert_eq!(wanted_entry("tokens.txt"), None);
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
            file: "whisper-encoder.int8.onnx",
            downloaded_bytes: 42,
            total_bytes: 100,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["type"], "nila://models-downloading");
        assert_eq!(v["file"], "whisper-encoder.int8.onnx");
        assert_eq!(v["downloaded_bytes"], 42);
        assert_eq!(v["total_bytes"], 100);
    }

    #[test]
    fn verify_rejects_truncated_model() {
        let tmp = std::env::temp_dir().join("nila-models-test-verify");
        std::fs::create_dir_all(&tmp).unwrap();
        let encoder = tmp.join(ENCODER_FILE);
        let decoder = tmp.join(DECODER_FILE);
        let tokens = tmp.join(TOKENS_FILE);
        let vad = tmp.join(VAD_FILE);
        // All four files exist, but the encoder is a stub.
        std::fs::write(&encoder, b"too small").unwrap();
        std::fs::write(&decoder, vec![0u8; 101_000_000]).unwrap();
        std::fs::write(&tokens, b"a 1\n").unwrap();
        std::fs::write(&vad, vec![0u8; 650_000]).unwrap();

        let paths = ModelPaths {
            encoder,
            decoder,
            tokens,
            vad,
        };
        let err = verify_paths(&paths).unwrap_err();
        assert!(err.contains("only 9 bytes"), "unexpected: {err}");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn verify_rejects_missing_and_empty_tokens() {
        let tmp = std::env::temp_dir().join("nila-models-test-verify2");
        std::fs::create_dir_all(&tmp).unwrap();
        let encoder = tmp.join(ENCODER_FILE);
        let decoder = tmp.join(DECODER_FILE);
        let tokens = tmp.join(TOKENS_FILE);
        let vad = tmp.join(VAD_FILE);
        std::fs::write(&encoder, vec![0u8; 21_000_000]).unwrap();
        std::fs::write(&decoder, vec![0u8; 101_000_000]).unwrap();
        std::fs::write(&tokens, b"").unwrap();
        std::fs::write(&vad, vec![0u8; 650_000]).unwrap();

        let paths = ModelPaths {
            encoder: encoder.clone(),
            decoder: decoder.clone(),
            tokens: tokens.clone(),
            vad: vad.clone(),
        };
        assert!(verify_paths(&paths).is_err());

        // Missing file also fails.
        std::fs::remove_file(&vad).unwrap();
        let paths = ModelPaths {
            encoder,
            decoder,
            tokens,
            vad,
        };
        assert!(verify_paths(&paths).is_err());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn stale_parts_are_cleaned() {
        let tmp = std::env::temp_dir().join("nila-models-test-parts");
        std::fs::create_dir_all(&tmp).unwrap();
        let part = tmp.join(ENCODER_FILE).with_extension("part");
        std::fs::write(&part, b"interrupted").unwrap();
        clean_stale_parts(&tmp);
        assert!(!part.exists());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
