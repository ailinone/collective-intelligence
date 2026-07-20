<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Training Lifecycle

## Lifecycle stages

### Stage 0: Data preparation
1. Ingest raw data from sources (web, code repos, curated)
2. Lexical deduplication (MinHash LSH, threshold 0.8)
3. Semantic deduplication (embedding similarity, threshold 0.92)
4. Quality filtering (length, language, repetition, perplexity)
5. PII detection and redaction
6. Benchmark contamination check (13-gram overlap)
7. Dataset mixing with temperature-weighted sampling
8. Version and register dataset manifest

### Stage 1: Tokenizer
1. Sample corpus from prepared data
2. Train BPE tokenizer (vocab 32K)
3. Evaluate fertility, coverage, compression
4. Register tokenizer version

### Stage 2: Pretraining
1. Initialize model from config
2. Launch distributed training (accelerate + DeepSpeed ZeRO-2)
3. Train for ~100K steps (25B tokens at batch 512 * 4096 tokens)
4. Checkpoint every 1000 steps, eval every 500 steps
5. Monitor: loss, gradient norm, throughput, MFU
6. Register best checkpoint by val loss

### Stage 3: Supervised fine-tuning (SFT)
1. Load pretrained checkpoint
2. Apply LoRA (r=64, alpha=128)
3. Train on instruction-following data (3 epochs)
4. Evaluate on held-out instructions
5. Merge LoRA weights
6. Register SFT checkpoint

### Stage 4: Preference alignment (DPO)
1. Load SFT checkpoint
2. Generate preference pairs (or use human labels)
3. Train DPO (beta=0.1, 1 epoch)
4. Evaluate win rate
5. Register aligned checkpoint

### Stage 5: Safety tuning
1. Load DPO checkpoint
2. Fine-tune on safety refusal + helpfulness preservation
3. Evaluate: refusal rate >= 95% on harmful, false positive <= 5% on benign
4. Register safety checkpoint

### Stage 6: Capability tuning
1. Tool-use fine-tuning (JSON function calling)
2. Long-context extension (YaRN RoPE scaling)
3. Evaluate on tool-use and needle-in-haystack benchmarks
4. Register final checkpoint

### Stage 7: Evaluation
1. Run full benchmark suite (reasoning, coding, safety, tool-use, etc.)
2. Compare against champion model
3. Compare against external baselines

### Stage 8: Promotion
1. Champion/challenger evaluates candidate vs champion
2. If promoted: deploy to serving
3. If rejected: analyze failures, build replay set, retrain

## Checkpoint governance

Every checkpoint must have:
- Training config hash
- Dataset manifest version
- Eval results on standard suite
- Promotion decision (with evidence)
- Rollback path to previous version

## Failure feedback loop

```
Eval failures → capture.py → cluster.py → build_replay_set.py → next training iteration
```
