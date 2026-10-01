//! Nila's local voice-command pipeline (sherpa-onnx).
//!
//! Flow:
//!
//! ```text
//! WAKE_LISTENING  (the wake-word worker owns the mic)
//!   -- "nila://wake-detected" -->
//! LISTENING_FOR_SPEECH  (mic captured here, Silero VAD armed)
//!   -- speech starts -->
//! RECORDING_COMMAND  (VAD + accumulating audio, live partial decodes)
//!   -- trailing silence / max duration -->
//! PROCESSING  (final decode; hands the text to the future Jev layer)
//!   -->
//! WAKE_LISTENING
//!
//! Any failure (speech timeout, mic/model error, empty transcript) walks
//! through ERROR instead and then returns to WAKE_LISTENING. RESPONSE is
//! reserved for the future Jev layer's reply turn and is never entered in
//! V1 (`voice:response` is not emitted yet).
//! ```
//!
//! The wake-word implementation is untouched: this worker subscribes to
//! its `nila://wake-detected` event and parks the wake listener (via its
//! existing settings flag) only for the command window, so the microphone
//! is never double-opened.
//!
//! Privacy: audio lives only in RAM as transient f32 blocks. Nothing is
//! ever written to disk.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use sherpa_onnx::{
    LinearResampler, OfflineNemoEncDecCtcModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::wakeword;

/// Frontend event: the post-wake voice session started (VAD armed, mic
/// captured by this worker). The pill should show the listening state.
pub const EVENT_VOICE_STARTED: &str = "voice:started";
/// Frontend event: interim transcription while the user is speaking.
/// Payload: [`PartialPayload`]. Never sent to Jev — UI only.
pub const EVENT_TRANSCRIPT_PARTIAL: &str = "voice:transcript_partial";
/// Frontend event: the final transcription. Payload [`FinalPayload`]
/// uses `{ type: "voice_command", text }` — the shape the future Jev
/// layer consumes.
pub const EVENT_TRANSCRIPT_FINAL: &str = "voice:transcript_final";
/// Frontend event: Nila is finalizing (Jev handoff point; no Jev in V1).
pub const EVENT_VOICE_PROCESSING: &str = "voice:processing";
/// Frontend event: something went wrong. Payload [`ErrorPayload`].
/// NOTE: `voice:response` is reserved for the future Jev layer and is
/// not emitted by this worker.
pub const EVENT_VOICE_ERROR: &str = "voice:error";
/// Frontend event: the voice session fully ended and the wake-word
/// listener is back in charge. The UI should hide the voice surface.
pub const EVENT_VOICE_ENDED: &str = "voice:ended";

/// Payload for [`EVENT_VOICE_STARTED`].
#[derive(Clone, serde::Serialize)]
pub struct StartedPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
}

/// Payload for [`EVENT_TRANSCRIPT_PARTIAL`].
#[derive(Clone, serde::Serialize)]
pub struct PartialPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

/// Payload for [`EVENT_TRANSCRIPT_FINAL`]. The `voice_command` shape is
/// the future Jev layer's input contract.
#[derive(Clone, serde::Serialize)]
pub struct FinalPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

/// Payload for [`EVENT_VOICE_PROCESSING`].
#[derive(Clone, serde::Serialize)]
pub struct ProcessingPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
}

/// Payload for [`EVENT_VOICE_ERROR`].
#[derive(Clone, serde::Serialize)]
pub struct ErrorPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub code: &'static str,
    pub message: String,
}

/// Payload for [`EVENT_VOICE_ENDED`].
#[derive(Clone, serde::Serialize)]
pub struct EndedPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
}

/// Voice session state machine (per command).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// Worker idle, waiting for `nila://wake-detected`.
    WakeListening,
    /// Mic open, VAD armed, waiting for the user to start speaking.
    ListeningForSpeech,
    /// Speech ongoing: VAD + accumulating audio + live partial decodes.
    RecordingCommand,
    /// Final decode done; handing the text off (Jev layer in future).
    Processing,
    /// Final transcript emitted; returning to wake listening.
    CommandReady,
    /// Reserved for the future Jev layer (Nila's reply turn); the backend
    /// never enters it in V1 — `voice:response` is not emitted yet.
    #[allow(dead_code)]
    Response,
    /// A session failed (timeout / mic / model / empty transcript); the
    /// worker reports it and returns to [`Phase::WakeListening`].
    Error,
}

/// Shared flags for the voice worker thread.
///
/// - `stop`: application exit. Honored between blocking calls (see
///   [`request_stop`]).
pub struct VoiceState {
    stop: Arc<AtomicBool>,
}

/// Start the voice worker on its own OS thread. The thread lives for the
/// whole application lifetime; see [`request_stop`].
///
/// The worker subscribes to the wake-word module's
/// `nila://wake-detected` event. The wake-word implementation itself is
/// untouched — this worker only flips its existing settings flag to park
/// it while a voice session owns the microphone.
pub fn spawn(app: &AppHandle) {
    let stop = Arc::new(AtomicBool::new(false));
    app.manage(VoiceState { stop: stop.clone() });
    // The wake-word module is untouched: we subscribe to its detection
    // event and forward it to the worker thread.
    let (wake_tx, wake_rx) = mpsc::channel::<()>();
    let _ = app.listen(wakeword::EVENT_WAKE_DETECTED, move |_| {
        let _ = wake_tx.send(());
    });
    let app = app.clone();
    thread::Builder::new()
        .name("nila-voice-worker".into())
        .spawn(move || run_forever(&app, &stop, wake_rx))
        .expect("failed to spawn voice worker thread");
}

/// Ask the voice worker to stop (application exit).
pub fn request_stop(app: &AppHandle) {
    if let Some(st) = app.try_state::<VoiceState>() {
        st.stop.store(true, Ordering::SeqCst);
    }
}

/// Env var overriding the STT model directory (contains
/// `model.int8.onnx`, `tokens.txt`, `silero_vad.onnx`).
const ENV_MODEL_DIR: &str = "NILA_STT_MODEL_DIR";
/// Env vars overriding individual model files.
const ENV_MODEL: &str = "NILA_STT_MODEL";
const ENV_TOKENS: &str = "NILA_STT_TOKENS";
const ENV_VAD_MODEL: &str = "NILA_STT_VAD_MODEL";
/// Env vars tuning the session timeouts (seconds; floats allowed).
const ENV_SPEECH_TIMEOUT: &str = "NILA_VOICE_SPEECH_TIMEOUT";
const ENV_SILENCE_TIMEOUT: &str = "NILA_VOICE_SILENCE_TIMEOUT";
const ENV_MAX_DURATION: &str = "NILA_VOICE_MAX_DURATION";
/// Env var tuning the live-partial cadence (milliseconds).
const ENV_PARTIAL_INTERVAL_MS: &str = "NILA_VOICE_PARTIAL_MS";

const DEFAULT_SPEECH_TIMEOUT_SECS: f32 = 8.0;
const DEFAULT_SILENCE_TIMEOUT_SECS: f32 = 1.2;
const DEFAULT_MAX_DURATION_SECS: f32 = 20.0;
const DEFAULT_PARTIAL_INTERVAL: Duration = Duration::from_millis(1000);

/// Everything the recognizer and VAD run at.
const SAMPLE_RATE: i32 = 16_000;
/// Silero VAD's native window (32 ms at 16 kHz).
const VAD_WINDOW: usize = 512;

/// Don't end the command on silence before at least this much speech —
/// avoids cutting off on a mid-sentence pause right at the start.
const MIN_COMMAND_SECS: f32 = 0.5;
/// Beat between the final transcript and handing the mic back, so the UI
/// can freeze the text before Nila settles again.
const FINAL_BEAT: Duration = Duration::from_millis(800);
/// Grace period for the parked wake listener to drop its mic stream
/// before this worker opens its own.
const PARK_SETTLE: Duration = Duration::from_millis(300);

/// Parse a float env var, falling back to `default` on missing/parse
/// failure (with a stderr note so a typo doesn't silently stick).
fn env_f32(name: &str, default: f32) -> f32 {
    match std::env::var(name) {
        Ok(v) => match v.trim().parse::<f32>() {
            Ok(n) if n > 0.0 => n,
            _ => {
                eprintln!("nila: voice: ignoring invalid {name}='{v}' (using {default})");
                default
            }
        },
        Err(_) => default,
    }
}

fn env_duration_ms(name: &str, default: Duration) -> Duration {
    let ms = env_f32(name, default.as_millis() as f32);
    Duration::from_millis(ms.max(1.0) as u64)
}

/// Directories searched for `models/stt/`, in order (mirrors the
/// wake-word module's search strategy).
fn search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(v) = std::env::var(ENV_MODEL_DIR) {
        let p = PathBuf::from(v.trim());
        if p.is_dir() {
            return vec![p];
        }
        eprintln!("nila: voice: {ENV_MODEL_DIR}='{}' is not a directory", p.display());
    }
    // Next to the working directory (covers `cargo run` and `tauri dev`
    // from either the workspace root or src-tauri/).
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("models").join("stt"));
        if let Some(parent) = cwd.parent() {
            dirs.push(parent.join("models").join("stt"));
        }
    }
    // Next to the executable (dev builds, manual installs).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("models").join("stt"));
        }
    }
    // Tauri bundled resources (packaged .deb / .AppImage).
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("models").join("stt"));
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
                eprintln!("nila: voice: {env} points at missing file '{}'", p.display());
                None
            }
        }
        Err(_) => dir.map(|d| d.join(name)),
    }
}

/// Resolve the three model files: `NILA_STT_MODEL_DIR` (or the first
/// `models/stt/` found by [`search_dirs`]) supplies the defaults, and
/// [`ENV_MODEL`]/[`ENV_TOKENS`]/[`ENV_VAD_MODEL`] each override their own
/// file independently.
fn resolve_models(app: &AppHandle) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let dir = search_dirs(app).into_iter().find(|d| {
        d.join("model.int8.onnx").is_file()
            && d.join("tokens.txt").is_file()
            && d.join("silero_vad.onnx").is_file()
    });
    let dir = dir.as_deref();
    match (
        resolve_one_file(ENV_MODEL, "model.int8.onnx", dir),
        resolve_one_file(ENV_TOKENS, "tokens.txt", dir),
        resolve_one_file(ENV_VAD_MODEL, "silero_vad.onnx", dir),
    ) {
        (Some(model), Some(tokens), Some(vad)) => Some((model, tokens, vad)),
        _ => None,
    }
}

/// The loaded sherpa-onnx engine: one offline recognizer plus the VAD.
/// Loaded once (lazily, on first wake) and reused across sessions.
struct Engine {
    recognizer: OfflineRecognizer,
    vad: VoiceActivityDetector,
}

fn load_engine(model: &Path, tokens: &Path, vad_model: &Path) -> Result<Engine, String> {
    // VAD first (small, fast) so a VAD failure is reported cheaply.
    let mut silero = SileroVadModelConfig::default();
    silero.model = Some(vad_model.to_string_lossy().into_owned());
    silero.threshold = 0.5;
    silero.min_silence_duration = 0.3;
    silero.min_speech_duration = 0.2;
    silero.max_speech_duration = 30.0;
    silero.window_size = VAD_WINDOW as i32;
    let mut vad_config = VadModelConfig::default();
    vad_config.silero_vad = silero;
    vad_config.sample_rate = SAMPLE_RATE;
    vad_config.num_threads = 1;
    vad_config.provider = Some("cpu".to_string());
    let vad = VoiceActivityDetector::create(&vad_config, 30.0)
        .ok_or_else(|| "failed to create Silero VAD".to_string())?;

    let mut config = OfflineRecognizerConfig::default();
    config.feat_config.sample_rate = SAMPLE_RATE;
    config.feat_config.feature_dim = 80;
    config.model_config.nemo_ctc = OfflineNemoEncDecCtcModelConfig {
        model: Some(model.to_string_lossy().into_owned()),
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
    config.model_config.num_threads = 2;
    config.model_config.debug = false;
    config.model_config.provider = Some("cpu".to_string());
    config.decoding_method = Some("greedy_search".to_string());
    eprintln!("nila: voice: loading Conformer-CTC model (this takes a moment)...");
    let recognizer =
        OfflineRecognizer::create(&config).map_err(|e| format!("failed to create STT recognizer: {e}"))?;
    eprintln!("nila: voice: STT engine ready");
    Ok(Engine { recognizer, vad })
}

/// Log a state transition (the state machine is small; a log line per
/// transition is the cheapest honest trace).
fn transition(phase: &mut Phase, next: Phase) {
    if *phase != next {
        eprintln!("nila: voice: {phase:?} -> {next:?}");
        *phase = next;
    }
}

fn emit(app: &AppHandle, event: &str, payload: impl serde::Serialize) {
    if let Err(e) = app.emit(event, payload) {
        eprintln!("nila: voice: failed to emit {event}: {e}");
    }
}

fn emit_error(app: &AppHandle, code: &'static str, message: impl Into<String>) {
    let message = message.into();
    eprintln!("nila: voice: error [{code}]: {message}");
    emit(
        app,
        EVENT_VOICE_ERROR,
        ErrorPayload {
            kind: "voice:error",
            code,
            message,
        },
    );
}

/// Wait up to `timeout` for a wake event. Returns true if one arrived.
/// Stale queued events are coalesced: one session per burst.
fn await_wake(stop: &Arc<AtomicBool>, wake_rx: &mpsc::Receiver<()>, timeout: Duration) -> bool {
    // Coalesce anything already queued.
    let mut pending = false;
    while wake_rx.try_recv().is_ok() {
        pending = true;
    }
    if pending {
        return !stop.load(Ordering::SeqCst);
    }
    let deadline = Instant::now() + timeout;
    while !stop.load(Ordering::SeqCst) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match wake_rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(()) => {
                while wake_rx.try_recv().is_ok() {}
                return true;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}

/// Outer loop: wait for wake detections and run one voice session each.
/// The engine loads lazily on first wake so app startup pays nothing.
fn run_forever(app: &AppHandle, stop: &Arc<AtomicBool>, wake_rx: mpsc::Receiver<()>) {
    let mut engine: Option<Engine> = None;
    let mut phase = Phase::WakeListening;
    while !stop.load(Ordering::SeqCst) {
        transition(&mut phase, Phase::WakeListening);
        if !await_wake(stop, &wake_rx, Duration::from_secs(3600)) {
            continue;
        }
        if engine.is_none() {
            match resolve_models(app) {
                Some((model, tokens, vad_model)) => match load_engine(&model, &tokens, &vad_model) {
                    Ok(e) => engine = Some(e),
                    Err(e) => {
                        transition(&mut phase, Phase::Error);
                        emit_error(app, "model_error", format!("STT engine failed to load: {e}"));
                        continue;
                    }
                },
                None => {
                    transition(&mut phase, Phase::Error);
                    emit_error(
                        app,
                        "model_error",
                        "STT models not found — run src-tauri/models/stt/download-stt-model.sh, then restart Nila",
                    );
                    continue;
                }
            }
        }
        let eng = engine.as_ref().expect("engine loaded above");
        run_session(app, eng, stop, &mut phase);
        eng.vad.reset();
    }
    eprintln!("nila: voice: worker stopped");
}

/// One post-wake voice session: park the wake listener, capture the
/// command, transcribe, emit events, hand the mic back.
fn run_session(app: &AppHandle, engine: &Engine, stop: &Arc<AtomicBool>, phase: &mut Phase) {
    let speech_timeout = env_f32(ENV_SPEECH_TIMEOUT, DEFAULT_SPEECH_TIMEOUT_SECS);
    let silence_timeout = env_f32(ENV_SILENCE_TIMEOUT, DEFAULT_SILENCE_TIMEOUT_SECS);
    let max_duration = env_f32(ENV_MAX_DURATION, DEFAULT_MAX_DURATION_SECS);
    let partial_interval = env_duration_ms(ENV_PARTIAL_INTERVAL_MS, DEFAULT_PARTIAL_INTERVAL);

    // Park the wake listener so this worker owns the mic alone. Remember
    // the flag so we can restore exactly what the user had.
    let wake_was_enabled = wakeword::is_enabled(app);
    wakeword::set_enabled(app, false);
    // Give the wake worker a beat to drop its stream (it polls the flag
    // every ~100 ms); the open below also retries on a busy device.
    thread::sleep(PARK_SETTLE);

    transition(phase, Phase::ListeningForSpeech);
    emit(app, EVENT_VOICE_STARTED, StartedPayload { kind: "voice:started" });
    eprintln!("nila: voice: session started (wake listener parked)");

    let audio = match open_audio() {
        Ok(audio) => audio,
        Err(e) => {
            transition(phase, Phase::Error);
            emit_error(app, "mic_error", format!("microphone unavailable: {e}"));
            restore_wake_listener(app, wake_was_enabled);
            return;
        }
    };
    let outcome = capture_command(
        app,
        engine,
        &audio,
        stop,
        phase,
        speech_timeout,
        silence_timeout,
        max_duration,
        partial_interval,
    );
    // The stream is dropped here: capture stops, mic released.
    drop(audio);

    match outcome {
        Outcome::Stopped => { /* app is exiting; nothing to emit */ }
        Outcome::SpeechTimeout => {
            transition(phase, Phase::Error);
            emit_error(app, "speech_timeout", "no speech heard after the wake word");
        }
        Outcome::MicError => {
            transition(phase, Phase::Error);
            emit_error(app, "mic_error", "microphone stream ended unexpectedly");
        }
        Outcome::Done { samples } => {
            // Finalize, then walk PROCESSING -> (Jev handoff) -> idle.
            transition(phase, Phase::Processing);
            let text = decode_text(&engine.recognizer, &samples);
            let text = text.trim().to_string();
            if text.is_empty() {
                transition(phase, Phase::Error);
                emit_error(app, "empty_transcript", "couldn't make out any words");
            } else {
                eprintln!("nila: voice: final transcript: {text}");
                emit(
                    app,
                    EVENT_TRANSCRIPT_FINAL,
                    FinalPayload {
                        kind: "voice_command",
                        text,
                    },
                );
                emit(app, EVENT_VOICE_PROCESSING, ProcessingPayload { kind: "voice:processing" });
                // Let the UI freeze the final text before we disappear.
                transition(phase, Phase::CommandReady);
                thread::sleep(FINAL_BEAT);
            }
        }
    }
    emit(app, EVENT_VOICE_ENDED, EndedPayload { kind: "voice:ended" });
    restore_wake_listener(app, wake_was_enabled);
    eprintln!("nila: voice: session ended");
}

/// Hand the microphone back to the wake-word listener. Only restores the
/// flag when this worker was the last writer: if the user flipped the
/// settings toggle mid-command, their choice stands.
///
/// (Known V1 race: if the user turns the wake word *off* mid-command we
/// can't distinguish that from our own park, so it comes back on. The DB
/// is the source of truth for the toggle UI and the next app start.)
fn restore_wake_listener(app: &AppHandle, was_enabled: bool) {
    if was_enabled && !wakeword::is_enabled(app) {
        wakeword::set_enabled(app, true);
        eprintln!("nila: voice: wake-word listener resumed");
    }
}

/// How a capture loop ended.
enum Outcome {
    /// Got audio; the (possibly empty) samples need a final decode.
    Done { samples: Vec<f32> },
    /// Nobody spoke within the speech-start timeout.
    SpeechTimeout,
    /// The mic stream died mid-capture.
    MicError,
    /// Application exit requested.
    Stopped,
}

/// Capture one command: VAD-gated recording with live partial decodes.
/// Returns the outcome and, on success, the raw 16 kHz mono samples.
#[allow(clippy::too_many_arguments)]
fn capture_command(
    app: &AppHandle,
    engine: &Engine,
    audio: &AudioInput,
    stop: &Arc<AtomicBool>,
    phase: &mut Phase,
    speech_timeout: f32,
    silence_timeout: f32,
    max_duration: f32,
    partial_interval: Duration,
) -> Outcome {
    let session_start = Instant::now();
    let mut pending: Vec<f32> = Vec::new();
    let mut samples: Vec<f32> = Vec::new();
    let mut silence_chunks: u32 = 0;
    let mut speech_chunks: u32 = 0;
    let mut last_partial = String::new();
    let mut last_partial_at = Instant::now();
    let mut decoded_len: usize = 0;

    loop {
        if stop.load(Ordering::SeqCst) {
            return Outcome::Stopped;
        }
        match audio.rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => push_resampled(&audio.resampler, &mut pending, &chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Outcome::MicError,
        }
        // Drain anything that arrived while we were busy.
        while let Ok(chunk) = audio.rx.try_recv() {
            push_resampled(&audio.resampler, &mut pending, &chunk);
        }

        while pending.len() >= VAD_WINDOW {
            let chunk: Vec<f32> = pending.drain(..VAD_WINDOW).collect();
            engine.vad.accept_waveform(&chunk);
            // We do our own endpointing; drop the VAD's segment queue.
            engine.vad.clear();
            let speech = engine.vad.detected();
            if *phase == Phase::ListeningForSpeech {
                if speech {
                    transition(phase, Phase::RecordingCommand);
                    samples.extend_from_slice(&chunk);
                    speech_chunks += 1;
                    last_partial_at = Instant::now();
                    eprintln!("nila: voice: speech detected");
                } else if session_start.elapsed().as_secs_f32() >= speech_timeout {
                    return Outcome::SpeechTimeout;
                }
            } else {
                samples.extend_from_slice(&chunk);
                if speech {
                    speech_chunks += 1;
                    silence_chunks = 0;
                } else {
                    silence_chunks += 1;
                }

                // Live partials: re-decode the growing buffer (the model
                // is offline/full-context, so partials are just repeated
                // decodes — sherpa's simulated-streaming pattern).
                if last_partial_at.elapsed() >= partial_interval && samples.len() > decoded_len {
                    decoded_len = samples.len();
                    last_partial_at = Instant::now();
                    let text = decode_text(&engine.recognizer, &samples);
                    let text = text.trim().to_string();
                    if !text.is_empty() && text != last_partial {
                        last_partial = text.clone();
                        emit(
                            app,
                            EVENT_TRANSCRIPT_PARTIAL,
                            PartialPayload {
                                kind: "voice:transcript_partial",
                                text,
                            },
                        );
                    }
                }

                let secs_per_chunk = VAD_WINDOW as f32 / SAMPLE_RATE as f32;
                let silence_secs = silence_chunks as f32 * secs_per_chunk;
                let speech_secs = speech_chunks as f32 * secs_per_chunk;
                if silence_secs >= silence_timeout && speech_secs >= MIN_COMMAND_SECS {
                    eprintln!("nila: voice: end of speech ({silence_secs:.1}s silence)");
                    return Outcome::Done { samples };
                }
                if session_start.elapsed().as_secs_f32() >= max_duration {
                    eprintln!("nila: voice: max command duration reached");
                    return Outcome::Done { samples };
                }
            }
        }
    }
}

/// Decode 16 kHz mono samples with the offline Conformer-CTC model.
/// A fresh stream per call: the model is full-context, so partials are
/// just re-decodes of the growing buffer (sherpa's simulated-streaming
/// pattern). Never touches disk.
fn decode_text(recognizer: &OfflineRecognizer, samples: &[f32]) -> String {
    if samples.is_empty() {
        return String::new();
    }
    let stream = recognizer.create_stream();
    stream.accept_waveform(SAMPLE_RATE, samples);
    recognizer.decode(&stream);
    stream.get_result().map(|r| r.text).unwrap_or_default()
}

/// An open microphone: the CPAL stream (kept alive for the session), a
/// channel of mono 16 kHz blocks, and an optional resampler for devices
/// whose native rate isn't 16 kHz.
struct AudioInput {
    _stream: cpal::Stream,
    rx: mpsc::Receiver<Vec<f32>>,
    resampler: Option<LinearResampler>,
}

fn push_resampled(resampler: &Option<LinearResampler>, out: &mut Vec<f32>, chunk: &[f32]) {
    match resampler {
        Some(r) => out.extend_from_slice(&r.resample(chunk, false)),
        None => out.extend_from_slice(chunk),
    }
}

/// Open the default input device, retrying while it is busy (the parked
/// wake listener may still be releasing it).
fn open_audio() -> Result<AudioInput, String> {
    let mut last_err = "unknown".to_string();
    for attempt in 1..=8 {
        match try_open_audio() {
            Ok(audio) => return Ok(audio),
            Err(e) => {
                last_err = e;
                eprintln!("nila: voice: mic open attempt {attempt}/8 failed: {last_err}");
                thread::sleep(Duration::from_millis(250));
            }
        }
    }
    Err(last_err)
}

fn try_open_audio() -> Result<AudioInput, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let name = device.name().unwrap_or_else(|_| "<unnamed>".to_string());
    let supported = device
        .default_input_config()
        .map_err(|e| format!("input config: {e}"))?;
    let mic_rate = supported.sample_rate().0 as i32;
    let channels_u16 = supported.channels();
    let channels = channels_u16 as usize;
    let sample_format = supported.sample_format();
    eprintln!("nila: voice: mic '{name}': {sample_format:?}, {channels}ch, {mic_rate}Hz");
    let resampler = if mic_rate != SAMPLE_RATE {
        Some(
            LinearResampler::create(mic_rate, SAMPLE_RATE)
                .ok_or_else(|| "failed to create resampler".to_string())?,
        )
    } else {
        None
    };
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err_fn = |err| eprintln!("nila: voice: audio stream error: {err}");
    // Build the stream config explicitly (channels/rate from the device,
    // default buffering) rather than relying on SupportedStreamConfig
    // accessors that vary across cpal versions.
    let stream_config = cpal::StreamConfig {
        channels: channels_u16,
        sample_rate: supported.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &_| {
                if !data.is_empty() {
                    let _ = tx.send(downmix_f32(data, channels));
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _: &_| {
                if !data.is_empty() {
                    let _ = tx.send(downmix_i16(data, channels));
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _: &_| {
                if !data.is_empty() {
                    let _ = tx.send(downmix_u16(data, channels));
                }
            },
            err_fn,
            None,
        ),
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| format!("build input stream: {e}"))?;
    stream.play().map_err(|e| format!("start stream: {e}"))?;
    Ok(AudioInput {
        _stream: stream,
        rx,
        resampler,
    })
}

/// Downmix an interleaved frame to mono f32 in [-1, 1].
fn downmix_f32(data: &[f32], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    data.chunks(ch)
        .map(|frame| frame.iter().copied().sum::<f32>() / ch as f32)
        .collect()
}

fn downmix_i16(data: &[i16], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    data.chunks(ch)
        .map(|frame| {
            frame.iter().map(|&s| s as f32 / i16::MAX as f32).sum::<f32>() / ch as f32
        })
        .collect()
}

fn downmix_u16(data: &[u16], channels: usize) -> Vec<f32> {
    let ch = channels.max(1);
    data.chunks(ch)
        .map(|frame| {
            frame
                .iter()
                .map(|&s| (s as f32 - 32768.0) / 32768.0)
                .sum::<f32>()
                / ch as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_f32_reads_valid_values() {
        std::env::set_var("NILA_VOICE_TEST_F32", "2.5");
        let v = env_f32("NILA_VOICE_TEST_F32", 1.0);
        std::env::remove_var("NILA_VOICE_TEST_F32");
        assert!((v - 2.5).abs() < f32::EPSILON);
    }

    #[test]
    fn env_f32_falls_back_on_missing_or_invalid() {
        std::env::remove_var("NILA_VOICE_TEST_F32");
        assert!((env_f32("NILA_VOICE_TEST_F32", 1.0) - 1.0).abs() < f32::EPSILON);
        std::env::set_var("NILA_VOICE_TEST_F32", "nope");
        let v = env_f32("NILA_VOICE_TEST_F32", 1.0);
        std::env::remove_var("NILA_VOICE_TEST_F32");
        assert!((v - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn downmix_averages_channels() {
        // Stereo f32: (1.0, -1.0) -> 0.0, (0.5, 0.5) -> 0.5.
        let out = downmix_f32(&[1.0, -1.0, 0.5, 0.5], 2);
        assert_eq!(out.len(), 2);
        assert!(out[0].abs() < f32::EPSILON);
        assert!((out[1] - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn downmix_i16_scales_to_unit_range() {
        let out = downmix_i16(&[i16::MAX, i16::MIN], 2);
        assert_eq!(out.len(), 1);
        assert!(out[0].abs() < 1e-3);
    }

    #[test]
    fn final_payload_uses_voice_command_shape() {
        let p = FinalPayload {
            kind: "voice_command",
            text: "open firefox".to_string(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["type"], "voice_command");
        assert_eq!(v["text"], "open firefox");
    }

    #[test]
    fn resolve_one_file_env_wins_independently() {
        let tmp = std::env::temp_dir().join("nila-voice-test-resolve");
        std::fs::create_dir_all(&tmp).unwrap();
        let custom = tmp.join("custom-model.onnx");
        let dir_model = tmp.join("model.int8.onnx");
        std::fs::write(&custom, b"fake").unwrap();
        std::fs::write(&dir_model, b"fake").unwrap();

        // A set var wins over the directory, on its own.
        std::env::set_var("NILA_VOICE_TEST_MODEL", custom.to_str().unwrap());
        let got = resolve_one_file("NILA_VOICE_TEST_MODEL", "model.int8.onnx", Some(&tmp));
        assert_eq!(got, Some(custom.clone()));

        // An unset var falls back to the directory.
        std::env::remove_var("NILA_VOICE_TEST_TOKENS");
        let got = resolve_one_file("NILA_VOICE_TEST_TOKENS", "model.int8.onnx", Some(&tmp));
        assert_eq!(got, Some(dir_model.clone()));

        // A set-but-missing path is a hard miss, not a silent fallback.
        std::env::set_var(
            "NILA_VOICE_TEST_VAD",
            tmp.join("nope.onnx").to_str().unwrap(),
        );
        let got = resolve_one_file("NILA_VOICE_TEST_VAD", "silero_vad.onnx", Some(&tmp));
        assert_eq!(got, None);

        std::env::remove_var("NILA_VOICE_TEST_MODEL");
        std::env::remove_var("NILA_VOICE_TEST_VAD");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
