# Nila wake-word models

This directory holds the microWakeWord models Nila listens for. The Rust
backend (`src-tauri/src/wakeword.rs`) resolves the model at startup, in
this order:

1. `$NILA_WAKE_MODEL` — a stem (`nila`) or a direct path to a `.tflite`
   / `.json` file. Useful for testing a new model without moving files.
2. `models/nila.tflite` (+ optional `models/nila.json`) — the future
   custom "Hi Nila" model. Drop the pair here; no code change needed.
3. `models/okay_nabu.tflite` (+ `models/okay_nabu.json`) — the temporary
   test model (says "Okay Nabu").

For each stem the backend prefers a model **JSON config** (threshold and
sliding window come from the model author) and falls back to a bare
`.tflite` with conservative settings.

Each location is searched in: `./models`, `../models` (relative to the
working directory — covers `tauri dev`), next to the executable, and the
Tauri bundled resources (`$RESOURCE/models` — the `bundle.resources`
entry in `tauri.conf.json` ships this directory with the .deb/.AppImage).

## Temporary test model

The model files are **not** committed here (binaries). Download the
temporary "Okay Nabu" test model from the official ESPHome
microWakeWord model repository:

```sh
./models/download-test-model.sh
```

That fetches `okay_nabu.tflite` + `okay_nabu.json` (cutoff 0.97, window 5 —
verified against the published manifest). Then run `npm run tauri dev`,
say "Okay Nabu", and Nila should show her listening pill.

## Replacing it with the custom "Hi Nila" model

Train a microWakeWord model (e.g. with the
[microWakeWord training colab](https://github.com/kahrendt/microWakeWord)),
then drop the artifacts in here as `nila.tflite` + `nila.json`. The
backend picks `nila.*` over `okay_nabu.*` automatically — no code change,
no rebuild of the pipeline. Delete or keep the test model; it is only
used when no `nila.*` model is present.

## Privacy

The detector consumes the microphone as transient 10 ms PCM blocks and
never writes audio anywhere. Nothing in this directory records anything.

## Build note (Linux)

The `micro-wakeword` crate's microphone support needs a C++ compiler and
the ALSA development headers:

```sh
sudo apt install build-essential libasound2-dev
```
