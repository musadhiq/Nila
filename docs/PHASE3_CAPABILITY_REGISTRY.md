# Nila — Phase 3: Capability Registry & Action Execution Boundary

**Date:** 2026-10-04
**Base:** Phase 2 implementation (uncommitted) on remote `main` `998c34d`
**Sources of truth:** `docs/PHASE1_ARCHITECTURE_AUDIT.md`,
`docs/PHASE2_CONVERSATION_CORE.md`
**Status:** Implemented, hand-reviewed (no cargo on this VM) — needs
`cargo test` + `tauri dev`. Frontend untouched (backend-only phase).

Phase 3 extracts Nila's executable capabilities from the JEV
architecture into a generic Capability Registry and Action Execution
boundary. The planner (JEV today, the SLM tomorrow) produces an
`ActionRequest`; the system resolves the capability, validates it
against a closed schema, applies the safety policy, and executes.
**The planner never executes anything.**

---

## 1. Target architecture (as built)

```text
UserInput
  ↓
Conversation Core (unchanged from Phase 2)
  ↓
Planner → PlanResult::Action { request: ActionRequest, .. }
  ↓
execute_validated: schema::validate (mandatory, unchanged)
  ↓
ActionRequest::from_validated (validated → request; None → unknownCommand)
  ↓
CapabilityRegistry::resolve        ← unknown id → rejected
  ↓
policy::validate_params            ← closed schema gate
  ↓
policy::check_request              ← safety / confirmation gate
  ↓
Capability::execute                ← the system is touched here
  ↓
ActionResult → jev:result event → Conversation Core (frontend)
```

## 2. Files created — `src-tauri/src/capabilities/`

| File | Responsibility |
|------|----------------|
| `mod.rs` | Architecture docs, re-exports |
| `capability.rs` | `Capability` trait, `ParamSpec`/`ParamKind`, `SafetyClass` (moved from `jev::interpret`), `ActionRequest` (moved from `conversation::types`, `safety_class` now the enum), `ActionResult`/`ActionStatus` (moved from `jev::executor`) |
| `registry.rs` | `CapabilityRegistry`: `with_builtins()` (12), `resolve()`, `register()` (duplicate panics), `ids()` |
| `policy.rs` | `validate_params` (closed schema), `check_request` → `PolicyDecision::{Allow,Deny,NeedsConfirmation}` |
| `executor.rs` | `execute_action`: resolve → schema → policy → execute → `ActionResult` |
| `builtins.rs` | The 12 capabilities, executor logic moved verbatim from `jev/executor.rs` |

## 3. The twelve capabilities

| id | Safety | Confirm | Description |
|----|--------|---------|-------------|
| `open_application` | Config | no | Launch allowlisted app |
| `close_application` | Destructive | **yes** | `pkill -x` on allowlisted binary |
| `open_in_application` | Config | no | Open resolved file/folder in allowlisted app |
| `find_file` | ReadOnly | no | Bounded name search in home |
| `search_files` | ReadOnly | no | Bounded extension search in home |
| `open_file` | Config | no | Open via `xdg-open` (validated path) |
| `open_folder` | Config | no | Open known folder / home-relative path |
| `create_folder` | Config | no | `mkdir` directly under home |
| `set_reminder` | Config | no | One-time reminder in SQLite |
| `cancel_reminder` | Destructive | **yes** | Delete most-recent reminder |
| `system_info` | ReadOnly | no | RAM/CPU/disk/battery, read-only |
| `cancel` | ReadOnly | no | Acknowledge cancellation (no system effect) |

Each declares: stable `id`, one-line `description`, closed
`parameter_schema` (`Text`/`PathSegment`/`Enum`/`DateTime`, required
flags, length caps), `safety_class`, `requires_confirmation`
(default: Destructive → true), and `execute`.

## 4. Files modified / deleted

| File | Change |
|------|--------|
| `src-tauri/src/jev/executor.rs` | **Deleted.** `ActionExecutor` dispatch replaced by the boundary; all logic moved to `capabilities/builtins.rs` |
| `src-tauri/src/jev/mod.rs` | Removed `mod executor`; `execute_validated` SystemAction branch → `from_validated` → `execute_action`; module docs updated to Phase 3 |
| `src-tauri/src/jev/interpret.rs` | `SafetyClass` definition removed → imported from `crate::capabilities`; helper imports retargeted |
| `src-tauri/src/jev/parser.rs` | Helper imports retargeted to `crate::capabilities` |
| `src-tauri/src/jev/conversation.rs` | `ActionResult`/`ActionStatus` import retargeted |
| `src-tauri/src/conversation/types.rs` | Local `ActionRequest` removed → `pub use crate::capabilities::ActionRequest` |
| `src-tauri/src/conversation/mod.rs` | Docs updated to Phase 3 flow |
| `src-tauri/src/lib.rs` | `pub mod capabilities`; registry managed as Tauri state |

**Untouched:** `voice.rs`, `wakeword.rs`, `models.rs`, `scheduler.rs`,
`db.rs`, `system_calendar.rs`, all of `src/` and `tests/` (frontend),
`connectors/`.

## 5. Trust model

- **The planner never executes.** It produces `ActionRequest`s. In
  Phase 3 the planner is JEV (`CurrentJevPlanner`); the shape is final
  for the future SLM.
- **The registry is authoritative.** Unknown capability ids are
  rejected before anything runs. Duplicate registration panics.
- **Safety never downgrades.** `effective = max(request.safety_class,
  capability.safety_class)` — a planner declaring a destructive action
  `"read_only"` does not weaken the policy.
- **The boundary trusts no planner.** Parameters are re-validated
  against the closed schema even though JEV already validated them;
  undeclared parameters are rejected.
- **Confirmation is armed.** Capabilities declare
  `requires_confirmation()` (Destructive → true). When a request still
  owes confirmation, the policy returns `NeedsConfirmation` and nothing
  executes. **Phase 3:** JEV is the confirmation authority — its
  parser confidence + interpreter confirmation gates already ran, so its
  requests carry `requires_confirmation: false` ("no further
  confirmation owed", as in Phase 2). The gate is unreachable via JEV
  and armed for the SLM.
- **All pre-existing security invariants hold:** no shell ever
  spawned, argv-only process launch from allowlisted/PATH-resolved
  binaries, filesystem bounded to home with depth/visited/deadline
  limits, symlinks never followed, hostile input degrades to
  `unknownCommand`.

## 6. Behavior preservation

Every `ValidatedAction` variant was traced old-path vs new-path:

- All 12 executable actions → same capability → same inner function →
  same `ActionResult` (same `response_key`, params, data).
- `ValidatedAction::Unknown` → old: executor returned
  `err("unknownCommand")`; new: `from_validated` → `None` →
  `err("unknownCommand")`. Identical payload (`{}`).
- Conversation/UI actions never reach the boundary (routed by
  `response_type()` before, as before).
- `SetReminder`: the future-time rule the validator enforced is
  re-enforced in the capability (defense in depth for the SLM path).
- `SearchFiles`: extension normalization (strip dot, lowercase,
  alphanumeric) now lives in both the schema-adjacent policy
  (`Text`) and the capability — idempotent for the JEV path.
- `CreateFolder`: traversal rejection now in the schema
  (`PathSegment`) as well as the validator.
- Event vocabulary, timings, dispositions, TTLs, confirmation flows —
  all unchanged (the boundary sits *inside* `execute_validated`; the
  core and frontend are untouched).

## 7. Tests added (Rust; needs `cargo test`)

- `registry.rs`: all 12 built-ins resolve; unknown/hostile ids don't;
  safety classes agree between requests and registry;
  destructive capabilities require confirmation; duplicate id panics.
- `policy.rs`: valid params pass; missing/unknown/non-object params
  rejected; hostile text (control chars, overlong, empty) rejected;
  shell metachars pass as inert strings; `PathSegment` rejects
  traversal; enum membership (case-insensitive); datetime shape;
  safety never downgrades; confirmation gate armed.
- `executor.rs`: empty registry resolves nothing (boundary's first
  gate).
- `builtins.rs`: all 10 pre-existing executor tests moved verbatim,
  plus a contract test (every capability has a description and
  unique parameter names).
- `capability.rs` (via registry tests): `from_validated` maps all 12
  executable `ValidatedAction`s to the right id/params/safety class;
  non-executable actions → `None`.

Note: `execute_action` itself needs an `&AppHandle`, which unit tests
cannot fabricate — its three gates are tested directly in
`registry`/`policy`, and each capability's logic via the inner
executors. Full-path coverage is `tauri dev` + the existing voice
flows.

## 8. Verification on this VM

- **Frontend:** zero changes. `tsc` shows only the two pre-existing
  error groups (`voice-wave.json` missing binary,
  `ConnectorsPage.tsx` dangling calendar refs — both the owner's
  in-flight work). Frontend tests unaffected.
- **Rust:** no cargo on this VM — full hand-review performed
  (imports, lifetimes, type alignment, behavior trace per action).
  Needs MUSADHIQ's `cargo test`.

## 9. Unresolved risks / open items

1. **Rust is uncompiled here.** The `registry_for` lifetime dance in
   `jev/mod.rs` (deref coercion on `&State<T>` at the call site) and
   the `'static` bound in `policy.rs`'s test helper are the two spots
   most likely to need a touch-up under `cargo`.
2. **`confirmRequired` response key** has no frontend i18n entry —
   unreachable via JEV, but the SLM phase must add it (EN + Manglish).
3. **Managed-state registry vs ephemeral fallback:** both build the
   same 12 built-ins; the fallback exists so the boundary can never
   fail for lack of state.
4. **`ActionRequest::from_jev_result`** (plan-time view) still takes
   unvalidated params — it is not on the execution path (the boundary
   uses `from_validated`), but the SLM phase should retire it.
5. Pre-existing items (not Phase 3): `ConnectorsPage.tsx` tsc errors,
   missing `voice-wave.json`, `motion-manifest` test, Jev API
   placeholder endpoint.

---

*End of Phase 3. The execution boundary is generic: a future
`QwenPlanner` implements `Planner::plan`, returns `ActionRequest`s,
and the registry → policy → executor path does not change.*
