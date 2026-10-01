# Nila local English STT models (sherpa-onnx)

This directory holds the **local** speech-to-text models used by
`src-tauri/src/voice.rs`. Everything runs on-device — no network, no
accounts, no audio ever leaves the machine (or is even written to disk).

## Files

| File | What | Size |
|---|---|---|
| `model.int8.onnx` | NeMo `stt_en_conformer_ctc_small`, INT8 quantized, English (~13M params, trained on ~16k hours) | ~44 MB |
| `tokens.txt` | Tokenizer vocabulary for the model (lowercase a–z, space, apostrophe) | tiny |
| `silero_vad.onnx` | Silero voice-activity detector (speech start/end detection) | ~2 MB |

The full-precision `model.onnx` (~81 MB) from the upstream tarball is
**not** kept — only the INT8 file is needed.

## Download

Binaries are not committed through the usual push flow. Run:

```bash
bash src-tauri/models/stt/download-stt-model.sh
```

then commit the three files with normal git:

```bash
git add src-tauri/models/stt/model.int8.onnx \
        src-tauri/models/stt/tokens.txt \
        src-tauri/models/stt/silero_vad.onnx
git commit -m "Add local English STT models (sherpa-onnx)"
```

## Sources

- ASR: <https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2>
- VAD: <https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx>

See <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/english.html>
for the upstream model card. The NeMo model is NVIDIA's; check its
license before redistributing the packaged app.

## Configuration

The worker resolves models in this order:

1. `NILA_STT_MODEL_DIR` — a directory containing all three files.
2. `NILA_STT_MODEL` / `NILA_STT_TOKENS` / `NILA_STT_VAD_MODEL` — individual file paths.
3. `models/stt/` next to the working directory, the executable, or the
   Tauri resource dir (the `./models/stt/` → `models/stt/` resource
   mapping in `tauri.conf.json` covers packaged builds; in dev it is
   this directory).

Session timeouts are also tunable:

| Env var | Default | Meaning |
|---|---|---|
| `NILA_VOICE_SPEECH_TIMEOUT` | `8.0` | Seconds to wait for speech after the wake word |
| `NILA_VOICE_SILENCE_TIMEOUT` | `1.2` | Trailing silence (s) that ends the command |
| `NILA_VOICE_MAX_DURATION` | `20.0` | Longest a command recording may run (s) |
| `NILA_VOICE_PARTIAL_MS` | `1000` | Live-partial re-decode cadence (ms) |

## Replacing the model later

Drop a new `model.int8.onnx` + matching `tokens.txt` here (same
Conformer-CTC family) and restart Nila — no code changes needed. The
VAD model can be swapped the same way.
