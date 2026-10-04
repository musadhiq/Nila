# Nila — Phase 2: Conversation Core & Unified Contracts

**Date:** 2026-10-04
**Base commit:** `998c34d` (remote `main`)
**Source of truth:** `docs/PHASE1_ARCHITECTURE_AUDIT.md`
**Status:** Implemented, frontend-verified (`tsc`, `vite`, tests). Rust is
hand-reviewed (no cargo on this VM) — needs `cargo test` + `tauri dev`.

Phase 2 introduces the Conversation Core and unified input/action
contracts **without changing any existing behavior**. No SLM, no model
work, no STT/wake-word changes, no UI redesign, no new capabilities.
JEV remains the reasoning/execution backend, now reached only through
the `Planner` trait — the seam where the future SLM provider will be
inserted.

---

## 1. Files created

**Rust — `src-tauri/src/conversation/` (new module):**

| File | Responsibility |
|------|----------------|
| `mod.rs` | Module docs + re-exports; the Phase 2 architecture diagram |
| `types.rs` | `UserInput` envelope, `InputSource`, `ConversationState` (8 states), `ConversationDisposition` (7 values, single source of truth), `PlanResult`, `ActionRequest` compatibility view |
| `planner.rs` | `Planner` trait (`plan()` — no execution), `CurrentJevPlanner` (existing JEV pipeline behind the trait) |
| `core.rs` | `ConversationCore` (authoritative turn state), `CoreContext` (merged entity memory + pending), worker-thread turn runner, `conversation:state_changed` event |
| `commands.rs` | `conversation_submit`, `conversation_cancel`, `conversation_get_state`, `conversation_get_context`, `conversation_resolve_clarification`, `conversation_resolve_confirmation` |

**Frontend:**

| File | Responsibility |
|------|----------------|
| `src/lib/conversation.ts` | `UserInput`/`ConversationDisposition`/`SubmitReport` types, `isTerminalDisposition()`, `VoiceInputAdapter`, `TextInputAdapter`, command wrappers |
| `tests/conversation.test.ts` | Adapter envelope shapes, disposition truth table |

**Docs:**

| File | Responsibility |
|------|----------------|
| `docs/PHASE2_CONVERSATION_CORE.md` | This report |

## 2. Files modified

| File | Change |
|------|--------|
| `src-tauri/src/jev/interpret.rs` | `recover()` split into `plan_recovery()` (decision only, `pub(crate)`) + `RecoveryPlan` enum; pending-state mutation identical; removed now-unused imports |
| `src-tauri/src/jev/mod.rs` | Removed `run_pipeline`/`spawn_jev_pipeline`; `JevState` lost `ctx`/`pending` (moved to core); `execute_validated` takes `&mut ConversationContext` + `disposition`; `jev:result`/`jev:error` payloads carry `disposition`; `process_voice_command` routes through the core |
| `src-tauri/src/lib.rs` | `pub mod conversation`; manages `Arc<ConversationCore>`; 6 new commands in `invoke_handler` |
| `src/lib/voiceCommandPipeline.ts` | Input-adapter convergence point: builds `UserInput` via `VoiceInputAdapter`, submits to core; `answer()` takes disposition; busy-drop/health/safety-timer unchanged |
| `src/lib/jev.ts` | `disposition` on `JevResultPayload`/`JevError`; `processVoiceCommand` kept for contract |
| `src/App.tsx` | `showJevResponse` takes disposition; terminal list → `isTerminalDisposition()`; nothing else touched |
| `tests/voiceCommandPipeline.test.ts` | Updated to new signatures; new backend-drop tests |

## 3. Responsibilities moved

| From | To | Notes |
|------|----|-------|
| `JevState::ctx` (5-min entity memory) | `CoreContext::entities` | Same struct, same TTL, same expiry point |
| `JevState::pending` (90-s pending) | `CoreContext::pending` | Same struct, same TTL/attempts/Manglish handling |
| Turn orchestration (`run_pipeline`) | `ConversationCore::run_turn` | Same order: processing → expiry → plan → execute |
| Plan/execute interleave (`recover`) | `plan_recovery` + core `execute_plan` | Decision and execution now separate |
| Frontend terminal-intent list | `ConversationDisposition::from_plan` | Computed once in the core, shipped in payloads |
| `process_voice_command` direct pipeline | Core via `UserInput::voice` | Same IPC contract, new interior |

## 4. Responsibilities intentionally left untouched

- **STT/mic/VAD/wake-word** (`voice.rs`, `wakeword.rs`): zero changes. The adapter only translates `voice:transcript_final`.
- **Scheduler, SQLite, system monitor, system calendar**: untouched.
- **JEV reasoning**: parser, interpreter matchers, `SafetyClass` thresholds, `validate()`, allowlists, `APP_REGISTRY`, argv-only execution, `within_home` — all unchanged.
- **UI surfaces and timings**: 900 ms re-arm, `ConversationTurn` debounce bypass, silent `speech_timeout` re-arm, orphan guards, 5 s dismiss, 30 s safety timer, one-command-at-a-time frontend gate.
- **Event vocabulary**: `voice:*`, `jev:*`, `nila://*`, `REMINDER_DUE`, `TRAY_*` — no renames; `disposition` is additive.
- **`models.rs`**: STT download system untouched (AI Asset Manager is a later phase).
- **`src-tauri/src/connectors/`**: dead code, left exactly as-is.

## 5. New interfaces / contracts

```rust
// Unified input — every channel produces this.
pub struct UserInput { id, source: InputSource, text, timestamp, metadata }

// The planner boundary. Phase 2 = CurrentJevPlanner; future = SLM.
pub trait Planner: Send + Sync {
    fn plan(&self, app: &AppHandle, input: &UserInput, ctx: &Mutex<CoreContext>) -> PlanResult;
}

// Structured plan — model-agnostic; the SLM will produce this shape.
pub enum PlanResult {
    Conversation { jev_result }, Action { request, jev_result },
    UiAction { jev_result }, Clarification {..}, Confirmation {..},
    ShowReminders, Cancelled, AskRepeat, Unknown,
    Error {..}, AlreadyHandled,
}

// Future-facing action view (compatibility: capability_id = intent name).
pub struct ActionRequest { capability_id, parameters, safety_class, requires_confirmation }

// Single source of truth for "does the line stay open?"
pub enum ConversationDisposition {
    Continue, Clarify, Confirm, Execute, Complete, Cancel, Error
}
```

```typescript
// Frontend mirror of the contract.
submitConversationInput(input: UserInput): Promise<SubmitReport>
// status: "accepted" | "dropped" | "rejected_empty"
isTerminalDisposition(d): boolean // complete|error → true, else false
```

## 6. Conversation Core state diagram

```text
                          ┌──────────┐
                          │   IDLE   │◄─────────────────────┐
                          └────┬─────┘                      │
                               │ submit (gate: not busy)    │ next turn
                               ▼                            │
                     ┌──────────────────┐                    │
                     │    PROCESSING    │ (plan)             │
                     └────────┬─────────┘                    │
              ┌───────────────┼───────────────┐              │
              ▼               ▼               ▼              │
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │
     │  EXECUTING   │ │AWAITING_CLAR │ │AWAITING_CONF │      │
     │  (Action)    │ │ (Clarify)    │ │ (Confirm)    │      │
     └──────┬───────┘ └──────┬───────┘ └──────┬───────┘      │
            │                │  follow-up     │  follow-up   │
            ▼                │  → PROCESSING  │  → PROCESSING│
   ┌────────────────┐        │                │              │
   │COMPLETED/FAILED│◄───────┴────────────────┴──────────────┘
   │  /CANCELLED    │  (terminal states persist until next turn)
   └────────────────┘
```

Busy gate: `Processing`/`Executing` → new input dropped (never queued).
`Awaiting_*` accept the follow-up that resolves them. Locking: `state`
and `context` are separate mutexes, never nested.

## 7. Planner flow

```text
conversation_submit(input)
  → validate envelope (source closed set; empty → rejected_empty)
  → core.try_begin_turn (atomic; busy → dropped)
  → spawn worker → core.run_turn
      → emit jev:processing
      → expire entities (5 min) + pending (90 s)
      → planner.plan (CurrentJevPlanner):
          produce_jev_result (parser/API; may emit jev:error → AlreadyHandled)
          ├─ Unknown → interpret::plan_recovery → RecoveryPlan → PlanResult
          └─ confident → clear pending → PlanResult::from_jev_result
      → disposition = ConversationDisposition::from_plan (single source)
      → core.execute_plan:
          Execute/Conversation/UiAction → emit action_detected →
              execute_validated (validate() MANDATORY) → jev:result+disposition
          Clarification/Confirmation → jev:result(marker, disposition)
          ShowReminders → jev:ui_action (never deletes on fuzzy)
          Cancelled/AskRepeat/Unknown/Error → matching jev:result/jev:error
      → terminal state
```

## 8. Compatibility layer with JEV

`CurrentJevPlanner` is a thin adapter: it calls `produce_jev_result`
and `interpret::plan_recovery` — the same functions the old pipeline
used, in the same order, with the same pending-state mutations. The
`ActionRequest` is a *view* (`capability_id` = intent name,
`safety_class` mirrors interpreter usage); enforcement stays in JEV's
`validate()` + `SafetyClass` + confirmation gates. The future
`QwenPlanner` will implement `Planner::plan` and return the same
`PlanResult` — the core will not know the difference.

## 9. Tests added

**Rust** (`cargo test` — needs MUSADHIQ's local run):
- `types.rs`: busy-state contract, terminal-disposition parity with the
  pre-Phase-2 list, `from_jev_result` routing, `ActionRequest` view,
  `InputSource` parsing (5 tests).
- `planner.rs`: recovery→plan mapping, hostile inputs never plan an
  `Action`, Manglish confirmations (`athe`/`shari`/`seri`/`mathi`) →
  `Action`, Manglish negatives (`venda`/`alla`) → `Cancelled` (5 tests).
- `core.rs`: one-command-at-a-time gate (incl. `Awaiting_*` accepting
  follow-ups), context snapshot shape (3 tests).
- `commands.rs`: source validation, id generation, trimming (3 tests).

**Frontend** (verified: 20/20 pass, suite 137/138):
- `tests/conversation.test.ts`: adapter envelopes, disposition truth table.
- `tests/voiceCommandPipeline.test.ts`: updated signatures; backend
  `"dropped"`/`"rejected_empty"` → silent idle reset; old error payload
  fallback.

**19 requirements coverage:** 1–5, 12–13, 19 frontend; 6–11, 14–18 Rust
(existing interpreter/executor/context suites pin the preserved
behavior; new tests pin the new boundaries).

## 10. Before/after behavioral results

See `docs/PHASE2_REGRESSION_TABLE_DRAFT.md` for the full 23-row table.
Summary: every row's user-visible behavior is unchanged — same events
in the same order, same re-arm/dismiss timings, same TTLs, same
confirmation gates, same security invariants. The only wire-visible
delta is the additive `disposition` field on `jev:result`/`jev:error`.

**Verification on this VM:**
- `npx tsc --noEmit`: zero errors in Phase 2 code (10 pre-existing
  `ConnectorsPage.tsx` errors from the owner's re-added files remain).
- `vite build`: blocked only by the same pre-existing ConnectorsPage
  errors (verified identical on the pristine tree).
- Frontend tests: 137/138 (only pre-existing `motion-manifest` failure).
- Rust: hand-reviewed; **needs `cargo test`**.

## 11. Unresolved migration risks

1. **Rust is uncompiled here.** The refactor is mechanical and reviewed,
   but `cargo test` on MUSADHIQ's machine is the real gate.
2. **`conversation:state_changed`** is emitted but unsubscribed in
   Phase 2 — future adapters must not assume the frontend drives state.
3. **Two busy gates** (frontend pipeline + core `claim_turn`) coexist
   until parity is proven; the frontend's remains primary.
4. **`process_voice_command`** still exists as a core-routed shim; it
   can be retired once no caller uses it.
5. **Pre-existing breakage** (not Phase 2): `ConnectorsPage.tsx` tsc
   errors, missing `voice-wave.json` binary, `motion-manifest` test —
   all need MUSADHIQ's action.
6. **The Jev API placeholder** (`https://api.jev.example/v1`) still
   exists — the Phase 1 decision (real endpoint vs removal) is still
   open before SLM work.

---

*End of Phase 2. No SLM, no model changes, no JEV removal. The planner
boundary is ready for Phase 3.*
