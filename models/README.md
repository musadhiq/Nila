# Nila wake-word models

This directory holds Nila's microWakeWord model. The Rust backend
(`src-tauri/src/wakeword.rs`) uses `nila.json` (and its paired
`nila.tflite`) by default. The model listens for "Hi Nila".

`$NILA_WAKE_MODEL` can explicitly override the default with a model stem
or a direct path to a `.tflite` / `.json` file. This is intended for
local testing; other models in this directory are not selected automatically.

For each stem the backend prefers a model **JSON config** (threshold and
sliding window come from the model author) and falls back to a bare
`.tflite` with conservative settings.

Each location is searched in: `./models`, `../models` (relative to the
working directory — covers `tauri dev`), next to the executable, and the
Tauri bundled resources (`$RESOURCE/models` — the `bundle.resources`
entry in `tauri.conf.json` ships this directory with the .deb/.AppImage).

## Privacy

The detector consumes the microphone as transient 10 ms PCM blocks and
never writes audio anywhere. Nothing in this directory records anything.

## Build note (Linux)

The `micro-wakeword` crate's microphone support needs a C++ compiler and
the ALSA development headers:

```sh
sudo apt install build-essential libasound2-dev
```
