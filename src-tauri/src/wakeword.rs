//! Nila's wake-word listener.
//!
//! Pipeline: microphone -> micro-wakeword -> `nila://wake-detected`
//! -> the frontend shows Nila listening.
//!
//! Privacy: the microphone is captured only as transient 10 ms PCM blocks
//! that are fed straight into the detector. Audio is NEVER written to
//! disk, recorded, or kept beyond the current inference step.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use micro_wakeword::{Error as WakeError, Listener};
use tauri::{AppHandle, Emitter, Manager};

/// Frontend event: a wake word was detected. Payload: [`WakeDetectedPayload`].
pub const EVENT_WAKE_DETECTED: &str = "nila://wake-detected";
/// Frontend event: the post-wake listen window ended; Nila goes back to
/// quietly listening for the wake word. No payload.
pub const EVENT_WAKE_IDLE: &str = "nila://wake-idle";
/// Frontend event: the listener hit an error (mic lost, no model yet,
/// ...). It keeps retrying on its own. Payload: [`WakeErrorPayload`].
pub const EVENT_WAKE_ERROR: &str = "nila://wake-error";

/// Wake-word state machine (V1: no speech-to-text yet, so the command
/// window is a visual hold that ends on its own).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WakeState {
    /// Worker starting / between listener rebuilds.
    Idle,
    /// Microphone open, detector running, waiting for the wake word.
    ListeningForWake,
    /// Wake word just detected; the frontend should wake Nila visually.
    WakeDetected,
    /// Holding the "listening" visual while the user would speak.
    ListeningForCommand,
    /// Command window ended; V1 has no STT, so this is a brief beat
    /// before returning to wake listening.
    Processing,
}

/// Payload for [`EVENT_WAKE_DETECTED`].
#[derive(Clone, serde::Serialize)]
pub struct WakeDetectedPayload {
    pub wake_word: String,
    pub probability: f32,
}

/// Payload for [`EVENT_WAKE_ERROR`].
#[derive(Clone, serde::Serialize)]
pub struct WakeErrorPayload {
    pub message: String,
}

/// Shared flags for the wake-word worker thread.
///
/// - `stop`: application exit. Honored between blocking calls (see
///   [`request_stop`]).
/// - `enabled`: the settings toggle. When false the worker parks and the
///   microphone stream is fully released; when true it listens.
pub struct WakeWordState {
    stop: Arc<AtomicBool>,
    enabled: Arc<AtomicBool>,
}

/// Start the wake-word worker on its own OS thread. The thread lives for
/// the whole application lifetime; see [`request_stop`].
pub fn spawn(app: &AppHandle, enabled: bool) {
    let stop = Arc::new(AtomicBool::new(false));
    let enabled = Arc::new(AtomicBool::new(enabled));
    app.manage(WakeWordState {
        stop: stop.clone(),
        enabled: enabled.clone(),
    });
    let app = app.clone();
    thread::Builder::new()
        .name("nila-wake-listener".into())
        .spawn(move || run_forever(&app, &stop, &enabled))
        .expect("failed to spawn wake-word listener thread");
}

/// Flip the wake-word listener from the settings toggle. Turning it off
/// parks the worker and releases the microphone; turning it on resumes
/// listening. Applied between blocking calls, like shutdown.
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    if let Some(st) = app.try_state::<WakeWordState>() {
        st.enabled.store(enabled, Ordering::SeqCst);
        eprintln!("nila: wake-word: {}", if enabled { "enabled" } else { "disabled" });
    }
}

/// Ask the worker thread to stop. Called on application exit.
///
/// NOTE: `Listener::next_detection()` blocks inside the crate until audio
/// arrives or the stream ends and offers no cancellation hook, so a call
/// already in flight cannot be interrupted — the flag is honored between
/// calls instead, and process teardown reclaims the thread. Nothing is
/// lost: no audio is ever persisted, so there is nothing to flush.
pub fn request_stop(app: &AppHandle) {
    if let Some(st) = app.try_state::<WakeWordState>() {
        st.stop.store(true, Ordering::SeqCst);
    }
}

/// Env var overriding model selection: a stem (`nila`) or a direct path
/// to a `.tflite` / `.json` file.
const ENV_MODEL: &str = "NILA_WAKE_MODEL";

/// Model stems in preference order. `nila` is the future custom model;
/// `okay_nabu` is the temporary test model (see `models/`).
const MODEL_STEMS: &[&str] = &["nila", "okay_nabu"];

/// Suppress repeat detections for this long after an accepted one, on top
/// of the model's own sliding-window smoothing.
const REPEAT_COOLDOWN: Duration = Duration::from_secs(3);

/// How long Nila stays visibly "listening" after a detection before she
/// settles back to wake listening (no STT in V1).
const LISTEN_WINDOW: Duration = Duration::from_secs(6);

/// Pause before rebuilding the listener after a failure (mic unplugged,
/// model not downloaded yet, ...).
const RETRY_DELAY: Duration = Duration::from_secs(5);

/// How the detector should be configured for a resolved model file.
enum ModelSource {
    /// A model JSON config: threshold and window come from the model author.
    Config(PathBuf),
    /// A bare `.tflite` with no JSON: conservative fallback settings.
    Bare(PathBuf),
}

/// Classify an explicit path (env var) as a model source.
fn source_for_path(path: &Path) -> Option<ModelSource> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("json") => Some(ModelSource::Config(path.to_path_buf())),
        Some("tflite") => Some(ModelSource::Bare(path.to_path_buf())),
        _ => None,
    }
}

/// Stems to look for: the env override first, else the built-in order.
fn stem_candidates() -> Vec<String> {
    if let Ok(v) = std::env::var(ENV_MODEL) {
        let v = v.trim();
        if !v.is_empty() && !v.contains('/') && !v.contains('.') {
            return vec![v.to_string()];
        }
    }
    MODEL_STEMS.iter().map(|s| s.to_string()).collect()
}

/// Directories searched for wake-word models, in order.
fn search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    // Next to the working directory (covers `cargo run` and `tauri dev`
    // from either the workspace root or src-tauri/).
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("models"));
        if let Some(parent) = cwd.parent() {
            dirs.push(parent.join("models"));
        }
    }
    // Next to the executable (dev builds, manual installs).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("models"));
        }
    }
    // Tauri bundled resources (packaged .deb / .AppImage).
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("models"));
    }
    dirs
}

/// Find the wake-word model. Prefers a model JSON (author-tuned threshold
/// and window) next to the `.tflite`; falls back to a bare `.tflite`.
fn resolve_model(app: &AppHandle) -> Option<ModelSource> {
    // Explicit file path via env var wins outright.
    if let Ok(v) = std::env::var(ENV_MODEL) {
        let v = v.trim();
        if !v.is_empty() && (v.contains('/') || v.contains('.')) {
            let p = PathBuf::from(v);
            if p.is_file() {
                return source_for_path(&p);
            }
            eprintln!("nila: wake-word: {ENV_MODEL} points at missing file '{v}'");
        }
    }
    let dirs = search_dirs(app);
    for stem in stem_candidates() {
        for dir in &dirs {
            let json = dir.join(format!("{stem}.json"));
            if json.is_file() {
                return Some(ModelSource::Config(json));
            }
        }
        for dir in &dirs {
            let tflite = dir.join(format!("{stem}.tflite"));
            if tflite.is_file() {
                return Some(ModelSource::Bare(tflite));
            }
        }
    }
    None
}

/// Build a live microphone listener for the resolved model.
fn build_listener(source: &ModelSource) -> Result<Listener, WakeError> {
    match source {
        ModelSource::Config(json) => {
            eprintln!("nila: wake-word: using model config {}", json.display());
            Listener::config_builder(json.as_path())?
                .cooldown(REPEAT_COOLDOWN)
                .build()
        }
        ModelSource::Bare(tflite) => {
            let stem = tflite
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("wake word");
            let wake_word = stem.replace('_', " ");
            eprintln!(
                "nila: wake-word: using bare model {} (fallback settings)",
                tflite.display()
            );
            Listener::builder(tflite.clone())
                .wake_word(wake_word)
                .probability_cutoff(0.9)
                .sliding_window_size(5)
                .cooldown(REPEAT_COOLDOWN)
                .build()
        }
    }
}

/// Log a state transition (the state machine is small; a log line per
/// transition is the cheapest honest trace).
fn transition(state: &mut WakeState, next: WakeState) {
    if *state != next {
        eprintln!("nila: wake-word: {state:?} -> {next:?}");
        *state = next;
    }
}

/// Sleep in small slices so a shutdown request — or a change of the
/// `changed` flag away from `expect` — is honored promptly.
fn sleep_until(stop: &Arc<AtomicBool>, changed: &Arc<AtomicBool>, expect: bool, dur: Duration) {
    let mut remaining = dur;
    let step = Duration::from_millis(100);
    while remaining > Duration::ZERO
        && !stop.load(Ordering::SeqCst)
        && changed.load(Ordering::SeqCst) == expect
    {
        let nap = remaining.min(step);
        thread::sleep(nap);
        remaining = remaining.saturating_sub(nap);
    }
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    eprintln!("nila: wake-word: {message}");
    app.emit(
        EVENT_WAKE_ERROR,
        WakeErrorPayload { message },
    )
    .ok();
}

/// Outer loop: resolve a model, build a listener, run it until it dies,
/// then rebuild (a replugged mic or a newly downloaded model is picked up
/// without restarting the app).
///
/// When the worker is disabled via settings it parks here with the
/// microphone fully released — no stream, no inference, no audio touched —
/// and wakes within ~100 ms of being re-enabled.
fn run_forever(app: &AppHandle, stop: &Arc<AtomicBool>, enabled: &Arc<AtomicBool>) {
    let mut state = WakeState::Idle;
    while !stop.load(Ordering::SeqCst) {
        if !enabled.load(Ordering::SeqCst) {
            transition(&mut state, WakeState::Idle);
            sleep_until(stop, enabled, false, Duration::from_secs(1));
            continue;
        }
        match resolve_model(app) {
            None => {
                let dirs = search_dirs(app);
                emit_error(
                    app,
                    format!(
                        "no wake-word model found (looked for {} in {}); run models/download-test-model.sh",
                        MODEL_STEMS.join("/"),
                        dirs.iter()
                            .map(|d| d.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
                );
                sleep_until(stop, enabled, true, RETRY_DELAY);
            }
            Some(source) => match build_listener(&source) {
                Err(e) => {
                    emit_error(app, format!("wake-word listener failed to start: {e}"));
                    sleep_until(stop, enabled, true, RETRY_DELAY);
                }
                Ok(mut listener) => {
                    transition(&mut state, WakeState::ListeningForWake);
                    detection_loop(app, &mut listener, stop, enabled, &mut state);
                    // The listener died (mic unplugged, stream ended, ...),
                    // or the worker was disabled: drop the listener (mic
                    // released) and loop around — rebuild if still enabled.
                    sleep_until(stop, enabled, true, RETRY_DELAY);
                }
            },
        }
    }
    eprintln!("nila: wake-word: listener stopped");
}

/// Inner loop: block on detections and walk the state machine.
/// Returns when the listener dies and should be rebuilt, or when the
/// worker is disabled (the listener is then dropped and the mic released).
fn detection_loop(
    app: &AppHandle,
    listener: &mut Listener,
    stop: &Arc<AtomicBool>,
    enabled: &Arc<AtomicBool>,
    state: &mut WakeState,
) {
    while !stop.load(Ordering::SeqCst) && enabled.load(Ordering::SeqCst) {
        match listener.next_detection() {
            Ok(Some(d)) => {
                transition(state, WakeState::WakeDetected);
                eprintln!(
                    "nila: wake-word: detected '{}' (probability {:.2})",
                    d.wake_word, d.probability
                );
                app.emit(
                    EVENT_WAKE_DETECTED,
                    WakeDetectedPayload {
                        wake_word: d.wake_word,
                        probability: d.probability,
                    },
                )
                .ok();
                // The crate's repeat cooldown plus this hold spaces events
                // out; stale audio queued during the hold is discarded by
                // the listener itself.
                transition(state, WakeState::ListeningForCommand);
                sleep_until(stop, enabled, true, LISTEN_WINDOW);
                transition(state, WakeState::Processing);
                eprintln!("nila: wake-word: command window ended (no STT in V1)");
                app.emit(EVENT_WAKE_IDLE, ()).ok();
                transition(state, WakeState::ListeningForWake);
            }
            Ok(None) => {
                eprintln!("nila: wake-word: audio stream ended; rebuilding listener");
                break;
            }
            Err(e) => {
                // Mic unplugged, permission revoked, device lost: the outer
                // loop rebuilds, so a replugged mic is picked up by itself.
                let kind = match &e {
                    WakeError::Audio(_) | WakeError::AudioStreamEnded => "microphone",
                    _ => "listener",
                };
                emit_error(app, format!("{kind} error ({e}); will retry"));
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_path_selects_config_source() {
        let src = source_for_path(Path::new("/x/okay_nabu.json")).unwrap();
        assert!(matches!(src, ModelSource::Config(_)));
    }

    #[test]
    fn tflite_path_selects_bare_source() {
        let src = source_for_path(Path::new("/x/nila.tflite")).unwrap();
        assert!(matches!(src, ModelSource::Bare(_)));
    }

    #[test]
    fn unknown_extension_is_rejected() {
        assert!(source_for_path(Path::new("/x/nila.bin")).is_none());
        assert!(source_for_path(Path::new("/x/nila")).is_none());
    }

    #[test]
    fn default_stems_prefer_nila_over_test_model() {
        std::env::remove_var(ENV_MODEL);
        assert_eq!(stem_candidates(), vec!["nila", "okay_nabu"]);
    }

    #[test]
    fn env_stem_override_replaces_defaults() {
        std::env::set_var(ENV_MODEL, "custom");
        let stems = stem_candidates();
        std::env::remove_var(ENV_MODEL);
        assert_eq!(stems, vec!["custom"]);
    }
}
