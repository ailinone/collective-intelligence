<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ailin-1 Model Stack

Foundation model training, alignment, and serving stack integrated with the
`ailin.one/ci/api` orchestration gateway.

## Architecture

```
model-stack/                 ci/api/
  data/ ──────────────────> datasets + manifests
  tokenizer/ ─────────────> vocab + encoding config
  model/ ──────────────────> architecture + configs
  pretraining/ ────────────> distributed training
  alignment/ ──────────────> SFT → DPO → Safety → Tool-use
  serving/ ────────────────> vLLM OpenAI-compatible ──> own-model adapter ──> orchestration engine
  registry/ ───────────────> checkpoints + promotions
  evals/ ──────────────────> benchmark suite ──────────> post-deploy-eval gates
  flywheel/ ───────────────> failure capture + replay
  experiments/ ────────────> tracking + ablations
```

## Integration with ci/api

The model stack exposes models via an OpenAI-compatible serving endpoint
(vLLM). The `ci/api` gateway consumes this through the `own-model` provider
adapter (`api/src/providers/own-model/`), making own models available
alongside third-party providers in the orchestration engine.

### Promotion flow

1. Training produces checkpoint → registered in `registry/checkpoints/`
2. Checkpoint evaluated by `evals/runner.py` against benchmark suite
3. Champion/challenger comparison in `registry/champion-challenger/`
4. Promoted checkpoint deployed via `serving/rollout/deploy.py`
5. Post-deploy eval gates in CI verify quality regression
6. Gateway `own-model` adapter picks up new version automatically

## Quick start

```bash
# Install dependencies
cd model-stack
pip install -e ".[dev]"

# 1. Prepare data
python -m model_stack.data.ingestion.ingest --source ./raw --format jsonl --output ./processed
python -m model_stack.data.dedup.lexical_dedup --input ./processed/data.jsonl --output ./deduped
python -m model_stack.data.curation.quality_filter --input ./deduped/data.jsonl --output ./filtered
python -m model_stack.data.contamination.detect_contamination --training-data ./filtered/data.jsonl

# 2. Train tokenizer
python -m model_stack.tokenizer.training.train_tokenizer --config tokenizer/configs/bpe_32k.yaml --corpus ./filtered/data.jsonl

# 3. Pretrain
accelerate launch --config_file pretraining/distributed/deepspeed_config.json \
  pretraining/launcher/train.py --config pretraining/configs/pretrain_1b.yaml

# 4. Align
python alignment/sft/train_sft.py --config alignment/sft/sft_config.yaml
python alignment/dpo/train_dpo.py --config alignment/dpo/dpo_config.yaml
python alignment/safety/safety_tuning.py --config alignment/safety/safety_config.yaml
python alignment/tool-use/tool_use_tuning.py --model ./checkpoints/safety

# 5. Evaluate
python evals/runner.py --model ./checkpoints/final --suites reasoning,coding,safety,tool-use

# 6. Serve
python serving/runtime/serve.py --model ./checkpoints/final --port 8081

# 7. Register in gateway
# Configure OWN_MODEL_ENDPOINT=http://localhost:8081 in ci/api .env
```

## Directory structure

| Directory | Purpose |
|-----------|---------|
| `data/` | Ingestion, dedup, quality filtering, PII, contamination |
| `datasets/` | Manifests, lineage, registry |
| `tokenizer/` | BPE training and evaluation |
| `model/` | Architecture (transformer), configs, scaling laws |
| `pretraining/` | Distributed training, checkpointing, resume |
| `alignment/` | SFT, DPO, RLHF, safety, tool-use, long-context |
| `serving/` | vLLM runtime, quantization, rollout/rollback |
| `registry/` | Model + checkpoint registry, champion/challenger |
| `evals/` | Benchmark suite (reasoning, coding, safety, etc.) |
| `experiments/` | W&B tracking, ablations |
| `flywheel/` | Failure capture, clustering, replay, promotion |
| `docs/` | Architecture, governance, policies |

## CI/CD integration

The model stack has its own CI workflow (`.github/workflows/model-stack-ci.yml`)
that runs on changes to `model-stack/`:

- **Lint + typecheck**: ruff + mypy
- **Unit tests**: pytest on pipeline components
- **Eval gate**: benchmark suite must pass thresholds
- **Promotion gate**: champion/challenger must approve
- **Deploy gate**: blue-green with health verification

The existing `ci/api` quality gates are extended to verify that the own-model
provider adapter can reach the serving endpoint.
