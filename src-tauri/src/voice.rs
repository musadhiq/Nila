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
//! PROCESSING_STT  (final decode; hands the text to the Jev layer via the
//!                 frontend: `voice:transcript_final` -> `process_voice_command`)
//!   -- PROCESSING_COMMAND / RESPONSE (reserved; never entered) -->
//! WAKE_LISTENING
//!
//! Any failure (speech timeout, mic/model error, empty transcript) walks
//! through ERROR instead and then returns to WAKE_LISTENING. RESPONSE is
//! reserved and never entered (`voice:response` is not emitted).
//! ```
//!
//! The wake-word implementation is untouched: this worker subscribes to
//! its `nila://wake-detected` event and parks the wake listener (via its
//! existing settings flag) only for the command window, so the microphone
//! is never double-opened.
//!
//! Models are NOT bundled with the app: see `models.rs` — the user
//! downloads them once, manually, from Settings (shown only when the
//! wake word is enabled). The engine below loads lazily on first wake;
//! a wake with no models present ends gracefully instead of
//! transcribing.
//!
//! Privacy: audio lives only in RAM as transient f32 blocks. Nothing is
//! ever written to disk.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use sherpa_onnx::{
    LinearResampler, OfflineRecognizer, OfflineRecognizerConfig, OfflineWhisperModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::models;
use crate::wakeword;

/// Frontend event: the post-wake voice session started (VAD armed, mic
/// captured by this worker). The pill should show the listening state.
pub const EVENT_VOICE_STARTED: &str = "voice:started";
/// Frontend event: interim transcription while the user is speaking.
/// Payload: [`PartialPayload`]. Never sent to Jev — UI only.
pub const EVENT_TRANSCRIPT_PARTIAL: &str = "voice:transcript_partial";
/// Frontend event: the final transcription. Payload [`FinalPayload`]
/// uses `{ type: "voice_command", text }` — the shape the Jev layer
/// consumes (via the frontend's `process_voice_command` call).
pub const EVENT_TRANSCRIPT_FINAL: &str = "voice:transcript_final";
/// Frontend event: Nila is finalizing (Jev handoff point).
pub const EVENT_VOICE_PROCESSING: &str = "voice:processing";
/// Frontend event: something went wrong. Payload [`ErrorPayload`].
/// NOTE: `voice:response` is reserved and is not emitted by this worker.
pub const EVENT_VOICE_ERROR: &str = "voice:error";
/// Emitted when the transcript came back empty and Nila is giving the
/// user another chance: "I didn't catch that — could you say it again?"
/// The session stays alive and re-arms the mic; the UI should keep the
/// pill open and show the prompt.
pub const EVENT_VOICE_REPEAT: &str = "voice:repeat";
/// Frontend event: the voice session fully ended and the wake-word
/// listener is back in charge. The UI should hide the voice surface.
pub const EVENT_VOICE_ENDED: &str = "voice:ended";
/// Frontend event: smoothed mic input level (0.0–1.0) for the listening
/// wave animation. Emitted ~16 Hz while the mic is captured, in both the
/// waiting-for-speech and recording phases, so the wave idles gently on
/// room tone and reacts to the user's voice instead of free-running.
/// Payload: [`LevelPayload`].
pub const EVENT_VOICE_LEVEL: &str = "voice:level";

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
/// the Jev layer's input contract.
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

/// Payload for [`EVENT_VOICE_REPEAT`]. The UI localizes the prompt
/// itself; `attempt` is the attempt that just failed (1-based).
#[derive(Clone, serde::Serialize)]
pub struct RepeatPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub attempt: u32,
}

/// Payload for [`EVENT_VOICE_ENDED`].
#[derive(Clone, serde::Serialize)]
pub struct EndedPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
}

/// Payload for [`EVENT_VOICE_LEVEL`]: normalized, smoothed mic level.
#[derive(Clone, serde::Serialize)]
pub struct LevelPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// 0.0 (silence) – 1.0 (loud), fast attack / slow release.
    pub level: f32,
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
    /// Final decode done; handing the text off to the Jev layer.
    ProcessingStt,
    /// Reserved (command processing); the backend never enters it —
    /// a second "Hi Nila" here is ignored because the wake listener
    /// is parked for the session.
    #[allow(dead_code)]
    ProcessingCommand,
    /// Final transcript emitted; returning to wake listening.
    CommandReady,
    /// Reserved (Nila's reply turn); the backend never enters it —
    /// `voice:response` is not emitted.
    #[allow(dead_code)]
    Response,
    /// A session failed (timeout / mic / model / empty transcript); the
    /// worker reports it and returns to [`Phase::WakeListening`].
    Error,
}

/// The legal edges of the state machine. Anything else is a bug: it is
/// logged loudly (and still applied, so the worker can always recover to
/// [`Phase::WakeListening`] rather than wedging).
fn can_transition(from: Phase, to: Phase) -> bool {
    use Phase::*;
    matches!(
        (from, to),
        (WakeListening, ListeningForSpeech)
            | (ListeningForSpeech, RecordingCommand)
            | (ListeningForSpeech, Error)
            | (RecordingCommand, ProcessingStt)
            | (RecordingCommand, Error)
            | (ProcessingStt, CommandReady)
            | (ProcessingStt, Error)
            // Empty transcript with attempts left: Nila asks the user to
            // repeat and the session re-arms instead of failing.
            | (ProcessingStt, ListeningForSpeech)
            | (CommandReady, WakeListening)
            | (Error, WakeListening)
            // run_forever re-asserts the idle state every loop.
            | (WakeListening, WakeListening)
    )
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
/// Frontend event: request another conversation turn without requiring
/// the wake word. Emitted by the UI after Nila answers, to keep a
/// multi-turn conversation going. The voice worker treats it exactly
/// like a wake-word detection (starts a listening session).
pub const EVENT_CONVERSATION_TURN: &str = "nila://conversation-turn";

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
    let wake_tx_wake = wake_tx.clone();
    let _ = app.listen(wakeword::EVENT_WAKE_DETECTED, move |_| {
        let _ = wake_tx_wake.send(());
    });
    // Conversation turns: the UI requests the next listening session
    // directly, without the wake word, to sustain a conversation.
    let wake_tx_conversation = wake_tx.clone();
    let _ = app.listen(EVENT_CONVERSATION_TURN, move |_| {
        let _ = wake_tx_conversation.send(());
    });
    // The STT models are a manual, settings-driven download (see
    // models.rs) — nothing fetches them automatically, so Nila works
    // fine without them. A wake with no models present ends gracefully
    // (see ensure_engine) instead of downloading.
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

/// Env vars tuning the session timeouts (seconds; floats allowed).
const ENV_SPEECH_TIMEOUT: &str = "NILA_VOICE_SPEECH_TIMEOUT";
const ENV_SILENCE_TIMEOUT: &str = "NILA_VOICE_SILENCE_TIMEOUT";
const ENV_MAX_DURATION: &str = "NILA_VOICE_MAX_DURATION";
/// Env var tuning the live-partial cadence (milliseconds).
const ENV_PARTIAL_INTERVAL_MS: &str = "NILA_VOICE_PARTIAL_MS";

const DEFAULT_SPEECH_TIMEOUT_SECS: f32 = 8.0;
/// Silence that ends a recording. Generous on purpose: the user may
/// pause mid-sentence to think, and cutting them off feels broken.
/// Nila waits for the user to actually finish.
const DEFAULT_SILENCE_TIMEOUT_SECS: f32 = 2.2;
const DEFAULT_MAX_DURATION_SECS: f32 = 20.0;
/// How many times Nila listens per wake when she can't make out the
/// words. After the last attempt she reports `empty_transcript` instead
/// of asking again — no infinite "could you repeat that?" loops.
const MAX_LISTEN_ATTEMPTS: u32 = 2;
/// Beat between the "please repeat" prompt and the mic re-arming, so
/// the prompt lands in the UI before listening resumes.
const REPEAT_BEAT: Duration = Duration::from_millis(600);
/// Live-partial cadence: fast enough to feel real-time, slow enough
/// that the repeated full-buffer re-decodes don't burn the CPU. Only
/// re-decodes when at least `MIN_PARTIAL_NEW_SECS` of new audio arrived
/// since the last decode (coalescing). Whisper's encoder-decoder is
/// slower than the old CTC model, so partials run at ~1.2s cadence —
/// still live in the pill, just less chatty.
const DEFAULT_PARTIAL_INTERVAL: Duration = Duration::from_millis(1200);
/// Minimum new audio (seconds) that must have arrived before another
/// partial decode is attempted.
const MIN_PARTIAL_NEW_SECS: f32 = 0.4;

/// Debounce after a session ends: a wake arriving this soon after is
/// treated as the tail of the same utterance (or an eager repeat) and
/// ignored, so one phrase can never start two sessions.
const WAKE_DEBOUNCE: Duration = Duration::from_millis(1500);
/// The missing-model guidance shows at most this often: repeat wakes
/// without models stay silent instead of nagging.
const MISSING_MODEL_NOTICE_COOLDOWN: Duration = Duration::from_secs(300);

/// Bounded microphone queue (chunks). The audio callback never blocks:
/// when the worker is busy decoding and the queue is full, the newest
/// chunk is dropped and counted (surfaced in the diagnostics). This
/// guarantees bounded memory even if STT ever runs slower than the mic.
const AUDIO_QUEUE_CHUNKS: usize = 256;
/// Bounded stream-error queue (a handful is plenty; errors are fatal).
const AUDIO_ERROR_QUEUE: usize = 4;

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

/// The loaded sherpa-onnx engine: one offline recognizer plus the VAD.
/// Loaded once (lazily, on first wake) and reused across sessions.
struct Engine {
    recognizer: OfflineRecognizer,
    vad: VoiceActivityDetector,
}

fn load_engine(
    encoder: &Path,
    decoder: &Path,
    tokens: &Path,
    vad_model: &Path,
) -> Result<Engine, String> {
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
    // VAD internals (per-window speech probability) go to stderr when
    // NILA_VOICE_DIAG=1 — the decisive readout when detection won't fire.
    vad_config.debug = diag_enabled();
    let vad = VoiceActivityDetector::create(&vad_config, 30.0)
        .ok_or_else(|| "failed to create Silero VAD".to_string())?;

    let mut config = OfflineRecognizerConfig::default();
    config.feat_config.sample_rate = SAMPLE_RATE;
    config.feat_config.feature_dim = 80;
    // Whisper base.en (English-only): far better on Indian English
    // accents than the previous Conformer-CTC small model. The int8
    // encoder/decoder keep it CPU-friendly.
    config.model_config.whisper = OfflineWhisperModelConfig {
        encoder: Some(encoder.to_string_lossy().into_owned()),
        decoder: Some(decoder.to_string_lossy().into_owned()),
        language: Some("en".to_string()),
        task: Some("transcribe".to_string()),
        ..Default::default()
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
    config.model_config.num_threads = 2;
    config.model_config.debug = false;
    config.model_config.provider = Some("cpu".to_string());
    config.decoding_method = Some("greedy_search".to_string());
    eprintln!("nila: voice: loading Whisper base.en model (this takes a moment)...");
    let recognizer = OfflineRecognizer::create(&config)
        .ok_or_else(|| "failed to create STT recognizer".to_string())?;
    eprintln!("nila: voice: STT engine ready");
    Ok(Engine { recognizer, vad })
}

/// Log a state transition (the state machine is small; a log line per
/// transition is the cheapest honest trace). Illegal edges are logged
/// as errors — see [`can_transition`].
fn transition(phase: &mut Phase, next: Phase) {
    if *phase == next {
        return;
    }
    if can_transition(*phase, next) {
        eprintln!("nila: voice: {phase:?} -> {next:?}");
    } else {
        eprintln!("nila: voice: INVALID transition {phase:?} -> {next:?} (applied anyway)");
    }
    *phase = next;
}

/// Lightweight development diagnostics, gated behind
/// `NILA_VOICE_DIAG=1`. Off by default: production stays quiet.
static DIAG_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn diag_enabled() -> bool {
    *DIAG_ENABLED.get_or_init(|| {
        matches!(
            std::env::var("NILA_VOICE_DIAG").as_deref(),
            Ok("1") | Ok("true")
        )
    })
}

/// One diagnostic line (wake latency, decode timings, ...). Compiled
/// out of the hot path cost-wise: a single atomic load when disabled.
fn diag(message: &str) {
    if diag_enabled() {
        eprintln!("nila: voice: [diag] {message}");
    }
}

fn emit(app: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
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

/// Wait up to `timeout` for a wake event. Returns the arrival time, or
/// `None` on stop/timeout/disconnect.
///
/// Stale queued events are coalesced: one session per burst. A wake that
/// arrives before `ignore_until` (just after a session ended) is
/// treated as the tail of the same utterance and ignored, so a single
/// phrase can never start two sessions back-to-back.
fn await_wake(
    stop: &Arc<AtomicBool>,
    wake_rx: &mpsc::Receiver<()>,
    timeout: Duration,
    ignore_until: Instant,
) -> Option<Instant> {
    // Coalesce anything already queued.
    let mut pending = false;
    while wake_rx.try_recv().is_ok() {
        pending = true;
    }
    if pending && Instant::now() >= ignore_until {
        return Some(Instant::now());
    }
    // Either nothing queued, or a stale burst inside the debounce
    // window (already drained above): keep waiting.
    let deadline = Instant::now() + timeout;
    while !stop.load(Ordering::SeqCst) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match wake_rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(()) => {
                while wake_rx.try_recv().is_ok() {}
                let now = Instant::now();
                if now >= ignore_until {
                    return Some(now);
                }
                diag("wake arrived inside post-session debounce; ignoring");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
    None
}

/// Outer loop: wait for wake detections and run one voice session each.
/// The engine loads lazily on first wake so app startup pays nothing,
/// and stays loaded afterwards (no 40–50 MB reload per command).
fn run_forever(app: &AppHandle, stop: &Arc<AtomicBool>, wake_rx: mpsc::Receiver<()>) {
    let mut engine: Option<Engine> = None;
    let mut phase = Phase::WakeListening;
    let mut last_missing_notice: Option<Instant> = None;
    let mut ignore_wake_until = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        transition(&mut phase, Phase::WakeListening);
        let Some(wake_at) = await_wake(stop, &wake_rx, Duration::from_secs(3600), ignore_wake_until)
        else {
            continue;
        };
        run_session(app, &mut engine, stop, &mut phase, wake_at, &mut last_missing_notice);
        ignore_wake_until = Instant::now() + WAKE_DEBOUNCE;
        if let Some(eng) = engine.as_ref() {
            eng.vad.reset();
        }
    }
    eprintln!("nila: voice: worker stopped");
}

/// Load the STT engine on first wake. The models are a manual download
/// from Settings (shown only when the wake word is enabled) — if they
/// aren't present the session degrades gracefully with `models_missing`
/// and the wake listener is restored, so Nila keeps working without
/// voice commands.
///
/// [`ModelManager::verify`] runs first: a present-but-truncated set is
/// reported as `model_error` (with a re-download hint) instead of being
/// handed to sherpa.
fn ensure_engine(app: &AppHandle) -> Result<Engine, (&'static str, String)> {
    let paths = models::ModelManager::new(app).verify().map_err(|e| {
        if models::resolve_models(app).is_none() {
            (
                "models_missing",
                "voice models not downloaded — available in Settings".to_string(),
            )
        } else {
            (
                "model_error",
                format!("STT models failed verification ({e}); re-download them in Settings"),
            )
        }
    })?;
    let t0 = Instant::now();
    let engine = load_engine(&paths.encoder, &paths.decoder, &paths.tokens, &paths.vad)
        .map_err(|e| ("model_error", format!("STT engine failed to load: {e}")))?;
    diag(&format!(
        "STT engine load: {} ms",
        t0.elapsed().as_millis()
    ));
    Ok(engine)
}

/// One post-wake voice session: park the wake listener, capture the
/// command, transcribe, emit events, hand the mic back.
///
/// When the STT models aren't installed this returns before touching
/// the microphone at all: the wake listener keeps running untouched,
/// and the "get them in Settings" guidance shows at most once per
/// [`MISSING_MODEL_NOTICE_COOLDOWN`] so repeat wakes don't nag.
fn run_session(
    app: &AppHandle,
    engine: &mut Option<Engine>,
    stop: &Arc<AtomicBool>,
    phase: &mut Phase,
    wake_at: Instant,
    last_missing_notice: &mut Option<Instant>,
) {
    let session_t0 = Instant::now();

    if models::ModelManager::new(app).verify().is_err() {
        // Models missing (or failed verification): free the engine if
        // the user deleted them mid-run, then degrade gracefully.
        if engine.take().is_some() {
            eprintln!("nila: voice: STT models unavailable; engine unloaded");
        }
        let due = last_missing_notice
            .map(|t| t.elapsed() >= MISSING_MODEL_NOTICE_COOLDOWN)
            .unwrap_or(true);
        if due {
            *last_missing_notice = Some(Instant::now());
            transition(phase, Phase::ListeningForSpeech);
            emit(app, EVENT_VOICE_STARTED, StartedPayload { kind: "voice:started" });
            transition(phase, Phase::Error);
            emit_error(
                app,
                "models_missing",
                "voice commands need the STT model — get it in Settings → General → Voice models",
            );
            emit(app, EVENT_VOICE_ENDED, EndedPayload { kind: "voice:ended" });
            transition(phase, Phase::WakeListening);
        } else {
            diag("models missing; notice suppressed by cooldown");
        }
        return;
    }

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

    // Lazy engine load on first wake; reused for every later command
    // (the 40–50 MB model is never reloaded per command).
    if engine.is_none() {
        match ensure_engine(app) {
            Ok(loaded) => *engine = Some(loaded),
            Err((code, message)) => {
                transition(phase, Phase::Error);
                emit_error(app, code, message);
                emit(app, EVENT_VOICE_ENDED, EndedPayload { kind: "voice:ended" });
                restore_wake_listener(app, wake_was_enabled);
                return;
            }
        }
    }
    let eng = engine.as_ref().expect("engine loaded above");

    // Listen attempts: if Nila hears speech but can't make out the
    // words, she asks the user to repeat instead of failing outright.
    // The mic is re-opened per attempt so each capture starts with a
    // clean channel.
    for attempt in 1..=MAX_LISTEN_ATTEMPTS {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let audio = match open_audio() {
            Ok(audio) => {
                diag(&format!(
                    "wake->mic-open latency: {} ms (attempt {attempt})",
                    wake_at.elapsed().as_millis()
                ));
                audio
            }
            Err(e) => {
                transition(phase, Phase::Error);
                emit_error(app, "mic_error", format!("microphone unavailable: {e}"));
                // The UI must always see the session end, even when the mic
                // never opened — otherwise the pill sticks on "listening".
                emit(app, EVENT_VOICE_ENDED, EndedPayload { kind: "voice:ended" });
                restore_wake_listener(app, wake_was_enabled);
                return;
            }
        };
        // The pill is already in the listening state from the repeat
        // prompt; no need to re-announce. The retry's partials will
        // update it, or the timeout/error path ends the session.
        let outcome = capture_command(
            app,
            eng,
            &audio,
            stop,
            phase,
            wake_at,
            speech_timeout,
            silence_timeout,
            max_duration,
            partial_interval,
        );
        // The stream is dropped here: capture stops, mic released.
        let dropped = audio.dropped_chunks.load(Ordering::Relaxed);
        drop(audio);
        if dropped > 0 {
            eprintln!("nila: voice: dropped {dropped} audio chunks (queue full during decode)");
        }

        match outcome {
            Outcome::Stopped => { break; /* app is exiting; nothing to emit */ }
            Outcome::SpeechTimeout => {
                transition(phase, Phase::Error);
                emit_error(app, "speech_timeout", "no speech heard after the wake word");
                break;
            }
            Outcome::MicError => {
                transition(phase, Phase::Error);
                emit_error(app, "mic_error", "microphone stream ended unexpectedly");
                break;
            }
            Outcome::Done { samples } => {
                // Finalize, then walk PROCESSING_STT -> (Jev handoff) -> idle.
                transition(phase, Phase::ProcessingStt);
                let t0 = Instant::now();
                let text = decode_text(&eng.recognizer, &samples);
                diag(&format!(
                    "final decode: {} ms ({} samples)",
                    t0.elapsed().as_millis(),
                    samples.len()
                ));
                let text = text.trim().to_string();
                if text.is_empty() && attempt < MAX_LISTEN_ATTEMPTS {
                    // Heard something but couldn't make out words — give
                    // the user another chance instead of failing.
                    eprintln!(
                        "nila: voice: empty transcript (attempt {attempt}/{MAX_LISTEN_ATTEMPTS}); asking user to repeat"
                    );
                    emit(
                        app,
                        EVENT_VOICE_REPEAT,
                        RepeatPayload {
                            kind: "voice:repeat",
                            attempt,
                        },
                    );
                    transition(phase, Phase::ListeningForSpeech);
                    thread::sleep(REPEAT_BEAT);
                    continue;
                }
                if text.is_empty() {
                    transition(phase, Phase::Error);
                    emit_error(app, "empty_transcript", "couldn't make out any words");
                    break;
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
                break;
            }
            // `samples` (the only large buffer, ≤ max_duration of audio)
            // is dropped here with the Outcome.
        }
        }
    }
    diag(&format!(
        "session total: {} ms",
        session_t0.elapsed().as_millis()
    ));
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
    wake_at: Instant,
    speech_timeout: f32,
    silence_timeout: f32,
    max_duration: f32,
    partial_interval: Duration,
) -> Outcome {
    let session_start = Instant::now();
    let mut first_speech_at: Option<Instant> = None;
    let mut pending: Vec<f32> = Vec::new();
    let mut samples: Vec<f32> = Vec::new();
    let mut silence_chunks: u32 = 0;
    let mut speech_chunks: u32 = 0;
    let mut last_partial = String::new();
    let mut last_partial_at = Instant::now();
    let mut decoded_len: usize = 0;
    let mut first_partial_done = false;
    // Coalescing gate: don't spend a full-buffer re-decode on a trickle.
    let min_partial_new = (SAMPLE_RATE as f32 * MIN_PARTIAL_NEW_SECS) as usize;
    // Timeout forensics: if we hit SpeechTimeout, the one-line report
    // below says whether any audio reached the VAD at all and how loud
    // it was — "mic silent" vs "VAD not triggering" need different fixes.
    let mut windows_total: u64 = 0;
    let mut peak_total: f32 = 0.0;
    let mut detected_windows: u64 = 0;
    let mut queued_windows: u64 = 0;
    // Listening-wave level: smoothed normalized RMS, emitted ~16 Hz.
    let mut level_smooth: f32 = 0.0;
    let mut level_tick: u64 = 0;

    loop {
        if stop.load(Ordering::SeqCst) {
            return Outcome::Stopped;
        }
        // A stream error is fatal: the device is gone (or dying) and
        // retrying on a dead stream just burns CPU. The session ends
        // with `mic_error` and the worker returns to WAKE_LISTENING.
        if audio.err_rx.try_recv().is_ok() {
            eprintln!("nila: voice: audio stream error; ending capture");
            return Outcome::MicError;
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
            // Read the per-window detection BEFORE touching the segment
            // queue (see below).
            let speech = engine.vad.detected();
            // Second opinion: the segment queue (the pattern from
            // sherpa-onnx's own Rust example). A queued segment proves
            // the model heard speech even if detected() is unreliable
            // in this build.
            let queued = engine.vad.front().is_some();
            // Drain completed segments — we do our own endpointing.
            // NOTE: do NOT use clear() here. On this sherpa-onnx build
            // Clear() resets the VAD's endpointing state, so calling it
            // every 32 ms window prevents min_speech_duration from ever
            // being reached: detection can never fire and no segment
            // can ever complete. pop() only drops consumed segments and
            // is what the official example does.
            while engine.vad.front().is_some() {
                engine.vad.pop();
            }
            windows_total += 1;
            if speech {
                detected_windows += 1;
            }
            if queued {
                queued_windows += 1;
            }
            for s in &chunk {
                let a = s.abs();
                if a > peak_total {
                    peak_total = a;
                }
            }
            // Mic level for the listening wave animation: RMS of this
            // 32 ms window, normalized (0.20 ≈ loud speech) with a
            // perceptual lift, then fast-attack / slow-release smoothing
            // so the wave follows syllables without jitter. Throttled to
            // every 2nd window (~16 Hz) — plenty for animation, cheap IPC.
            {
                let rms =
                    (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt();
                let inst = (rms / 0.20).clamp(0.0, 1.0).sqrt();
                if inst > level_smooth {
                    level_smooth = inst;
                } else {
                    level_smooth += (inst - level_smooth) * 0.25;
                }
                level_tick += 1;
                if level_tick % 2 == 0 {
                    emit(
                        app,
                        EVENT_VOICE_LEVEL,
                        LevelPayload {
                            kind: "voice:level",
                            level: level_smooth,
                        },
                    );
                }
            }
            if *phase == Phase::ListeningForSpeech {
                if speech {
                    transition(phase, Phase::RecordingCommand);
                    first_speech_at = Some(Instant::now());
                    samples.extend_from_slice(&chunk);
                    speech_chunks += 1;
                    last_partial_at = Instant::now();
                    eprintln!("nila: voice: speech detected");
                    diag(&format!(
                        "wake->speech-start latency: {} ms",
                        wake_at.elapsed().as_millis()
                    ));
                } else if session_start.elapsed().as_secs_f32() >= speech_timeout {
                    eprintln!(
                        "nila: voice: speech timeout: {windows_total} VAD windows in {:.1}s, peak {peak_total:.4}, detected {detected_windows}, queued {queued_windows}",
                        session_start.elapsed().as_secs_f32()
                    );
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
                // Throttled two ways: by cadence AND by requiring a
                // minimum amount of new audio, so a slow decode can't
                // trigger a decode storm on the next tick.
                let new_since_decode = samples.len().saturating_sub(decoded_len);
                if last_partial_at.elapsed() >= partial_interval
                    && new_since_decode >= min_partial_new
                {
                    decoded_len = samples.len();
                    last_partial_at = Instant::now();
                    let t0 = Instant::now();
                    let text = decode_text(&engine.recognizer, &samples);
                    let decode_ms = t0.elapsed().as_millis();
                    if !first_partial_done {
                        first_partial_done = true;
                        diag(&format!(
                            "first partial: {} ms after speech start (decode {decode_ms} ms)",
                            first_speech_at.map(|t| t.elapsed().as_millis()).unwrap_or(0)
                        ));
                    }
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
                // The cap runs from first speech, not from the wake: the
                // user gets their full command window even if they
                // paused before starting to speak.
                if let Some(t) = first_speech_at {
                    if t.elapsed().as_secs_f32() >= max_duration {
                        eprintln!("nila: voice: max command duration reached");
                        return Outcome::Done { samples };
                    }
                }
            }
        }
    }
}

/// Decode 16 kHz mono samples with the offline Whisper model.
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
/// bounded channel of mono 16 kHz blocks, a stream-error channel, and
/// an optional resampler for devices whose native rate isn't 16 kHz.
///
/// The queue is bounded ([`AUDIO_QUEUE_CHUNKS`]): the audio callback
/// uses `try_send` and never blocks, so memory stays flat even if a
/// partial decode keeps the worker busy. Dropped newest chunks are
/// counted in `dropped_chunks` and reported at session end.
struct AudioInput {
    _stream: cpal::Stream,
    rx: mpsc::Receiver<Vec<f32>>,
    err_rx: mpsc::Receiver<String>,
    resampler: Option<LinearResampler>,
    dropped_chunks: Arc<AtomicUsize>,
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
    let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(AUDIO_QUEUE_CHUNKS);
    let (err_tx, err_rx) = mpsc::sync_channel::<String>(AUDIO_ERROR_QUEUE);
    let dropped_chunks = Arc::new(AtomicUsize::new(0));
    // One error closure per stream build (each branch moves its own):
    // the callback thread must never block, so the send is best-effort.
    // The worker treats the first reported error as fatal — a dead
    // device ends the session with `mic_error` instead of spinning.
    let err_fn_for = |err_tx: mpsc::SyncSender<String>| {
        move |err| {
            eprintln!("nila: voice: audio stream error: {err}");
            let _ = err_tx.try_send(format!("{err}"));
        }
    };
    // Build the stream config explicitly (channels/rate from the device,
    // default buffering) rather than relying on SupportedStreamConfig
    // accessors that vary across cpal versions.
    let stream_config = cpal::StreamConfig {
        channels: channels_u16,
        sample_rate: supported.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let tx = tx.clone();
            let dropped = dropped_chunks.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &_| {
                    if data.is_empty() {
                        return;
                    }
                    if tx.try_send(downmix_f32(data, channels)).is_err() {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                },
                err_fn_for(err_tx.clone()),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let tx = tx.clone();
            let dropped = dropped_chunks.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &_| {
                    if data.is_empty() {
                        return;
                    }
                    if tx.try_send(downmix_i16(data, channels)).is_err() {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                },
                err_fn_for(err_tx.clone()),
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let tx = tx.clone();
            let dropped = dropped_chunks.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _: &_| {
                    if data.is_empty() {
                        return;
                    }
                    if tx.try_send(downmix_u16(data, channels)).is_err() {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                },
                err_fn_for(err_tx),
                None,
            )
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| format!("build input stream: {e}"))?;
    stream.play().map_err(|e| format!("start stream: {e}"))?;
    Ok(AudioInput {
        _stream: stream,
        rx,
        err_rx,
        resampler,
        dropped_chunks,
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
    fn state_machine_allows_the_happy_path() {
        use Phase::*;
        let path = [
            WakeListening,
            ListeningForSpeech,
            RecordingCommand,
            ProcessingStt,
            CommandReady,
            WakeListening,
        ];
        for w in path.windows(2) {
            assert!(can_transition(w[0], w[1]), "{:?} -> {:?}", w[0], w[1]);
        }
    }

    #[test]
    fn state_machine_allows_error_recovery() {
        use Phase::*;
        for from in [ListeningForSpeech, RecordingCommand, ProcessingStt] {
            assert!(can_transition(from, Error), "{from:?} -> Error");
        }
        assert!(can_transition(Error, WakeListening));
    }

    #[test]
    fn state_machine_rejects_invalid_edges() {
        use Phase::*;
        // A second wake must never start a session mid-command; the
        // response turn must never feed back into listening.
        assert!(!can_transition(RecordingCommand, ListeningForSpeech));
        assert!(!can_transition(ProcessingStt, RecordingCommand));
        assert!(!can_transition(CommandReady, RecordingCommand));
        assert!(!can_transition(Response, WakeListening));
        assert!(!can_transition(ProcessingCommand, RecordingCommand));
        assert!(!can_transition(WakeListening, RecordingCommand));
    }

    #[test]
    fn await_wake_honors_post_session_debounce() {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<()>();

        // A wake arriving mid-wait but inside the debounce window is
        // ignored: the worker keeps waiting instead of starting a
        // session.
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            let _ = tx2.send(());
        });
        let ignore_until = Instant::now() + Duration::from_secs(3600);
        let got = await_wake(&stop, &rx, Duration::from_millis(150), ignore_until);
        assert!(got.is_none(), "debounced wake must not start a session");

        // After the window, a wake arrives normally.
        tx.send(()).unwrap();
        let got = await_wake(
            &stop,
            &rx,
            Duration::from_millis(50),
            Instant::now() - Duration::from_secs(1),
        );
        assert!(got.is_some());
    }

    #[test]
    fn await_wake_coalesces_bursts_into_one() {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<()>();
        tx.send(()).unwrap();
        tx.send(()).unwrap();
        tx.send(()).unwrap();
        let got = await_wake(
            &stop,
            &rx,
            Duration::from_millis(50),
            Instant::now() - Duration::from_secs(1),
        );
        assert!(got.is_some());
        // The burst was drained: nothing left queued.
        assert!(rx.try_recv().is_err());
    }
}
