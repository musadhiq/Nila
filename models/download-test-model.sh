#!/usr/bin/env bash
# Download the temporary "Okay Nabu" microWakeWord test model into models/.
# Source: the official ESPHome microWakeWord model repository
# (https://github.com/esphome/micro-wake-word-models, Apache-2.0).
set -euo pipefail

cd "$(dirname "$0")"

BASE="https://raw.githubusercontent.com/esphome/micro-wake-word-models/main/models/v2"

echo "Downloading okay_nabu test model..."
curl -fL -o okay_nabu.tflite "$BASE/okay_nabu.tflite"
curl -fL -o okay_nabu.json "$BASE/okay_nabu.json"

echo "Verifying..."
head -c 4 okay_nabu.tflite | grep -q "TFL3" && echo "  okay_nabu.tflite: TFLite magic OK"
grep -o '"wake_word"[^,]*' okay_nabu.json | head -1
grep -o '"probability_cutoff"[^,]*' okay_nabu.json | head -1

echo "Done. Files in models/:"
ls -la okay_nabu.*
