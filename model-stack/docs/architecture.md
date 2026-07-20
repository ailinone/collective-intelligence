<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ailin-1 Architecture

## Model specification

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Architecture | Decoder-only Transformer | Standard for autoregressive LLM |
| Parameters | 1.28B | Chinchilla-optimal for ~25B tokens |
| Hidden dim | 2048 | 2^11, efficient for GPU tensor cores |
| Layers | 24 | Balanced depth for 1B scale |
| Attention heads | 16 | head_dim = 128 (optimal for Flash Attention) |
| KV heads | 4 | GQA 4:1 ratio, reduces KV cache 4x |
| Intermediate | 5504 | ~2.7x hidden (SwiGLU effective ratio) |
| Vocab size | 32000 | BPE, covers multilingual + code |
| Max context | 4096 | Extensible via RoPE scaling to 32K+ |
| Positional encoding | RoPE (theta=500000) | Extrapolation-friendly |
| Normalization | RMSNorm (eps=1e-5) | Pre-norm, faster than LayerNorm |
| Activation | SwiGLU | Better quality/param than GELU |
| Precision | bf16 | Training and inference |

## Training stages

```
Raw data → Ingest → Dedup → Quality filter → PII filter → Contamination check → Mix
                                                                                  ↓
Tokenizer training ← corpus sample                                          Mixed dataset
                                                                                  ↓
                                                                        Pretrain (100K steps)
                                                                                  ↓
                                                                           SFT (3 epochs)
                                                                                  ↓
                                                                        DPO (β=0.1, 1 epoch)
                                                                                  ↓
                                                                         Safety tuning
                                                                                  ↓
                                                                         Tool-use tuning
                                                                                  ↓
                                                                     Context extension (YaRN)
                                                                                  ↓
                                                                      Benchmark evaluation
                                                                                  ↓
                                                              Champion/Challenger promotion
                                                                                  ↓
                                                                    Quantize → Deploy → Serve
```

## Compute requirements (estimated)

| Stage | GPUs | Time | Notes |
|-------|------|------|-------|
| Pretraining (1.28B, 25B tokens) | 8x A100 80GB | ~48h | DeepSpeed ZeRO-2 |
| SFT | 4x A100 | ~4h | LoRA r=64 |
| DPO | 4x A100 | ~2h | LoRA, reference model in bf16 |
| Safety tuning | 2x A100 | ~1h | LoRA |
| Tool-use tuning | 2x A100 | ~1h | LoRA |
| Context extension | 4x A100 | ~8h | Full fine-tune, long sequences |
| Serving (quantized) | 1x A100 | continuous | AWQ int4, ~2GB VRAM |

## Integration with ci/api

The serving endpoint exposes an OpenAI-compatible API that the gateway
consumes through the `own-model` provider adapter. This means:

1. Own models appear in `/v1/models` alongside third-party models
2. The orchestration engine can select own models via triage/strategy
3. The bandit learns own-model quality and routes traffic accordingly
4. Champion/challenger applies to own models just like strategies
