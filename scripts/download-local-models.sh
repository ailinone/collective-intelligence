#!/usr/bin/env bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# ═══════════════════════════════════════════════════════════════════
# Ailin Local Models Download Script
# Downloads pre-quantized GGUF, ONNX, and other model artifacts
# for CPU-only local inference sidecars.
#
# Usage:
#   ./scripts/download-local-models.sh              # Download MVP models
#   ./scripts/download-local-models.sh --profile A  # Modest hardware
#   ./scripts/download-local-models.sh --profile B  # Desktop
#   ./scripts/download-local-models.sh --profile C  # Workstation
#   ./scripts/download-local-models.sh --profile D  # Server
#   ./scripts/download-local-models.sh --all        # Everything
#
# Requirements: huggingface-cli (pip install huggingface_hub)
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

MODELS_DIR="${LOCAL_MODELS_PATH:-$(dirname "$0")/../models}"
PROFILE="${1:---profile}"
PROFILE_LEVEL="${2:-B}"

if [[ "$PROFILE" == "--all" ]]; then
  PROFILE_LEVEL="D"
elif [[ "$PROFILE" == "--profile" ]]; then
  PROFILE_LEVEL="${2:-B}"
fi

echo "═══════════════════════════════════════════════════"
echo "  Ailin Local Models Downloader"
echo "  Profile: ${PROFILE_LEVEL}"
echo "  Target:  ${MODELS_DIR}"
echo "═══════════════════════════════════════════════════"

mkdir -p "${MODELS_DIR}/gguf"
mkdir -p "${MODELS_DIR}/onnx"
mkdir -p "${MODELS_DIR}/piper"
mkdir -p "${MODELS_DIR}/ct2"

# ── Helper ──────────────────────────────────────
download_hf() {
  local repo="$1"
  local include="$2"
  local dest="$3"
  echo "⬇  ${repo} → ${dest}"
  huggingface-cli download "${repo}" --include "${include}" --local-dir "${dest}" --quiet 2>/dev/null || \
    echo "⚠  Failed to download ${repo} (may need HF token or accept license)"
}

# ═══════════════════════════════════════════════════
# Profile A — Modest (8-16GB RAM)
# ═══════════════════════════════════════════════════

echo ""
echo "── Profile A: Lightweight models ──"

# TinyLlama 1.1B (ultra-light chat)
download_hf "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF" "*Q4_K_M*" "${MODELS_DIR}/gguf"

# Qwen 2.5 0.5B (multilingual chat)
download_hf "Qwen/Qwen2.5-0.5B-Instruct-GGUF" "*q4_k_m*" "${MODELS_DIR}/gguf"

# BGE-small embeddings (will need ONNX export separately)
echo "ℹ  BGE-small-en-v1.5: export to ONNX with:"
echo "   optimum-cli export onnx --model BAAI/bge-small-en-v1.5 ${MODELS_DIR}/onnx/bge-small-en-v1.5/"

# Piper TTS voice
echo "ℹ  Piper voice: download from https://github.com/rhasspy/piper/blob/master/VOICES.md"
echo "   or: piper --download-dir ${MODELS_DIR}/piper --update-voices"

if [[ "$PROFILE_LEVEL" == "A" ]]; then
  echo ""
  echo "✅ Profile A download complete"
  exit 0
fi

# ═══════════════════════════════════════════════════
# Profile B — Desktop (16-32GB RAM)
# ═══════════════════════════════════════════════════

echo ""
echo "── Profile B: Desktop models ──"

# Llama 3.2 3B (primary chat)
download_hf "bartowski/Llama-3.2-3B-Instruct-GGUF" "*Q4_K_M*" "${MODELS_DIR}/gguf"

# Qwen 2.5 3B
download_hf "Qwen/Qwen2.5-3B-Instruct-GGUF" "*q4_k_m*" "${MODELS_DIR}/gguf"

# Qwen2.5-Coder 3B (code)
download_hf "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF" "*q5_k_m*" "${MODELS_DIR}/gguf"

# DeepSeek-R1-distill 1.5B (reasoning)
download_hf "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF" "*Q4_K_M*" "${MODELS_DIR}/gguf"

# SmolVLM 2B (compact VLM — needs mmproj too)
echo "ℹ  SmolVLM: check KoboldCpp-compatible GGUF at https://huggingface.co/models?search=smolvlm+gguf"

if [[ "$PROFILE_LEVEL" == "B" ]]; then
  echo ""
  echo "✅ Profile B download complete"
  exit 0
fi

# ═══════════════════════════════════════════════════
# Profile C — Workstation (32-64GB RAM)
# ═══════════════════════════════════════════════════

echo ""
echo "── Profile C: Workstation models ──"

# Mistral 7B
download_hf "TheBloke/Mistral-7B-Instruct-v0.2-GGUF" "*Q4_K_M*" "${MODELS_DIR}/gguf"

# LLaVA 1.5 7B (VLM with vision)
download_hf "mys/ggml_llava-v1.5-7b" "*Q4_K_M*" "${MODELS_DIR}/gguf"
download_hf "mys/ggml_llava-v1.5-7b" "*mmproj*" "${MODELS_DIR}/gguf"

# DeepSeek-R1-distill 7B (reasoning)
download_hf "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF" "*Q4_K_M*" "${MODELS_DIR}/gguf"

if [[ "$PROFILE_LEVEL" == "C" ]]; then
  echo ""
  echo "✅ Profile C download complete"
  exit 0
fi

# ═══════════════════════════════════════════════════
# Profile D — Server (64GB+ RAM)
# ═══════════════════════════════════════════════════

echo ""
echo "── Profile D: Server models ──"

# Qwen 2.5 7B
download_hf "Qwen/Qwen2.5-7B-Instruct-GGUF" "*q4_k_m*" "${MODELS_DIR}/gguf"

# CodeLlama 7B
download_hf "TheBloke/CodeLlama-7B-Instruct-GGUF" "*Q4_K_M*" "${MODELS_DIR}/gguf"

echo ""
echo "✅ Profile D download complete"
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Models saved to: ${MODELS_DIR}"
echo "  Next: set LOCAL_MODELS_PATH=${MODELS_DIR} in docker .env"
echo "═══════════════════════════════════════════════════"
