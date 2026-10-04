# Nila — Phase 1 Architecture Audit

**Date:** 2026-10-04
**Audited commit:** `998c34d` (remote `main`, byte-identical to local checkout)
**Phase:** 1 — READ-ONLY architecture audit. No source files were modified, refactored, or deleted during this audit.
**Method:** three independent read-only inspections (backend `src-tauri/src/`, frontend `src/`, STT lifecycle + security deep-dive), synthesized here. Every claim carries a `FILE:LINE` reference against the audited commit. Anything that could not be confirmed from code is marked **UNVERIFIED**.
**Scope note:** this audit covers V1 as shipped. Linux-first. No telemetry, accounts, cloud backend, or generic AI/LLM exists in V1.

---

## 1. Current architecture diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTEND  (src/, React + TypeScript, Tauri WebView)                 │
│                                                                     │
│  App.tsx  ── single root component, all global state                │
│   ├─ NotificationDock   (reminder surface, top-center)               │
│   ├─ WakePill           (voice surface: VoiceWave / HeartbeatLine)  │
│   ├─ SettingsPanel      (9 pages incl. General, AI/Jev, Commands)   │
│   ├─ VoiceCommandPipeline (STT→Jev gate: idle→processing→           │
│   │                         executing→response; one-command-at-a-    │
│   │                         time drop rule; 30 s safety timer)       │
│   ├─ lib/jev.ts         (JEV bridge: commands + jevResponse())      │
│   ├─ lib/voice.ts       (voice event consts, error labels)          │
│   ├─ lib/tauri.ts       (single invoke/listen/emit choke point)     │
│   └─ lib/i18n.ts        (en + manglish, key-parity tested)          │
│                                                                     │
│  IPC: tauri invoke() ──► Rust commands                              │
│  EVENTS: voice:*, jev:*, nila://*, REMINDER_DUE, TRAY_*              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  invoke / emit / listen
┌──────────────────────────────▼──────────────────────────────────────┐
│  BACKEND  (src-tauri/src/, Rust, nila_lib crate)                     │
│                                                                     │
│  lib.rs ── run(): tray, window, plugins, threads, shutdown          │
│   ├─ main.rs: thin shim → nila_lib::run()                           │
│   ├─ commands.rs ── 26 Tauri commands (the IPC surface)             │
│   ├─ wakeword.rs ── nila-wake-listener thread (micro-wakeword)      │
│   ├─ voice.rs ── nila-voice-worker thread (mic+VAD+STT state machine)│
│   ├─ models.rs ── ModelManager (STT download/verify/storage)        │
│   ├─ jev/ ── action layer                                           │
│   │    ├─ mod.rs ── run_pipeline, ResponseType routing, JEV_MODE    │
│   │    ├─ schema.rs ── Intent enum (27), validate(), clean_text     │
│   │    ├─ parser.rs ── deterministic local parser                   │
│   │    ├─ interpret.rs ── fuzzy recovery, SafetyClass, 90 s pending │
│   │    ├─ context.rs ── ConversationContext (5 min TTL)             │
│   │    ├─ executor.rs ── File/Application/System/Reminder executors │
│   │    ├─ api.rs / credentials.rs ── optional Jev API + keychain    │
│   │    ├─ ui_action.rs ── jev:ui_action emission                    │
│   │    └─ conversation.rs ── conv* reply keys                       │
│   ├─ scheduler.rs ── nila-scheduler thread, deadline computation     │
│   ├─ db.rs ── SQLite (settings, reminders, history, snoozed)        │
│   ├─ system_monitor.rs ── /proc,/sys readers, 60 s tick             │
│   ├─ system_calendar.rs ── GNOME EDS calendar sync (D-Bus + ICS)     │
│   └─ connectors/ ── DEAD CODE (google_calendar, not compiled)       │
│                                                                     │
│  OS: CPAL mic │ sherpa-onnx STT │ tflite wake │ keyring │ SQLite    │
└─────────────────────────────────────────────────────────────────────┘
```

Key structural facts:

- `src-tauri/src/main.rs:1-13` is intentionally thin; all logic lives in the `nila_lib` crate (`src-tauri/src/lib.rs`) for unit-testing.
- `lib.rs:10-18` declares modules: `commands`, `db`, `jev`, `models`, `scheduler`, `system_calendar`, `system_monitor`, `voice`, `wakeword`. There is **no `mod connectors`** — `src-tauri/src/connectors/` (google_calendar) exists on disk but is not compiled and has zero references from any live module (§9, §13).
- `run()` (`lib.rs:321-427`): opens the SQLite DB at `~/.local/share/nila/nila.db` (`lib.rs:435-447`), runs migrations, manages `DbState`, `SchedulerGen`, `JevState`, `SysCalState`. Startup sequence: `seed_system_reminders` → `validate_store` → `recover_missed` → `compute_next_deadline` (`lib.rs:354-386`).
- Threads spawned at startup (`lib.rs:389-417`): `scheduler::spawn`, `system_monitor::spawn`, `wakeword::spawn` (wake toggle defaults **ON** when the DB key is missing, `lib.rs:343-348`), `voice::spawn`, `system_calendar::maybe_start`.
- Tray (`lib.rs:157-315`): Show / New Reminder / Pause↔Resume (live label) / Settings / Autostart checkbox / Quit; left-click toggles the companion window. Tray loading state (`lib.rs:199-252`): dimmed grayscale icon + localized tooltip ("Nila is starting…" / "Nila starting aakunnu…") until `set_tray_ready()` (`lib.rs:259-272`) restores the icon and emits `nila://ready` — called from `wakeword.rs` when the detector reaches `ListeningForWake`, or immediately if wake-word is disabled. **No frontend listener exists for `nila://ready`** — it is backend tray state only (verified: no listener in `src/`).
- Plugins: notification, autostart, single-instance (second launch focuses the existing window), os, process.
- Stale comments found (LOW): `lib.rs:404-413` still describes STT as "INT8 Conformer-CTC" — the engine is Whisper base.en (`voice.rs:379-401`); `wakeword.rs:46-49` says "no STT in V1".

---

## 2. Current voice/input pipeline

Voice is currently the **only** input channel. The pipeline, with exact module/event transitions:

```
Microphone (CPAL)
  │  owned by wakeword.rs while idle
  ▼
Wake word  ── wakeword.rs, thread "nila-wake-listener" (wakeword.rs:78-95)
  │  micro-wakeword tflite; model: NILA_WAKE_MODEL env or stems
  │  ["nila","okay_nabu"] searched in cwd/models, parent, exe dir,
  │  Tauri resource dir (wakeword.rs:141-230); JSON config preferred
  │  (+3 s REPEAT_COOLDOWN); bare .tflite fallback (cutoff 0.9)
  │  autostart fix: mic_is_live() samples 1500 ms RMS, threshold 1e-5;
  │  wait_for_mic retries every 5 s up to 120 s, then starts anyway
  │  (wakeword.rs:353-472); runs before EVERY listener build
  ▼  emits: nila://wake-detected {wake_word, probability}
STT session  ── voice.rs, thread "nila-voice-worker" (voice.rs:229-251)
  │  1. voice.rs parks the wake listener: wakeword::set_enabled(false),
  │     sleeps PARK_SETTLE 300 ms, opens its own CPAL stream
  │     (open_audio retries 8×, voice.rs:1095-1110)
  │  2. Phase machine (voice.rs:157-187):
  │     WakeListening → ListeningForSpeech → RecordingCommand
  │       → ProcessingStt → CommandReady → WakeListening
  │     (+ repeat edge ProcessingStt → ListeningForSpeech; illegal
  │     edges logged but applied, voice.rs:193-210)
  │  3. VAD gating (voice.rs:759-953): Silero VAD @16 kHz, 32 ms windows;
  │     accept_waveform + detected() + segment-queue second opinion;
  │     uses front()/pop() drain, never clear() (voice.rs:812-822);
  │     threshold 0.5, min_silence 0.3, min_speech 0.2, max_speech 30
  │  4. Timeouts (voice.rs:262-296): speech 8 s, silence-to-end 2.2 s,
  │     max 20 s from first speech, partials every 1200 ms
  │     (≥0.4 s new-audio coalescing), min 0.5 s speech before silence
  │     can end, FINAL_BEAT 800 ms. Env overrides NILA_VOICE_*;
  │     diagnostics NILA_VOICE_DIAG=1
  │  5. Repeat: MAX_LISTEN_ATTEMPTS=2 (voice.rs:286); empty transcript →
  │     voice:repeat + 600 ms beat + mic re-opened; second empty →
  │     empty_transcript. speech_timeout ends the session with an
  │     error (voice.rs:684-688) — backend has NO silent re-arm
  ▼  emits, in order:
     voice:started
     voice:transcript_partial {text}      ← UI ONLY, never reaches Jev
     voice:level {level 0–1}              ← ~16 Hz, fast-attack/slow-
                                            release RMS (voice.rs:920),
                                            consumed directly by VoiceWave
     voice:transcript_final {type:"voice_command", text}   ← (voice.rs:755)
                                            THE single Jev input event
     voice:processing
     voice:repeat {attempt} / voice:error {code,message}
     voice:ended
Frontend pipeline  ── src/lib/voiceCommandPipeline.ts + src/App.tsx
  │  App VOICE_EVENTS.final listener is the ONLY caller of
  │  pipeline.handleFinalTranscript (src/App.tsx:~812)
  │  1. trim; empty → {kind:"empty"} (STT already emitted its own error)
  │  2. STRICT ONE-COMMAND-AT-A-TIME: if (this.isActive())
  │     return {kind:"busy"} — second in-flight final is DROPPED,
  │     never queued (voiceCommandPipeline.ts:~176)
  │  3. health gate: await jev_get_status(); failure →
  │     fail("jevInternalError") → {kind:"unavailable"}
  │  4. setPhase("processing", text); 30 s safety timer
  │     (SAFETY_TIMEOUT_MS=30_000 → fail("jevInternalError"))
  │  5. fire-and-forget process_voice_command(text) → Rust worker thread;
  │     results return as jev:* events
  ▼
JEV  ── src-tauri/src/jev/  (see §3)
  │  emits: jev:processing {transcript}
  │         jev:action_detected {intent}
  │         jev:result {intent,status,response_key,response_params,data}
  │         jev:ui_action {action, prefill?}   (NO jev:result follows)
  │         jev:error {code, response_key}
  ▼
Execution ── ActionExecutor on the worker thread (see §6)
  │  argv-only process launches; SQLite writes; /proc reads
  ▼
Response ── jev:result → pipeline.handleResult → jevResponse(key, params,
  strings) → host answer() → App showJevResponse (src/App.tsx:722-752):
  setVoice("processing", message) + setResponseText + setResponseReady
  │  Terminal intents (src/App.tsx:728-734): goodbye, thanks, error,
  │  new_reminder, show_reminders, open_settings → conversation ends,
  │  dismiss after 5 s. Everything else non-terminal → mic re-arms
  ▼
Conversation re-arm (frontend-owned)
  │  rearmConversation (src/App.tsx:700-716) emits nila://conversation-turn
  │  after 900 ms (CONVERSATION_REARM_DELAY_MS, src/App.tsx:145)
  │  Rust maps it to WakeSignal::ConversationTurn (voice.rs:216-226),
  │  which BYPASSES the 1500 ms post-session wake debounce
  │  (WAKE_DEBOUNCE, voice.rs:300; bypass at voice.rs:483,503-507).
  │  Bare Wake detections inside the window stay debounced.
  │  voice:ended handler (src/App.tsx:873): if pipeline active → nothing;
  │  elif conversation mode + pending re-arm → rearmConversation();
  │  else → idle + hide window.
  │  speech_timeout WHILE conversation open → silent re-arm
  │  (pendingRearmRef=true, no error shown, src/App.tsx:~850-857) —
  │  this is what keeps the line open instead of dying on a bare timeout.
  ▼
UI indicators
    listening/recording → VoiceWave (voice-driven Lottie) + live partial
    working (processing/executing/response phases) → HeartbeatLine, no text
    response → bubble with answer; "Okay Nila" + × only when responseReady
```

### Transition ownership (who owns what)

| Transition | Owner module | Mechanism |
|---|---|---|
| Mic idle listening | `wakeword.rs` | dedicated CPAL stream in `Listener` |
| Wake → session handoff | `wakeword.rs` → `voice.rs` | `nila://wake-detected` event; voice parks wake listener |
| Mic during capture | `voice.rs` | own CPAL stream, 256-chunk bounded queue |
| VAD gating | `voice.rs` | Silero VAD, `front()`/`pop()` drain |
| STT decode | `voice.rs` | sherpa-onnx Whisper base.en INT8, greedy, CPU, 2 threads (`voice.rs:356-394`) |
| Partial → UI | `voice.rs` → `App.tsx` | `voice:transcript_partial` (UI-only) |
| Final → command | `voice.rs` → `App.tsx` → pipeline | `voice:transcript_final` → `handleFinalTranscript` |
| Command gate | `voiceCommandPipeline.ts` | busy-drop, health gate, safety timer |
| Backend execution | `jev/mod.rs` | `process_voice_command` → worker thread → `run_pipeline` |
| Result → UI | `jev/mod.rs` → `App.tsx` | `jev:result` / `jev:error` / `jev:ui_action` |
| Turn lifecycle | `App.tsx` (refs) | `conversationModeRef`, `pendingRearmRef`, `sessionEndedRef`, `voiceActiveRef` |
| Re-arm signal | `App.tsx` → `voice.rs` | `nila://conversation-turn` → `WakeSignal::ConversationTurn` |
| TTS | **none in backend** | §5/§12 — actual speech path UNVERIFIED |

Critical invariant: **`voice.rs` never calls Jev.** The only bridge is the `voice:transcript_final` event; the frontend's `VOICE_EVENTS.final` listener is the only caller of the pipeline, and nothing else calls `processVoiceCommand`. Partial transcripts genuinely cannot reach Jev from the frontend (verified by grep).

---

## 3. Current JEV/action architecture

### 3.1 Pipeline (`src-tauri/src/jev/mod.rs`)

`process_voice_command` (Tauri command) → worker thread → `run_pipeline` (`jev/mod.rs:132-195`):

1. `produce_jev_result` (`jev/mod.rs:224-287`): if a Jev API token is stored → POST transcript to the Jev API (`jev/api.rs`); else compile-time `Hybrid` → `LocalParser`; `ApiOnly` + no token → 5-min rate-limited `not_configured`. `JEV_MODE` is a **compile-time const** (`jev/mod.rs:57-62`), not user-configurable.
2. Bad API responses degrade to `unknown`. `Unknown` → `interpret::recover` (`jev/mod.rs:160-167`); a confident parse clears pending state (`jev/mod.rs:169-171`).
3. `execute_validated` (`jev/mod.rs:199-222`) routes on `ResponseType`: `Conversation` → reply text; `UiAction` → emits `jev:ui_action` (**and no `jev:result`**); `SystemAction` → `ActionExecutor::execute` on the worker thread.
4. Marker-intent contract (`jev/mod.rs:250-284`): clarification/confirmation questions emit `"clarify"` / `"confirm"` / `"cancel"` / `"unknown"` — **never a real action intent** — so the frontend keeps the conversation open and re-arms the mic. The frontend has no special-casing for these strings; they are non-terminal purely by omission from its terminal list.

### 3.2 The Intent enum (`src-tauri/src/jev/schema.rs:24`, 27 variants)

- **SystemAction (12):** `open_application`, `close_application`, `open_in_application`, `find_file`, `search_files`, `open_file`, `open_folder`, `create_folder`, `set_reminder`, `cancel_reminder`, `system_info`, `cancel`
- **Conversation (8):** `greeting`, `how_are_you`, `what_is_your_name`, `who_are_you`, `thanks`, `goodbye`, `current_time`, `current_date`
- **UiAction (4):** `help`, `new_reminder`, `show_reminders`, `open_settings`
- **No-op (1):** `unknown`

### 3.3 Per-action mapping table

| JEV action | Capability | Implementation location | Dependencies | Trigger format | Validation | Confirmation | Response keys | UI behavior |
|---|---|---|---|---|---|---|---|---|
| `open_application` | application | `parser.rs:267-316`, `executor.rs:210-223` | `APP_REGISTRY`, `resolve_in_path` | "open/launch/start X" | ≤120 chars, no control chars (`schema.rs:254-285`) | none | `openingApp` / `appNotFound` / `appLaunchFailed` | voice reply only |
| `close_application` | application | `parser.rs:216-229`, `executor.rs:251-285` | `APP_REGISTRY`, `pkill` via PATH | "close/quit X" | same text rules | **destructive: never executes from fuzzy** (0.95 threshold, `interpret.rs:205-213`); fuzzy → `convConfirmCloseApp` | `closingApp` / `appNotRunning` / `appNotFound` | voice reply; confirm question on fuzzy |
| `open_in_application` | application + filesystem | `parser.rs:250-266`, `executor.rs:452-491` | `APP_REGISTRY` (checked **before** fs), `FileExecutor`, `within_home` | "open X in Y" (checked before bare "open X") | both `query` + `application` required | none | `openingInApp` / `targetNotFound` / `appNotFound` | voice reply only |
| `find_file` | filesystem | `parser.rs:318-344`, `executor.rs:427-431` | bounded home walk | "find/search for/look for/locate X" | text rules | none | `filesFound` (+`data.files`) / `noFilesFound` | voice reply; `ctx.remember_search` |
| `search_files` | filesystem | `parser.rs:330-339`, `executor.rs` | bounded home walk | "find all pdf files" | extension stripped of dot, lowercased, 1–10 ASCII alnum (`schema.rs:295-307`) | none | `filesFound` / `noFilesFound` | voice reply |
| `open_file` | filesystem | `parser.rs:288-315`, `executor.rs:460-494,561-569` | `FileExecutor`, PATH-resolved `xdg-open` | "open X", "open it" (pronoun → `ctx.resolve_it()`) | best hit re-validated `is_file && within_home` | none | `openingFile` / `fileNotFound` / `noFileInContext` / `fileOpenFailed` | voice reply |
| `open_folder` | filesystem | `parser.rs`, `executor.rs:598-628` | known folders, `within_home` | "open <folder>" | known folder, or absolute path only if `is_absolute && is_dir && within_home` | none | `openingFolder` / `folderNotFound` | voice reply |
| `create_folder` | filesystem | `parser.rs:231-248`, `executor.rs:630-650` | `std::fs` | "create [a] folder [called|named] X" | rejects `/`, `\`, `..`, leading `.` (`schema.rs:316-328`); parent always `$HOME` | none | `folderCreated` / `folderExists` / `folderCreateFailed` | voice reply |
| `set_reminder` | reminder | `parser.rs:400-421,542-640`, `executor.rs:645-691` | `db::upsert_reminder`, `scheduler::notify_data_changed`, `ctx.remember_reminder` | "remind me to {title} at/in {time}"; times: "in 10 minutes", "tomorrow at 9", "noon"/"midnight", "7 pm"/"19:00"; past → tomorrow; empty time → dialog | title ≤80, RFC3339 future (`schema.rs:330-341`) | none (explicit time required) | `reminderSet` / `reminderSetFailed` | voice reply; id `r-jev-{millis}`, kind `custom`, schedule once/at |
| `cancel_reminder` | reminder | `parser.rs:94-112`, `executor.rs:693-716` | `ctx.last_reminder`, `db` | only "cancel/delete that/the reminder"; ambiguous "cancel my/a reminder" → `show_reminders` dialog | deletes only `ctx.last_reminder` if row still exists | **fuzzy → always `ShowRemindersList`, never deletes on a guess** (`interpret.rs:1225-1228`) | `reminderCancelled` / `noReminderToCancel` | voice reply |
| `system_info` | system | `parser.rs:346-373`, `executor.rs:719-888` | `system_monitor` readers | "how much/usage/status" + metric word | closed `SystemMetric` enum (`schema.rs:299-309`) | none (read-only) | `ramUsage` / `cpuUsage` / `diskUsage` / `batteryStatus` / `systemSummary` / `systemInfoFailed` / `noBattery` | voice reply |
| `cancel` | — | `executor.rs:927` | none | bare "cancel"/"never mind"/"stop" | — | — | `okayCancelled` | no side effects |
| `greeting` … `current_date` (8) | — | `parser.rs:375-459`, `conversation.rs:19-64` | local clock (time/date) | exact/prefix matches | — | — | `conv*` keys | voice reply; no system effect |
| `help` | ui | `ui_action.rs:27-63` | — | "what can you do?" | — | — | — | opens Settings → Commands page |
| `new_reminder` | ui | `ui_action.rs` | — | "add reminder" (+ fuzzy) | — | — | — | opens reminder editor; optional title prefill; **user reviews before save** |
| `show_reminders` | ui | `ui_action.rs` | — | "show my reminders" | — | — | — | opens reminder list |
| `open_settings` | ui | `ui_action.rs` | — | "open settings" | — | — | — | navigates to Settings |
| `unknown` | — | `mod.rs:160-167` | `interpret::recover` | parser/API rejection | — | — | `unknownCommand` / `convAskRepeat` | voice reply |

UI actions **never create/delete data** — they only emit `jev:ui_action` (`ui_action.rs:27-63`) and the frontend opens the surface.

### 3.4 Parser (`src-tauri/src/jev/parser.rs`)

Deterministic, local, closed-world. Order matters: hostile-target rejection first (`is_hostile_target`: `;|&$\`` and newlines, `parser.rs:86-89`), then `"open X in Y"` before bare `"open X"`, then per-intent phrase registries. Time parsing (`parse_reminder_time`, `parser.rs:542-640`) handles relative ("in 10 minutes"), "tomorrow at 9", "noon"/"midnight", "7 pm"/"19:00"; past times shift to tomorrow; empty time → dialog, never a guess. `split_title_time` uses last-separator split and moves trailing "tomorrow" into the time part (`parser.rs:400-421`).

### 3.5 Fuzzy recovery (`src-tauri/src/jev/interpret.rs`, 2201 lines)

Runs **only** for transcripts the parser/API rejects (`jev/mod.rs:160-167`):

- `normalize_transcript` (`interpret.rs:78-118`): lowercase, punctuation→space, filler-edge strip, repeat dedupe, **conservative typo map** (`interpret.rs:160-189`: "batter"→"battery", "crom"→"chrome", …; real words and non-Latin scripts untouched).
- `SafetyClass` thresholds: ReadOnly 0.50 / Config 0.70 / Destructive 0.95 (`interpret.rs:191-213`).
- `interpret()` (`interpret.rs:1031-1084`): 10 matchers, ≥0.30 retained, ambiguity cap 0.40.
- `decide()` (`interpret.rs:1214-1278`): missing entity + conf ≥0.45 → `Clarify`; conf ≥ safety threshold → `Execute`; conf ≥0.55 → `Confirm`; conf ≥0.30 → `AskRepeat`; else `Unknown`; `CancelReminder` → `ShowRemindersList` (never deletes on a guess).
- `PendingInteraction`: TTL 90 s, max 3 attempts (`interpret.rs:1280-1281`); `resolve_pending` understands Manglish affirmatives ("athe", "shari", "seri", "mathi") and negatives ("venda", "alla"); bare "yes" never fills an entity (`interpret.rs:1371-1476`). Hostile guard `is_hostile_raw` (`interpret.rs:241-245`). Debug behind `NILA_JEV_DEBUG=1`.

### 3.6 Follow-up context (`src-tauri/src/jev/context.rs`)

`ConversationContext`: `last_file`, `last_search_results` (≤20 `SearchHit {name, path, is_dir}`), `last_application`, `last_reminder`; TTL 5 min, `expire_if_stale` at every command start (`jev/mod.rs:176-184`). **Separate from** the 90-s `PendingInteraction` — two overlapping short-term state systems (§8).

### 3.7 Optional Jev API (`src-tauri/src/jev/api.rs`, `credentials.rs`)

- `JEV_API_BASE_URL = "https://api.jev.example/v1"` — **placeholder, still live** (`api.rs:33`; verified at line 33). `POST {base}/parse`, `GET {base}/health`; timeouts 15/10 s; token never logged; errors redacted.
- With a token stored, **every voice transcript is POSTed** as `{"transcript": "..."}` + `Authorization: Bearer <token>` (`api.rs:77-112`). Without a token, Hybrid mode uses the local parser — **in the default no-token state, zero network egress occurs from the Jev pipeline**.
- `jev_test_connection` (`mod.rs:460-491`) issues an authenticated `GET {base}/health` — user-initiated from Settings → AI/Jev.
- API responses still flow through the same `validate()` + allowlisted executor (`api.rs:1-10` docs).
- Keychain: service `"nila"`, account `"jev-api-token"` (`credentials.rs:44-45`); `jev_get_status` exposes only `{configured, connected}` booleans. Raw token lives only in the `JevPage` form state while open, cleared on leaving; never in localStorage/settings JSON; length capped at 4096, empty rejected.

### 3.8 Validation layer (`src-tauri/src/jev/schema.rs`)

`validate()` (`schema.rs:224`) funnels every intent through `clean_text` (`schema.rs:203-216`: trimmed, length-capped, control chars rejected); anything malformed → `ValidatedAction::Unknown`, never executed. Module doc states: *"Raw transcript text is NEVER executed, NEVER passed to a shell."* (`schema.rs:13`).

---

## 4. Current STT/model management architecture

```
Settings → General → VoiceModelsSection ──► invoke("download_stt_models")
                                              ("delete_stt_models")
                                                    │
src-tauri/src/models.rs — ModelManager              ▼
  is_installed() ──► {started:false} if already installed
  else download_in_background() ──► thread "nila-models-download"
       │  serialized by DOWNLOAD_LOCK (models.rs:100)
       │  + DOWNLOADING atomic; second caller blocks, then no-ops
       │  or retries cleanly (models.rs:240-294)
       ▼
  download_locked():
    1. reqwest::blocking GET, 3600 s total timeout
       ASR_TARBALL_URL (models.rs:79):
         https://github.com/k2-fsa/sherpa-onnx/releases/
         download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2
       VAD_URL: .../silero_vad.onnx
       (hardcoded consts — no config, manifest, or env override for URLs)
    2. stream → ".part" staging file (models.rs:508); rename = atomic
       commit. ASR tarball → OS temp dir, extracted member-by-member
       into .part files; size-checked BEFORE rename (models.rs:588-620).
       Members matched by file_name() only — no tar path traversal.
    3. stale .part cleaned at start (models.rs:400-411) and on failure;
       failed tarball always removed.
    4. verify(): SIZE FLOORS ONLY — encoder ≥20 MB, decoder ≥100 MB,
       VAD ≥600 KB, tokens 1 B–2 MB (models.rs:187, 353-397).
       NO SHA-256 or any checksum anywhere.
    emits: nila://models-downloading {file, downloaded_bytes, total_bytes}
           (≤ every 500 ms; total_bytes=0 if server omits Content-Length)
           nila://models-ready | nila://models-error {message}
    failure → ModelInfo.error; NO retry loop — user re-triggers.
    NO update mechanism: "Update available is not supported: the upstream
    release is pinned" (models.rs:144-145).
```

**Storage:** `<app-data>/models/stt/` → `~/.local/share/nila/models/stt/` on Linux (`models.rs:383-391`). Files: `whisper-encoder.int8.onnx`, `whisper-decoder.int8.onnx`, `tokens.txt`, `silero_vad.onnx`; legacy `model.int8.onnx` (Conformer-CTC era) removed on download/delete. Resolution order: `NILA_STT_MODEL_DIR` env → app dir → dev fallbacks (cwd/parent/exe `models/stt/`); per-file env overrides (`NILA_STT_ENCODER/DECODER/TOKENS/VAD_MODEL`) win independently; a set-but-missing env path is a hard miss, not a silent fallback. Env-override paths are delete-exempt (`delete()`, `models.rs:322-352`, only touches the app-managed dir).

**Load/unload:** lazy on first wake — `run_forever` holds `engine: Option<Engine>`; `run_session` calls `ensure_engine()` only when `engine.is_none()` (`voice.rs:643-655`). `ensure_engine` (`voice.rs:557-579`) runs `ModelManager::verify()` first, then builds the sherpa-onnx `OfflineRecognizer`. The engine **stays resident** across all commands (no per-command reload); the **only** unload path is `engine.take()` when `verify()` fails mid-run (`voice.rs:571-577`). No user-facing unload, no idle-timeout eviction.

**Error paths → user-visible messages:**

| Failure | Backend behavior | User-visible label (i18n key) |
|---|---|---|
| Network (DNS/TLS/timeout/HTTP non-2xx), disk-full, corrupt/truncated download | `nila://models-error` → `LAST_ERROR` → `stt_models_status` | `general.voiceModelsError` ("Error: {msg}"); fallback `voiceModelsFailed` ("Download failed — check your connection and try again") |
| Models missing at wake | `voice:error` code `models_missing` ("get it in Settings → General → Voice models", `voice.rs:598-608`); notice rate-limited to once per 5 min | `voice.modelsMissing` via `voiceErrorLabel` (`src/lib/voice.ts:114-132`): "Voice models aren't downloaded yet — get them in Settings → General." |
| Models present but corrupt/unloadable | `model_error` (`voice.rs:563-573`) | `voice.modelError`: "Voice models missing." — **misleading label** for the corrupt case (says "missing" when the problem is corruption) |

Note: the backend's English `message` strings are debug strings; the UI displays only the localized label (`src/lib/voice.ts:114` comment).

**Wake-word model — NOT managed by ModelManager** (separate, simpler path): bundled as Tauri resources (`src-tauri/tauri.conf.json:38-39` maps `../models/` → `models/`; repo `models/` holds `nila.json/.tflite`, `okay_nabu.json/.tflite`, `download-test-model.sh`). Resolution in `wakeword.rs:141-230`. No download, no verification, no progress events, no lifecycle management.

**TTS assets:** none. No TTS model/voice files are managed anywhere (only forward-looking comments at `jev/conversation.rs:8`, `jev/schema.rs:40`).

**Reusable for a future AI Asset Manager:** progress event contract (`nila://models-downloading/ready/error` + payload shapes); `.part` staging + atomic rename + pre-rename size check; `verify()` as an installed-gate; `DOWNLOAD_LOCK` + `DOWNLOADING` + `LAST_ERROR` concurrency pattern; `<app_data>/models/<kind>/` storage convention; `ModelInfo {status, size_bytes, error}` status snapshot; env-override escape hatches; path-traversal-safe tarball extraction.
**Gaps:** no version field, no update detection/migration, no checksums (supply-chain trust = TLS + pinned URL), hardcoded URLs (no per-asset manifest), no resume, **no cancellation** (button disabled while busy, `VoiceModelsSection.tsx:127,138`), wake-word model outside the manager.

---

## 5. Current conversation/state architecture

Conversation state is currently held in **four** places — three on the frontend, two in the backend (one pair overlapping):

```
FRONTEND (src/App.tsx) — in-memory only, lost on reload:
  conversationModeRef   "line open?" — set true on non-terminal answers
  voiceActiveRef        mirrors voicePhase !== "idle" (orphan-event guard)
  pendingRearmRef       re-arm deferred until voice:ended
  sessionEndedRef       voice:ended already arrived for this turn
  responseText / responseReady   last answer; Okay Nila visible only when
                                responseReady (never while working)
  (+ settingsRef/viewRef/pausedRef/dockRef — deliberate mirrors for
   once-registered listeners; StrictMode double-registration guarded)

FRONTEND (src/lib/voiceCommandPipeline.ts) — command gate only:
  phase: idle → processing → executing → response (transient; visible
  answer state lives in App). Owns: busy-drop, health gate, 30 s timer.

BACKEND (src-tauri/src/jev/context.rs) — ConversationContext, 5 min TTL:
  last_file, last_search_results (≤20), last_application, last_reminder.
  expire_if_stale at every command start (jev/mod.rs:176-184).

BACKEND (src-tauri/src/jev/interpret.rs) — PendingInteraction, 90 s TTL:
  max 3 attempts; question/confirmation awaiting "yes"/entity/clarify.
```

**How a follow-up works today** (e.g. "Open my project." → "Which project?" → "Nila."):

1. `interpret.rs` emits `convClarify*` as `jev:result` with marker intent `"clarify"` (never a real action intent).
2. Frontend renders the question text via `jevResponse`; `"clarify"` is non-terminal **by omission** from the terminal list (`src/App.tsx:728-734`), so `conversationModeRef=true` and the mic re-arms via `nila://conversation-turn`.
3. The follow-up transcript goes through the normal pipeline; `resolve_pending` matches it against the 90-s `PendingInteraction` (Manglish affirmatives/negatives understood; bare "yes" never fills an entity).
4. User can always cancel by hitting Okay Nila / × instead of answering — the frontend tracks no pending state, so dismissal simply orphans the backend's pending entry (expires in 90 s).

**Confirmation example** ("Delete this project." → "I found /home/user/project-old. Delete it?" → "Yes."): `close_application` fuzzy path → `convConfirmCloseApp` question; "yes" resolves via `resolve_pending` → executes. Destructive intents require SafetyClass 0.95 and **never execute from fuzzy input without confirmation**.

**State management inventory (frontend):** no context, no external store, no reducers in App — `useState` for all global state; `useRef` mirrors for once-registered handlers (deliberate, commented); one singleton `engineRef` (`CharacterEngine`, imperative, deliberately unsubscribed from App root to avoid per-frame re-renders); one `useReducer` (dock machine, `src/dock/useNotificationDock.ts:70`, `src/dock/dockMachine.ts:65-137`); one class instance (`VoiceCommandPipeline`, owns only STT→Jev decision logic).

**Persistence:** settings → backend store (`get_settings`/`update_settings`, string records; `mergeSettings`/`settingsToRecord` in `src/lib/reminders.ts`); reminders → backend SQLite with optimistic in-memory frontend copies; conversation state → **in-memory only**; Jev token → OS keychain; STT models → disk; voice text → in-memory.

---

## 6. Current system execution architecture

**Complete inventory of process launches** (repo-wide search for `Command::new`, `std::process`, `Stdio`, `shell(`, `sh -c`, `powershell`, `osascript`, `xdg-open`, Tauri shell plugin):

- **No `sh -c`, no `.shell(`, no `cmd /C`, no powershell, no osascript/applescript, no Tauri `shell` plugin** (absent from `Cargo.toml` and `capabilities/default.json`). Every `Command` uses **argv arrays — never shell strings**. This invariant is stated in code at `schema.rs:13`, `executor.rs:224-226`, `executor.rs:262-264`, `executor.rs:561-563`.

Three construction sites:

1. **`spawn_detached(bin, args)`** (`jev/executor.rs:197-206`): `Command::new(bin).args(args)`, all stdio nulled.
   - `ApplicationExecutor::open` (`executor.rs:210-223`): allowlisted PATH-resolved binary, `args=&[]`. **SAFE.**
   - `ApplicationExecutor::open_path` (`executor.rs:227-242`): same allowlisted binary, `args=&[path]` — **single argv element**; path is search-resolved and re-validated (exists + `within_home`, `executor.rs:133-138`) immediately before launch. **CAUTION** — user-derived path reaches an allowlisted app's argv; containment is good (allowlist checked *before* the filesystem is touched, `executor.rs:522-524`), residual risk is whatever the target app does with a crafted file (e.g. VS Code workspace trust prompts).
   - `open_with_os` (`executor.rs:561-568`): PATH-resolved `xdg-open` + single validated path argv. **CAUTION** — dispatches to the OS default MIME handler, so effective behavior depends on the user's MIME configuration.
   - Binary always comes from the hardcoded `APP_REGISTRY` (`executor.rs:152-179`: firefox, chrome/chromium, VS Code, terminal emulators, nautilus), resolved through `PATH` by `resolve_in_path` (`executor.rs:98-113`), which rejects names containing `/` or NUL. Exact-match on spoken names (`executor.rs:182-192`); hostile strings never match (unit-tested, `executor.rs:923-929`). The registry includes terminal emulators — "open terminal" launches an interactive shell for the user, by design the most powerful allowlisted entry.
2. **`close_application`** (`jev/executor.rs:265-283`): `Command::new(&pkill).arg("-x").arg(proc_name)`; `pkill` PATH-resolved; `proc_name` is the **registry binary's file name, never user text**. **SAFE** — with the observation that `pkill -x` kills *all* of the user's processes with that name (e.g. multiple Firefox profiles), not just Nila-launched ones.
3. **`open_url`** (`commands.rs:419-421`): `Command::new("xdg-open").arg(url)`; URL gated to `http://`/`https://` prefixes (`commands.rs:413-416`); single argv. **SAFE** — scheme allowlist blocks local-file/scheme abuse. Note: binary name hardcoded, not PATH-resolved (unlike all executor sites).

**Defense in depth:** parser `is_hostile_target` (`jev/parser.rs:86-89`), interpreter `is_hostile_raw` (`jev/interpret.rs:241-245`), schema `clean_text` (`jev/schema.rs:203-216`). **No construction anywhere builds a shell command string from user input.**

**Other execution-adjacent surfaces:**

- **No generic terminal command execution exists in V1.** There is no "run this command" intent; the closest is launching allowlisted terminal emulators with zero user-supplied arguments.
- **Filesystem writes:** `create_folder` (`std::fs::create_dir_all`, schema-validated single segment under `$HOME`); SQLite writes via `db.rs`; model downloads to the app-data dir. No other file mutation.
- **Network egress in V1:** (1) STT model download — `reqwest::blocking` GET of two hardcoded GitHub URLs, user-initiated only, TLS, 3600 s timeout, **no checksum** (supply-chain trust = TLS + pinned URL) — **CAUTION**; (2) Jev API — token-gated, placeholder domain, zero egress without a stored token (§3.7) — **CAUTION** once a token exists; (3) dead `connectors/google_calendar` uses reqwest but is not compiled — **SAFE (dead)**. Everything else is local (tflite, sherpa-onnx, SQLite, `/proc` reads, keyring). **No telemetry/analytics anywhere** (verified by search).
- **Keyring:** exactly one secret — the Jev API token, service `"nila"`, account `"jev-api-token"` (`credentials.rs:44-45`) → Secret Service on Linux. Never logged, never in event payloads, never returned to the frontend (`jev_get_status` returns booleans only); frontend holds it in memory only during the add-token form. **SAFE** — with one **UNVERIFIED**: which Secret Service backend resolves at runtime on the user's machine (memory notes "Linux keyring backend unconfirmed"). No plaintext credential storage found anywhere.
- **IPC surface** (`src-tauri/src/commands.rs`, 26 commands): `get_settings`, `update_settings` (reaches into `wakeword::set_enabled`, `scheduler::notify_data_changed`, tray refresh — `commands.rs:87-93`), `list_reminders`, `create_reminder`, `update_reminder`, `delete_reminder`, `snooze_reminder` (10/30/60 only), `pause_all`, `resume_all`, `test_reminder`, `startup_report`, `record_reminder_action`, `export_data`, `import_data` (strict envelope: `nila-export`, v1, ≤500 reminders, known keys, values ≤64 chars), `stt_models_status`, `download_stt_models`, `delete_stt_models`, `jev_get_status`, `jev_set_token` (empty/>4096 rejected), `jev_remove_token`, `jev_test_connection`, `process_voice_command` (fire-and-forget), `open_url`, `syscal_get_status`, `syscal_set_enabled`. All params validated in `commands.rs`/`schema.rs` before use; no frontend path can inject shell text.

---

## 7. Capability mapping: existing functionality → future capabilities

The future registry should expose generic capabilities (`system`, `application`, `filesystem`, `process`, `terminal`, `browser`, `reminder`, `calendar`, `media`, `notification`). Current functionality maps as follows:

| Future capability | Existing functionality | Current location | Notes for migration |
|---|---|---|---|
| `application` | `open_application`, `close_application`, `open_in_application` | `jev/executor.rs` (`ApplicationExecutor`, `executor.rs:152-285`); `APP_REGISTRY` allowlist; `spawn_detached` | Allowlist + argv-only invariant must be preserved verbatim; `pkill -x` semantics need a confirmation redesign before any generic process control |
| `filesystem` | `find_file`, `search_files`, `open_file`, `open_folder`, `create_folder` | `jev/executor.rs` (`FileExecutor`, `FolderExecutor`); bounded walk (depth 5 / 50k entries / 8 s, `executor.rs:309-312`); `within_home` | Bounds, symlink policy (never followed), and home containment are the capability's risk policy |
| `system` | `system_info` (+ `system_monitor.rs` readers) | `jev/executor.rs:719-888`; `system_monitor.rs:25-253` (battery `/sys`, cpu/mem `/proc`, disk statvfs) | Read-only today; readers already reused by both Jev and the monitor tick — natural shared capability |
| `reminder` | `set_reminder`, `cancel_reminder`, reminder CRUD commands, scheduler, dock surfaces | `jev/executor.rs:645-716`; `commands.rs`; `scheduler.rs`; `db.rs`; `src/dock/*` | Two creation paths today (`commands::create_reminder` vs `ReminderExecutor::set`) — unify behind one capability with one validation gate |
| `browser` | `open_url` (`commands.rs:419`); browser entries in `APP_REGISTRY` (firefox/chrome) | `commands.rs:410-422`; `executor.rs:152-179` | `open_url` scheme allowlist is the capability's policy seed; no raw-URL-from-voice exists today |
| `notification` | `REMINDER_DUE` → dock card; `tauri_plugin_notification` backstop (`scheduler.rs:702-711`); `test_reminder` | `scheduler.rs:636-712`; `src/dock/*`; `src/App.tsx:~505` | OS notification is the backstop surface when dock is suppressed |
| `calendar` | **Read-only sync engine, NOT a JEV capability**: `system_calendar.rs` (GNOME EDS via D-Bus `zbus`, own ICS parser, 30-min poll, diffs events into `kind=="system_calendar"` reminders 15 min before) | `system_calendar.rs:1-1033`; `syscal_get_status`/`syscal_set_enabled` | Boundary: JEV must never handle meetings (standing project rule). The future `calendar` capability should wrap this sync engine's *read* surface, never add JEV meeting intents. `src-tauri/src/connectors/` (google_calendar) is dead code — not a capability source |
| `process` | `close_application` only (via `pkill -x`) | `jev/executor.rs:265-283` | Narrow and destructive-adjacent; any broadening needs the SafetyClass-0.95 treatment |
| `terminal` | **Does not exist.** No generic command execution in V1; closest is launching allowlisted terminal emulators with zero args | — | Must be *designed*, not inherited. If added: closed command allowlist, mandatory confirmation, argv-only, no shell — the current invariants are the floor |
| `media` | **Does not exist** | — | No mapping; future work |

**What must NOT become capabilities without redesign:** arbitrary shell execution (never existed — keep it that way), meeting/calendar actions via JEV (explicitly forbidden), raw URL opening from voice (doesn't exist; `open_url` is settings-About only).

---

## 8. Dependency/coupling map

### HIGH

1. **Conversation state is split across four homes.** Frontend `App.tsx` refs own turn lifecycle (`conversationModeRef`, `pendingRearmRef`, `sessionEndedRef`, `voiceActiveRef`, `responseText/Ready`); `VoiceCommandPipeline` owns the command gate (phases); backend `ConversationContext` (5-min TTL) and `PendingInteraction` (90-s TTL) overlap in purpose. A future Conversation Core must absorb all four without breaking the exact re-arm choreography (900 ms delay, debounce bypass, silent timeout re-arm, terminal-intent semantics). This is the single biggest migration risk.
2. **Terminal-intent classification is duplicated.** `src/App.tsx:728-734` holds a frontend terminal-intent list; Rust holds `ResponseType` (`jev/mod.rs`). They are synchronized by convention only — if Rust adds a terminal intent and the frontend list isn't updated, the mic wrongly re-arms. Must become single-sourced before the SLM adds new intents.
3. **App owns turn lifecycle; the pipeline is deliberately thin.** Conversation logic is split: pipeline = gate, App = lifecycle (`src/App.tsx`, `src/lib/voiceCommandPipeline.ts` header documents this). Any Conversation Core insertion must move App's ref-state, not just wrap the pipeline.
4. **SLM non-determinism vs today's deterministic parser.** The current chain (parser → `validate()` → `SafetyClass` → allowlists → argv-only) is fully deterministic and closed-world. An SLM must not widen the action space: the Validator/Policy must remain at least as strict, and the structured plan must pass through the existing allowlist/confirmation gates unchanged.

### MEDIUM

5. **Two reminder-creation paths** with independent validation: `commands::create_reminder` (+`validate_input`) vs `ReminderExecutor::set` (schema layer, id `r-jev-{millis}`). Both write `db` + notify the scheduler directly. Not a bug today, but the `reminder` capability must unify them.
6. **Executor coupled to storage/scheduler:** `jev/executor.rs:33` imports `crate::{db, scheduler, system_monitor}` directly. Capability executors should depend on a capability interface, not concrete crate modules.
7. **`commands::update_settings` reaches into workers** (`wakeword::set_enabled`, `scheduler::notify_data_changed`, `refresh_tray_menu`, `commands.rs:87-93`). The IPC layer drives threads/tray rather than a façade — contained, but a service boundary would be cleaner.
8. **ModelManager knowledge shared** between `voice.rs` (load/verify/unload) and settings commands (download/delete/status). The AI Asset Manager should own this exclusively.
9. **Dead `connectors/` (2432 lines) + leftover `Cargo.toml` deps (`sha2`, `base64` annotated "Google Calendar connector") + orphaned frontend `src/lib/calendar.ts` / `src/components/settings/pages/ConnectorsPage.tsx`** (imported by nothing; `connectors` absent from `PageId`/nav). Not compiled, not wired — but a trap if anyone re-adds `mod connectors` or revives the page (duplicate ICS parser: dead `connectors/google_calendar/ics.rs` vs live `system_calendar.rs` parser).

### LOW

10. **Deliberate ref mirrors** (`settingsRef`/`viewRef`/`pausedRef`/`dockRef`, `voiceActiveRef` mirrors `voicePhase`) — documented, StrictMode-safe; keep the pattern if the Conversation Core stays in React.
11. **Asymmetric shutdown:** `lib.rs:461-468` stops voice/wake-word/calendar tasks but not the scheduler driver or monitor Tokio tasks — benign, inconsistent.
12. **Stale comments / doc nits:** Conformer-CTC claim (`lib.rs:404-413`), "no STT in V1" (`wakeword.rs:46-49`); model size stated four ways (~80/~160/~210 MB, 208 MB tarball); EN `voice.modelError` label says "Voice models missing." even for the corrupt-model case.
13. **Known pre-existing failure:** `tests/motion-manifest.test.ts` (needs owner's decision on retiring the manifest system after the `character/motion/` removal); `src/character/` is otherwise dev-only, though `App.tsx` still imports `motionManifest.ts` (`peekSequenceForPreset`).

---

## 9. Architectural risks

1. **SLM prompt-injection / action-space widening.** Today's security rests on a closed intent enum + allowlists + argv-only execution. An SLM that emits free-form plans could bypass the closed world unless the Validator/Policy is mandatory, non-bypassable, and at least as strict as `schema.rs` + `SafetyClass` + `APP_REGISTRY`.
2. **Conversation-state unification breaking the open line.** The "line stays open" behavior is an emergent property of four cooperating state systems (§5, §8-H1). Rewriting it in one pass risks regressing: silent re-arm on `speech_timeout`, the 900 ms → `ConversationTurn` → debounce-bypass path, orphaned-turn guards (`!voiceActiveRef` drops), and the 5 s terminal dismiss.
3. **No checksums on AI assets.** STT models verify by size floors only; supply-chain trust is TLS + pinned GitHub URL. An SLM model must have hash verification from day one — the Asset Manager cannot inherit `verify()` as-is for new assets.
4. **The Jev API placeholder contradicts "no cloud".** `https://api.jev.example/v1` is live code: the moment a token is stored, transcripts + bearer token egress to whatever domain that const holds. Before any SLM work, decide: set the real endpoint or remove the token UI. Leaving Hybrid+token in place while adding a *local* SLM creates two competing intelligence paths with different privacy properties.
5. **Memory pressure.** STT engine stays resident for the process lifetime with no idle eviction; adding a resident 0.6B SLM on low-end Linux desktops needs a load/unload strategy (the current code has exactly one unload path: `engine.take()` on verify failure).
6. **One-command-at-a-time under slower inference.** The busy-drop rule (`{kind:"busy"}`) is load-bearing for UX. SLM inference is slower than the deterministic parser; the drop/backpressure rule must be explicit in the new pipeline or overlapping turns will corrupt the shared conversation state.
7. **Single input envelope.** `voice:transcript_final` (`{type:"voice_command", text}`) is the only Jev input. Text/UI adapters must emit the identical envelope or the pipeline forks.
8. **`pkill -x` blast radius.** `close_application` kills all user processes with the binary name (e.g. every Firefox profile). Acceptable today for an allowlisted close; must not become a generic "kill process" capability without redesign.
9. **`xdg-open` MIME dispatch.** `open_file`/`open_folder`/`open_url` delegate to OS handlers — effective behavior depends on user MIME config (CAUTION, not a bug).
10. **Drift between duplicated classifications** (§8-H2) will silently break conversation behavior as intents are added.
11. **Owner-managed repo surgery still pending** (not code risks, but migration prerequisites): stale connector files need local deletion (connector corrupts binaries / cannot delete); `tests/motion-manifest.test.ts` needs the retire-manifest decision; release CI needs `libasound2-dev`; the voice-wave JSON and README banner binaries need committing before their links expire.

---

## 10. Recommended integration boundaries

Where each future piece slots in **without** disturbing the preserved layers:

```
 VOICE ──► voice.rs ──► voice:transcript_final ──┐
 TEXT  ──► TextInputAdapter (NEW) ──► same envelope ─┤
 UI    ──► UiInputAdapter  (NEW) ──► same envelope ─┤
                                                    ▼
                          ┌─────────────────────────────────┐
                          │ Conversation Core (NEW)         │
                          │ absorbs: App.tsx refs + pipeline│
                          │ phases + ConversationContext +  │
                          │ PendingInteraction → ONE store  │
                          └───────────────┬─────────────────┘
                                          │ normalized intent request
                                          ▼
                          ┌─────────────────────────────────┐
                          │ SLMProvider (NEW trait)         │
                          │  ├─ LlamaCppRuntime (future)    │
                          │  └─ OnnxRuntimeGenAI (future)   │
                          │ emits: Structured Action Plan   │
                          │ (JSON, closed schema)           │
                          └───────────────┬─────────────────┘
                                          ▼
                          ┌─────────────────────────────────┐
                          │ Validator / Policy (STRICT)     │
                          │ lineage: schema.rs validate() + │
                          │ clean_text + SafetyClass +      │
                          │ APP_REGISTRY + confirm gates.   │
                          │ REJECT anything outside the     │
                          │ closed capability schemas.      │
                          └───────────────┬─────────────────┘
                                          ▼
                          ┌─────────────────────────────────┐
                          │ Capability Registry (NEW)       │
                          │ system application filesystem   │
                          │ process terminal browser        │
                          │ reminder calendar media         │
                          │ notification                    │
                          │ each: id, schema, risk level,   │
                          │ confirmation rule, executor     │
                          └───────────────┬─────────────────┘
                                          ▼
                                   Action Executor
                          (argv-only invariant preserved;
                           executors decoupled from db/scheduler)
                                          │
                          Result ──► Conversation Core ──► UI / TTS
```

**Boundary-by-boundary notes:**

- **Input adapters:** the seam is the `voice:transcript_final` envelope (`{type:"voice_command", text}`). `voice.rs` keeps owning mic/VAD/STT untouched; new text/UI adapters produce the identical envelope. `VoiceCommandPipeline.handleFinalTranscript` becomes the adapter convergence point (busy-drop, health gate, safety timer stay).
- **Conversation Core:** new module absorbing the four state homes (§8-H1/H3). Must re-implement exactly: 900 ms re-arm, `ConversationTurn` debounce bypass, silent `speech_timeout` re-arm, orphaned-turn guards, 5 s terminal dismiss, 90-s pending with Manglish yes/no, 5-min entity context. Single-source the terminal-intent classification (§8-H2) here.
- **SLMProvider:** insert at the `produce_jev_result` seam (`jev/mod.rs:224-287`) — the exact point where a transcript becomes a structured action today. Define a `SLMProvider` trait returning a validated `StructuredActionPlan`; `llama.cpp` and ONNX Runtime GenAI become interchangeable implementors. The existing API-mode branch (`api.rs`) already proves this seam supports a "remote planner"; the SLM is its local analog. Keep the deterministic parser as fallback (today's `Hybrid` behavior).
- **Validator/Policy:** evolve `schema.rs`'s `validate()` + `clean_text` + `interpret.rs`'s `SafetyClass` + `APP_REGISTRY` + `convConfirm*` gates. Non-negotiable: closed capability schemas, allowlist-first (app checked before filesystem, as today), argv-only execution, destructive ≥0.95 + confirmation.
- **Capability Registry:** `schema.rs`'s `Intent` enum + `executor.rs`'s dispatch are the current hardcoded registry; each executor maps per §7. `terminal` and `media` have no current implementation — design new, don't inherit.
- **AI Asset Manager:** evolve `models.rs`'s `ModelManager`. Reuse: progress events, `.part` staging + atomic rename, installed-gate pattern, concurrency guards, `<app_data>/models/<kind>/` layout, status snapshot, env overrides. Add: per-asset manifest (URL + SHA-256 + version), update detection, resume, cancellation, and absorb the wake-word model (currently separate). One setup experience: "Setting up Nila's AI" (wake word → voice recognition → intelligence).
- **Untouched across all phases:** mic/VAD/STT internals, wake-word detection, scheduler/DB, `system_monitor` readers, `system_calendar` EDS engine, all UI surfaces and the event vocabulary (`voice:*`, `jev:*`, `nila://*`), i18n mechanism, the argv-only invariant.

---

## 11. Files/modules likely needing modification in later phases

**Backend (`src-tauri/src/`):**
- `jev/mod.rs` — the pipeline seam: insert Conversation Core input, SLMProvider call, keep `ResponseType` routing until the registry replaces it
- `jev/schema.rs` — `Intent` enum evolves into capability schemas; `validate()`/`clean_text` become the Validator/Policy core
- `jev/executor.rs` — executors become capability executors; **decouple** the direct `crate::{db, scheduler, system_monitor}` imports behind interfaces
- `jev/interpret.rs` — fuzzy recovery either retained as pre-SLM fallback or replaced; `PendingInteraction` merges into the unified conversation store; `SafetyClass` thresholds feed the Policy
- `jev/context.rs` — `ConversationContext` merges into the unified conversation store
- `jev/api.rs`, `jev/credentials.rs` — the API-mode decision (real endpoint vs removal); must be settled before SLM (two competing intelligence paths otherwise)
- `models.rs` — evolves into the AI Asset Manager (manifest, checksums, versions, resume, cancel, wake-word absorption)
- `commands.rs` — new commands for asset-manager status/control and SLM status; `update_settings`'s direct worker manipulation should move behind a façade
- `lib.rs` — wire new modules (Conversation Core, SLMProvider, Registry, Asset Manager)
- `voice.rs` — **only** at the event-emission seam (Voice Input Adapter); mic/VAD/capture internals stay frozen

**Frontend (`src/`):**
- `src/lib/voiceCommandPipeline.ts` — becomes the input-adapter convergence point (keep busy-drop, health gate, safety timer)
- `src/App.tsx` — turn-lifecycle refs migrate into the Conversation Core; event vocabulary and indicator wiring stay
- `src/components/settings/pages/GeneralPage.tsx` + `VoiceModelsSection.tsx` — STT UI becomes the unified "Setting up Nila's AI" experience (wake word → voice recognition → intelligence)
- `src/components/settings/pages/JevPage.tsx` — depends on the API-mode decision
- `src/lib/i18n.ts` — new keys only (mechanism stays; Manglish parity tests stay)
- `src/lib/jev.ts` — bridge grows new events/commands only additively

---

## 12. Files/modules that should remain untouched

- `src-tauri/src/voice.rs` — mic ownership, VAD gating, capture timeouts, `voice:level`, repeat logic, debounce/`WakeSignal` (seam-only changes at event emission)
- `src-tauri/src/wakeword.rs` — detection, `mic_is_live` autostart fix, model resolution
- `src-tauri/src/scheduler.rs`, `src-tauri/src/db.rs` — reminder engine, SQLite schema, eligibility, recovery
- `src-tauri/src/system_monitor.rs` — pure `/proc`/`/sys` readers
- `src-tauri/src/system_calendar.rs` — GNOME EDS sync engine (JEV never touches meetings — boundary preserved)
- `src-tauri/src/jev/executor.rs` **security invariants** — `APP_REGISTRY` allowlist, allowlist-before-filesystem ordering, `within_home` re-validation, argv-only launches (refactor around them, never relax them)
- `src/components/WakePill.tsx`, `src/components/VoiceWave.tsx`, `src/components/HeartbeatLine.tsx`, `src/dock/*` — all UX surfaces; restrained-motion behavior; reduced-motion paths
- `src/lib/i18n.ts` mechanism + `src/lib/strings.ts` (Manglish reminder voice)
- Event vocabulary: `voice:*`, `jev:*`, `nila://*`, `REMINDER_DUE`, `TRAY_*` — contracts the UX depends on
- `src-tauri/src/connectors/` — leave exactly as-is (dead, uncompiled); any deletion is the owner's local `git` action, not a code task. Documented without re-litigation per project constraints.

---

## 13. Migration risks + proposed final architecture

### Migration risks (ranked)

1. **Conversation fidelity** — the open-line behavior emerges from four state systems; unifying them is the highest regression risk. Mitigate by extracting the Conversation Core *behind* the current event vocabulary first, proving behavioral parity (same re-arm timings, same terminal list) before the SLM arrives.
2. **Action-space widening** — SLM plans must pass the existing gates unchanged (allowlist-first, argv-only, SafetyClass, confirmations). The Validator/Policy is not a filter *after* the SLM; it is the only path *to* execution.
3. **Two intelligence paths** — Hybrid API mode + local SLM with different privacy properties. Settle the `api.jev.example` placeholder (real endpoint or remove) before SLM integration.
4. **Asset integrity** — no checksums today; the Asset Manager must add SHA-256 per-asset manifests from day one, not inherit size-floor `verify()`.
5. **Memory** — resident STT + resident SLM with no eviction strategy; define load/unload (and low-memory behavior) before shipping the SLM.
6. **Backpressure** — the busy-drop rule must be explicit in the new pipeline; slower SLM inference makes overlapping turns more likely, not less.
7. **Dead code traps** — `connectors/` (duplicate ICS parser, reqwest usage) and orphaned frontend calendar files must not be revived as capability sources; the live calendar path is `system_calendar.rs`.
8. **Drift** — the duplicated terminal-intent classification must be single-sourced before new intents exist.

### Proposed final architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│    VOICE     │  │     TEXT     │  │      UI      │
│ Mic→Wake→STT │  │ input box    │  │ buttons      │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│Voice Adapter │  │Text Adapter  │  │ UI Adapter   │
│(voice.rs     │  │(NEW)         │  │(NEW)         │
│ events,      │  │              │  │              │
│ untouched)   │  │              │  │              │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       └─────────────────┴─────────────────┘
           identical envelope {type:"voice_command", text}
                           │
                           ▼
              ┌────────────────────────┐
              │   Conversation Core    │◄── unified state
              │   (NEW — one store;     │    (clarify/confirm/
              │   absorbs App refs,     │     cancel/correct/
              │   pipeline phases,      │     select/follow-up,
              │   context, pending)     │     voice+text+UI)
              └────────────┬───────────┘
                           │ normalized request
                           ▼
              ┌────────────────────────┐
              │     SLMProvider        │  Qwen3-0.6B, local,
              │  (trait — replaceable) │  NOT bundled;
              │  ├ llama.cpp           │  downloaded via
              │  └ ORT GenAI           │  AI Asset Manager
              └────────────┬───────────┘
                           │ Structured Action Plan (closed JSON schema)
                           ▼
              ┌────────────────────────┐
              │   Validator / Policy   │  lineage: schema.rs,
              │   (STRICT, mandatory)  │  SafetyClass, APP_REGISTRY,
              └────────────┬───────────┘  confirm gates
                           │ validated plan only
                           ▼
              ┌────────────────────────┐
              │  Capability Registry   │
              │  system application    │
              │  filesystem process    │
              │  terminal* browser     │
              │  reminder calendar†    │
              │  media* notification   │
              │  *new design  †read-   │
              │  only sync engine      │
              └────────────┬───────────┘
                           │ argv-only, no shell, allowlists
                           ▼
                    Action Executor
                           │ Result
                           ▼
              ┌────────────────────────┐
              │   Conversation Core    │──► UI / TTS
              │   (response shaping,   │
              │   en+Manglish)         │
              └────────────────────────┘

  AI Asset Manager (evolved models.rs): STT model, SLM model, wake-word
  model, future assets — one "Setting up Nila's AI" experience:
  ✓ Wake word → ↓ Voice recognition → ↓ Nila intelligence
  (download, progress, retry, SHA-256, versioning, storage, update,
   deletion, corruption detection, readiness)
```

**Non-goals restated for the record:** no telemetry, no cloud, no accounts; English + Manglish first-class, reminder voice Manglish; tray-first; restrained motion; JEV remains Nila's internal engine (never a separate product); voice-first public presentation (no internals); never claim unimplemented capabilities; strictly one voice command at a time; Google Calendar `connectors/` documented as-is (dead, uncompiled, owner-managed).

---

*End of Phase 1 audit. No Phase 2 implementation was performed. No source files were modified.*
