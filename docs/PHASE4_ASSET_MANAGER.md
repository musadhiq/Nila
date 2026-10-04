# PHASE 4 — Unified AI Asset Manager

**Status:** Implemented locally, uncommitted. **Rust hand-reviewed only** — no Cargo on this VM.
**Date:** 2026-10-04
**Source of truth:** `docs/PHASE1_ARCHITECTURE_AUDIT.md`, the Phase 2/3 implementation.

## Objective

Create a unified AI Asset Manager owning the **file lifecycle** of Nila's downloadable AI assets
(wake-word, STT, SLM). Models are NOT bundled with the app; they download to the client.
Inference is NOT implemented in this phase.

---

## Architecture

```text
                         NILA
                           │
                    Conversation Core        (Phase 2 — unchanged)
                           │
                        Planner
                           │
                    Action Engine            (Phase 3 — unchanged)
                           │
              ┌────────────┴────────────┐
              │                         │
         Existing JEV              Capabilities
              │                         │
              └────────────┬────────────┘
                           │
                   ┌───────────────┐
                   │ AI ASSET       │
                   │ MANAGER        │   ← NEW (this phase)
                   └───────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
     Wake-word           STT              SLM
       asset            asset            asset
          │                │                │
          ▼                ▼                ▼
     Wake-word           STT         Future SLM Provider
      Service          Service      (path reserved, no inference)
```

**Mandatory distinction:** AssetManager manages FILES. Inference services decide when to
LOAD models. The manager never loads a model.

**Consumer boundary (implemented):**

- `WakeWordService` → `AssetManager::wakeword_path()` (asset dir first, legacy fallback)
- `STTService` (`voice.rs`) → `models::ModelManager::verify()` (unchanged path/verification API)
- Future SLM → `AssetManager::get_local_path(SLM_ASSET_ID)` (reserved)

---

## Files created

### Rust — `src-tauri/src/assets/` (new module)

| File | Purpose |
|---|---|
| `mod.rs` | Module docs, re-exports, architecture diagram |
| `asset.rs` | `AIAsset`, `AssetType` (extensible via `Other`), `AssetState` (10 states), `AssetManifest`, id sanitization, version comparison |
| `storage.rs` | App-data layout, `asset_dir`/`cache_dir` with traversal guards, `statvfs` disk space (Linux), legacy STT migration |
| `downloader.rs` | Generic single-file download: resume (Range), progress, retry w/ backoff, cancellation, `.part` staging, SHA-256, atomic rename, disk-space pre-check |
| `stt.rs` | STT asset installer (tarball + VAD flow **moved** from `models.rs`), size/shape verification |
| `manager.rs` | `AssetManager`: registry, state machine, per-asset concurrency, events, readiness, updates, storage info |
| `commands.rs` | 12 Tauri commands (`ai_assets_list`, `ai_asset_status`, `ai_asset_ensure`, `ai_asset_download`, `ai_asset_cancel`, `ai_asset_remove`, `ai_asset_update`, `ai_asset_path`, `ai_asset_is_ready`, `ai_setup_state`, `ai_storage_info`, `ai_check_updates`, `ai_ensure_all`) |

### Frontend

| File | Purpose |
|---|---|
| `src/lib/aiAssetState.ts` | Types + pure helpers (`assetStateName`, `isAssetReady`, `ASSET_EVENTS`) — no Tauri imports, node:test-safe |
| `src/lib/aiAssets.ts` | Thin `ai_*` command wrappers |
| `src/components/settings/pages/AiModelsPage.tsx` | Settings → AI Models page (all assets, actions, storage) |
| `src/components/settings/pages/AiSetupPage.tsx` | First-run unified AI setup (progress bars) |
| `tests/aiAssets.test.ts` | 5 node:test tests for the bridge |

---

## Files modified

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | `pub mod assets;` + 13 new commands in `invoke_handler` |
| `src-tauri/src/models.rs` | **Rewritten as facade.** Download orchestration moved to `assets/stt.rs`. `ModelManager` now delegates lifecycle to `AssetManager`; keeps STT path/verification knowledge (env overrides, `resolve_models`, `verify_paths`). `dir()` now returns the asset dir. Legacy flat-dir fallback retained. |
| `src-tauri/src/wakeword.rs` | `search_dirs` checks the asset-managed dir **first**; added `pub(crate) resolve_model_path`. Detection algorithm, thresholds, audio pipeline unchanged. |
| `src/components/SettingsPanel.tsx` | Setup step `welcome → ai → done`; renders `AiSetupPage`; registers `AiModelsPage` |
| `src/components/settings/SettingsLayout.tsx` | `aiModels` PageId + nav entry |
| `src/components/settings/icons.tsx` | `IconAiModels` |
| `src/lib/i18n.ts` | `aiAssets` section (EN + Manglish), `page.aiModels`, `nav.aiModels` |
| `src/styles/settings.css` | AI setup / models styles |

---

## Existing STT download code migrated

**From `src-tauri/src/models.rs` → `src-tauri/src/assets/stt.rs`:**

- `download_asr_tarball` / `extract_asr_tarball` / `wanted_entry` (tarball flow)
- Size verification thresholds (`EXPECTED_*_BYTES`)
- `.part` staging + `clean_stale_parts`
- Legacy `model.int8.onnx` cleanup

**Preserved behavior:**

- Same upstream URLs (now in the manifest, not hardcoded in download logic)
- Same 4 files, same verification floors
- VAD-first download order
- Manual download only (Settings → user taps Download); nothing auto-downloads
- Legacy events `nila://models-downloading`, `nila://models-ready`, `nila://models-error` still emitted for STT (existing `VoiceModelsSection` keeps working)
- Legacy commands `stt_models_status`, `download_stt_models`, `delete_stt_models` unchanged in signature
- Env overrides (`NILA_STT_MODEL_DIR`, per-file vars) still win

**Exactly one download path:** all downloads go through `AssetManager::ensure_asset` /
`download_asset`. `models::ModelManager` is a facade; it contains no download code.

---

## Asset storage location

`<app-data>/models/<type>/<asset-id>/` via Tauri `app_data_dir` (never hardcoded):

```text
~/.local/share/nila/                    (Linux)
├── models/
│   ├── wakeword/nila-wakeword-v1/
│   ├── stt/nila-stt-whisper-base-en/
│   │   ├── whisper-encoder.int8.onnx
│   │   ├── whisper-decoder.int8.onnx
│   │   ├── tokens.txt
│   │   ├── silero_vad.onnx
│   │   └── .version
│   └── slm/nila-slm-qwen3-0.6b-q4/    (reserved)
├── cache/
└── asset-manifest.json                  (optional override)
```

**Migration:** on first `get_state`, verified legacy flat files (`<app-data>/models/stt/*.onnx`)
are moved into the asset dir (idempotent, verification-gated). Unmigrated/corrupt legacy files
are left alone; `models::resolve_models` still finds them via the legacy fallback.

---

## Manifest format

Versioned JSON. Embedded default; `<app-data>/asset-manifest.json` overrides it when present
and valid (replaceable without rebuilding). Invalid override → embedded default with a log.

```json
{
    "manifest_version": 1,
    "assets": [
        {
            "id": "nila-wakeword-v1",
            "type": "wakeword",
            "version": "1.0.0",
            "size_bytes": 0,
            "download_url": null,
            "sha256": null,
            "required": true,
            "priority": 10,
            "metadata": {}
        },
        {
            "id": "nila-stt-whisper-base-en",
            "type": "stt",
            "version": "1.0.0",
            "size_bytes": 210000000,
            "download_url": "https://github.com/k2-fsa/sherpa-onnx/.../sherpa-onnx-whisper-base.en.tar.bz2",
            "sha256": null,
            "required": true,
            "priority": 20,
            "metadata": { "vad_url": "https://github.com/k2-fsa/sherpa-onnx/.../silero_vad.onnx" }
        },
        {
            "id": "nila-slm-qwen3-0.6b-q4",
            "type": "slm",
            "version": "1.0.0",
            "size_bytes": 400000000,
            "download_url": null,
            "sha256": null,
            "required": false,
            "priority": 30,
            "metadata": { "note": "Planned Qwen3-0.6B Q4. No release infrastructure yet." }
        }
    ]
}
```

No production URLs or checksums were invented. STT URLs are the real ones already in use;
wake-word and SLM are `null` (registered, not downloadable). STT `sha256` is `null` because
upstream publishes no hashes — size/shape verification applies until then.

---

## Asset states

`NOT_INSTALLED, CHECKING, DOWNLOADING, VERIFYING, INSTALLED, CORRUPTED, UPDATE_AVAILABLE,
PAUSED, ERROR(msg), REMOVED→(transient) REMOVING` — serialized snake_case, observable via
`nila://asset-state-changed` and `ai_asset_status`. `is_ready()` = `Installed | UpdateAvailable`.

---

## Download architecture

```text
ensure_asset(id)
  → per-asset lock (duplicate downloads impossible)
  → background thread
  → DOWNLOADING + nila://asset-state-changed
  → installer (STT custom / generic single-file)
  → temporary .part file (resume via Range; kept on cancel)
  → VERIFYING
  → SHA-256 (or size/shape fallback)
  → MATCH → atomic rename → INSTALLED (+ .version sidecar)
  → MISMATCH → quarantine (.corrupt) → CORRUPTED (never exposed)
  → cancel → PAUSED (.part kept for resume)
  → network/disk failure → ERROR(msg) with retry+backoff (transient only)
```

- **Never writes** directly to the final path while downloading.
- **Disk-space pre-check** before writing (16 MB margin); insufficient → explicit error, no download starts, no other assets deleted.
- **Partial downloads:** detected on next start; resumed when the server honors `Range`, otherwise safely restarted. Partial files never count as installed.

---

## Checksum mechanism

SHA-256 via the `sha2` crate (already a dependency), streamed over the staged file **before**
the atomic rename. Mismatch → file quarantined as `.corrupt`, asset marked `CORRUPTED`,
loud error (never silent). Assets without a manifest hash (STT today) use the existing
size/shape verification as the gate.

---

## Update mechanism

- `ai_check_updates`: compares manifest version vs `.version` sidecar (`compare_versions`
  handles `1.0` == `1.0.0`); newer → `UPDATE_AVAILABLE` (asset remains usable).
- `ai_asset_update` / redownload: re-downloads to temp, verifies, atomically replaces.
  **The working model is never deleted before the new one verifies.**
- No automatic replacement: updates are user-initiated from Settings.

---

## Settings integration

New **Settings → AI Models** page (`AiModelsPage.tsx`) using only AssetManager APIs:

- Wake word / Voice recognition / Nila intelligence — each with state, version, size
- Actions: Download / Resume / Cancel / Redownload / Update / Remove (per state)
- Storage section: total AI storage, per-asset bytes, available disk space
- Background `ai_check_updates` marks `UPDATE_AVAILABLE`

The existing `VoiceModelsSection` (General page) is untouched and keeps working via the
legacy events/commands.

---

## First-run setup flow

Setup is now `Welcome → AI setup → done` (`SettingsPanel.setupStep`):

```text
Setting up Nila's AI

Voice recognition  ████████████░░░░ 72%
Nila intelligence  ████████░░░░░░░░ 45%

Preparing Nila…

[Set up AI]  [Skip for now]
```

- `ai_ensure_all`: required + downloadable assets in priority order (wakeword 10 → stt 20 → slm 30), **sequentially** (reliability over parallelism), skipping verified assets.
- **Nothing downloads until the user taps "Set up AI"** — preserves MUSADHIQ's standing manual-download decision; Nila remains fully usable without models (degraded mode).
- Already-installed assets are never redownloaded.
- Progress via `nila://asset-download-progress`; completion via `nila://asset-state-changed`.

---

## Tests added

**Rust** (inline `#[cfg(test)]`, hand-reviewed, not yet compiled):

- `asset.rs`: manifest validity, priority order, id sanitization (incl. `../` rejection), version comparison, state readiness, duplicate/bad-id manifest rejection
- `storage.rs`: asset dir within base, traversal rejection, file-name sanitization, legacy migration (moves verified, skips unverified, idempotent)
- `downloader.rs`: non-http(s) refusal, known SHA-256 digest, transient/permanent classification
- `stt.rs`: tarball entry matching, truncated-set rejection, good-set acceptance
- `manager.rs`: setup-state serialization, AssetInfo shape, error-state shape
- `models.rs`: env-override independence, truncated-model rejection (preserved)

**Frontend** (`tests/aiAssets.test.ts`, node:test): 5 tests — state normalization, readiness truth table, event-name convention, `AssetInfo` contract.

---

## Regression results

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean (2 pre-existing: `ConnectorsPage` dangling calendar refs, `VoiceWave` missing json) |
| `npm test` (node:test) | **142 pass / 1 fail** — the 1 fail is the pre-existing `motion-manifest.test.ts` (`character/motion/` absent; known since Phase 2) |
| `cargo test` | **NOT RUN** — no Rust toolchain on this VM. **MUSADHIQ must run it.** |
| `npm run tauri dev` | **NOT RUN** — needs his machine. |

**Preserved (by design, needs his runtime confirmation):**

- STT inference behavior unchanged (`voice.rs` untouched; `ModelManager::verify` same semantics)
- Wake-word detection/thresholds/audio pipeline unchanged (only search order gained the asset dir)
- Conversation Core, Capability Registry, Action Executor, JEV untouched
- All `voice:*`, `jev:*`, `nila://*` event names preserved; legacy `nila://models-*` events still emitted
- No SLM inference, no llama.cpp, no ONNX Runtime GenAI, no Qwen integration

---

## Success criteria check (Phase 4 §24)

1. ✅ Generic AI Asset Manager exists (`src-tauri/src/assets/`)
2. ✅ STT download migrated into it (single download path)
3. ✅ Wake-word represented as an asset (state tracked, path via manager)
4. ✅ SLM registered as an asset (Qwen3-0.6B placeholder, no URL)
5. ✅ Models not bundled (unchanged; manifest-driven downloads only)
6. ✅ Stored outside app install dir (platform app-data)
7. ✅ Progress + failure handling (events, retry, cancel, disk-space)
8. ✅ Checksum verified (SHA-256 infra; size/shape fallback where upstream publishes no hash)
9. ✅ Partial downloads handled (resume/restart, never installed)
10. ✅ Installed assets not redownloaded (verify-before-download)
11. ✅ Versions tracked (manifest + `.version` sidecar + update flow)
12. ✅ Settings uses AssetManager (new AI Models page)
13. ✅ Unified first-run AI setup (Welcome → AI setup → done)
14. ✅ STT behavior unchanged (needs `cargo test` + `tauri dev` to confirm)
15. ✅ Wake-word behavior unchanged (needs runtime confirm)
16. ✅ Conversation Core unchanged
17. ✅ Capability Registry unchanged
18. ✅ Action Executor unchanged
19. ✅ JEV functional (untouched)
20. ✅ No SLM inference implemented
21. ✅ No llama.cpp integrated
22. ✅ No ONNX Runtime GenAI integrated
23. ✅ Tests cover asset lifecycle (Rust unit + frontend)
24. ⚠️ Existing functionality regression — frontend green; **Rust needs `cargo test`**

---

## Unresolved issues / review items for MUSADHIQ

1. **`cargo test` is the gate.** The Rust is hand-reviewed only. Run:
   ```bash
   cd /home/musadhiq/projects/Nila/src-tauri && cargo test
   cd .. && npm run tauri dev
   ```
2. **STT `sha256: null`** — upstream k2-fsa publishes no hashes. If they appear, add to the manifest (or the override file); the downloader enforces them automatically.
3. **SLM asset is registered but not downloadable** (`download_url: null`, `required: false`). The setup flow skips it; Settings shows "Not available yet". When release infra exists, set the URL + `required: true` in the override manifest — no rebuild needed.
4. **`wakeword_path()` legacy fallback:** `wakeword::resolve_model_path` returns the JSON config path when no sibling `.tflite` exists; the service handles both via `ModelSource`. Behavior preserved.
5. **Carry-over from Phase 3:** `docs/PHASE3_CAPABILITY_REGISTRY.md` still has the stale `registry_for` note and the `SystemExecutor::disk()` `{}` vs `{"metric":"disk"}` discrepancy. **Carry-over from Phase 2:** the missing regression-table draft reference.
6. **Nothing committed or pushed.** Awaiting his explicit authorization (and the connector still can't delete `src-tauri/src/jev/executor.rs` — he must `rm` it locally after pulling).

---

## Do NOT proceed to Phase 5 automatically.

Phase 5 (SLM provider / inference) is a separate authorization.
