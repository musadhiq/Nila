#!/usr/bin/env bash
# Download Nila's local English STT models into src-tauri/models/stt/.
#
#   - model.int8.onnx : NeMo stt_en_conformer_ctc_small, INT8 (~44 MB)
#   - tokens.txt      : its vocabulary
#   - silero_vad.onnx : Silero voice-activity detector (~2 MB)
#
# Shell-only: curl + tar. Run from anywhere; files land next to this
# script. Commit them with normal git afterwards (see README.md).
set -euo pipefail
cd "$(dirname "$0")"

ASR_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2"
VAD_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need curl
need tar

echo "-> downloading Conformer-CTC small tarball (only model.int8.onnx + tokens.txt will be kept)..."
curl -fSL --retry 3 -o /tmp/nila-stt-asr.tar.bz2 "$ASR_URL"

echo "-> extracting..."
tmpd="$(mktemp -d)"
trap 'rm -rf "$tmpd" /tmp/nila-stt-asr.tar.bz2' EXIT
tar -xjf /tmp/nila-stt-asr.tar.bz2 -C "$tmpd"

model="$(find "$tmpd" -name 'model.int8.onnx' | head -1)"
tokens="$(find "$tmpd" -name 'tokens.txt' | head -1)"
[ -n "$model" ] || { echo "model.int8.onnx not found in tarball" >&2; exit 1; }
[ -n "$tokens" ] || { echo "tokens.txt not found in tarball" >&2; exit 1; }
cp "$model" ./model.int8.onnx
cp "$tokens" ./tokens.txt

# Sanity: the INT8 model should be roughly 44 MB (40-50 MB).
size="$(stat -c %s ./model.int8.onnx)"
if [ "$size" -lt 40000000 ] || [ "$size" -gt 52000000 ]; then
  echo "warning: model.int8.onnx is ${size} bytes (expected ~44 MB) — continuing anyway" >&2
fi

echo "-> downloading Silero VAD model..."
curl -fSL --retry 3 -o ./silero_vad.onnx "$VAD_URL"

# Sanity: silero_vad.onnx is ~2.3 MB.
vsize="$(stat -c %s ./silero_vad.onnx)"
if [ "$vsize" -lt 1000000 ] || [ "$vsize" -gt 8000000 ]; then
  echo "warning: silero_vad.onnx is ${vsize} bytes (expected ~2 MB) — continuing anyway" >&2
fi

echo "done. Files:"
ls -la ./model.int8.onnx ./tokens.txt ./silero_vad.onnx
echo
echo "Commit them with:"
echo "  git add src-tauri/models/stt/model.int8.onnx src-tauri/models/stt/tokens.txt src-tauri/models/stt/silero_vad.onnx"
