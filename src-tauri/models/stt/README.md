# Nila local English STT models (sherpa-onnx)

Nila's voice-command pipeline runs fully on-device (sherpa-onnx), but the
models are **not** shipped with the app and are **not** committed to the
repo. The user downloads them once (~80 MB) from the upstream
sherpa-onnx release, manually, from Settings — the download option only
appears when the wake word is enabled — into the per-user app data dir:

- Linux: `~/.local/share/nila/models/stt/`

Nothing downloads automatically. Afterwards the files are reused across
restarts and updates — reinstalling Nila never re-downloads them. Nila
works fine without the models: saying the wake word with none present
just points at Settings instead of transcribing.

## Files

| File | What | Size |
|---|---|---|
| `model.int8.onnx` | NeMo `stt_en_conformer_ctc_small`, INT8 quantized, English (~13M params, trained on ~16k hours) | ~44 MB |
| `tokens.txt` | Tokenizer vocabulary for the model (lowercase a–z, space, apostrophe) | tiny |
| `silero_vad.onnx` | Silero voice-activity detector (speech start/end detection) | ~2 MB |

Only `model.int8.onnx` + `tokens.txt` are extracted from the upstream
tarball; the full-precision `model.onnx`, test wavs and scripts are
skipped. Audio is never written to disk — downloads are the only thing
that touch the network, once.

## Sources

- ASR tarball: <https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2>
- VAD: <https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx>

See <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/english.html>
for the upstream model card. The NeMo model is NVIDIA's; check its
license before redistributing the packaged app.

## Configuration

Model resolution order (first hit wins):

1. `NILA_STT_MODEL_DIR` — a directory containing all three files.
2. `<app-data>/models/stt/` — the manual download target.
3. `models/stt/` next to the working directory or the executable (dev convenience).
4. `NILA_STT_MODEL` / `NILA_STT_TOKENS` / `NILA_STT_VAD_MODEL` — individual file paths, each winning independently.

Explicit env paths skip the download entirely.

Session timeouts are also tunable:

| Env var | Default | Meaning |
|---|---|---|
| `NILA_VOICE_SPEECH_TIMEOUT` | `8.0` | Seconds to wait for speech after the wake word |
| `NILA_VOICE_SILENCE_TIMEOUT` | `1.2` | Trailing silence (s) that ends the command |
| `NILA_VOICE_MAX_DURATION` | `20.0` | Longest a command recording may run (s), measured from first speech |
| `NILA_VOICE_PARTIAL_MS` | `400` | Live-partial re-decode cadence (ms); also gated on ≥0.4 s of new audio |
| `NILA_VOICE_DIAG` | unset | Set to `1` for dev diagnostics (wake/speech/decode latencies) on stderr |

Downloads are staged as `.part` files and atomically renamed only
after the sizes verify; an interrupted download never counts as
installed. Settings also offers Delete, which removes the downloaded
set from the app-data dir (the in-memory engine unloads on next wake).

## Replacing the model later

Drop a new `model.int8.onnx` + matching `tokens.txt` into the app-data
dir above (same Conformer-CTC family) and restart Nila — no code changes
needed. The VAD model can be swapped the same way. Or point
`NILA_STT_MODEL_DIR` at a directory holding your files.

## Offline installs

The one-time download needs internet. For an offline machine, fetch the
three files elsewhere and place them in `~/.local/share/nila/models/stt/`
manually (`model.int8.onnx` + `tokens.txt` come from the tarball above).
