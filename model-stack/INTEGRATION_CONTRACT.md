<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Integration Contract: model-stack <-> ci/api

## Overview

The model-stack produces trained model checkpoints that are served via an
OpenAI-compatible endpoint (vLLM). The ci/api gateway consumes this endpoint
through the `own-model` provider adapter, making own models available in the
orchestration engine alongside third-party providers.

## Interface

### Serving endpoint (model-stack -> ci/api)

The model-stack serving runtime MUST expose:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |
| `/v1/completions` | POST | Text completions |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check (200 = healthy) |
| `/ready` | GET | Readiness check (200 = ready to serve) |
| `/metrics` | GET | Prometheus metrics |

Request/response format: OpenAI API compatible.

### Configuration (ci/api side)

| Env var | Required | Default | Description |
|---------|----------|---------|-------------|
| `OWN_MODEL_ENDPOINT` | yes | `http://localhost:8081` | Serving endpoint URL |
| `OWN_MODEL_API_KEY` | no | none | API key for auth |
| `OWN_MODEL_TIMEOUT` | no | `120000` | Request timeout (ms) |
| `OWN_MODEL_ENABLED` | yes | `false` | Enable own-model provider |

### Model identification

Own models are prefixed with `own/` in the gateway:
- Serving reports model as `ailin-1b-v0.1.0`
- Gateway maps to `own/ailin-1b-v0.1.0`
- Triage/strategy can select `own/*` models

### Promotion flow

```
model-stack                          ci/api
  registry/champion-challenger
    └─ promotes checkpoint ──────> serving/rollout/deploy.py
                                     └─ starts new vLLM instance
                                     └─ health check
                                     └─ switch traffic ──────> own-model-adapter picks up
                                                                └─ orchestration engine routes
                                                                └─ bandit learns quality
                                                                └─ metrics flow to Grafana
```

### Readiness contract

The own-model serving endpoint MUST:
1. Return `/ready` 200 only when model is fully loaded and accepting requests
2. Return `/health` 200 when the process is running (even if model not loaded)
3. Block traffic until `/ready` returns 200

The ci/api gateway MUST:
1. Check `/ready` before routing first request
2. Check `/health` periodically (every 30s)
3. Mark own-model as unavailable if health check fails 3 consecutive times
4. Resume routing when health check succeeds again

### Metrics contract

The serving endpoint exports Prometheus metrics:
- `own_model_request_total{model, status}`
- `own_model_request_duration_seconds{model, quantile}`
- `own_model_tokens_generated_total{model}`
- `own_model_batch_size{model}`
- `own_model_kv_cache_usage{model}`

The ci/api gateway exports:
- `ci_model_execution_total{model_id="own/...", provider="own-model"}`
- `ci_model_execution_duration_ms{model_id="own/..."}`
- `ci_model_quality_score{model_id="own/..."}`

### Eval integration

The model-stack benchmark suite (`evals/runner.py`) can target:
1. A local model path (HuggingFace format) for offline eval
2. A serving endpoint URL for online eval (same as ci/api post-deploy-eval)

Post-deploy-eval in ci/api workflow can run model-stack evals by targeting
the own-model serving endpoint, extending existing routing/retrieval/tool-use
benchmarks with frontier model evals.

### Feedback data pipeline (ci/api -> model-stack)

The ci/api exports execution outcomes and shadow evaluations as JSONL files
that the model-stack consumes for SFT and DPO training.

**Direction:** ci/api → JSONL files on shared volume → model-stack

| Component | Location | Purpose |
|-----------|----------|---------|
| Export job | `api/src/jobs/training-data-export-job.ts` | Cron 02:00 UTC, extracts outcomes + shadow evals |
| Extract | `model-stack/data/feedback/extract.py` | Validates manifest, verifies SHA-256 checksums |
| Transform | `model-stack/data/feedback/transform.py` | PII filter, quality gates, builds SFT/DPO pairs |
| Load | `model-stack/data/feedback/load.py` | Registers in dataset manifests for training mixes |
| Config | `model-stack/data/feedback/config.yaml` | Quality thresholds, PII settings |

**JSONL format (outcomes):**
```json
{"trace_id_hash": "abc123...", "strategy": "consensus", "task_type": "code-generation",
 "complexity": "high", "quality_score": 0.88, "quality_dimensions": {...},
 "models_used": ["gpt-4o", "claude-sonnet"], "decision_source": "triage", ...}
```

**JSONL format (shadow / DPO signal):**
```json
{"trace_id_hash": "def456...", "task_type": "analysis", "chosen_strategy": "single",
 "chosen_quality": 0.72, "shadow_strategy": "consensus", "shadow_quality": 0.88,
 "quality_regret": 0.16, "winner_strategy": "consensus", ...}
```

**PII contract:**
- Organization IDs and user IDs are NEVER exported
- Trace IDs are SHA-256 hashed with a pepper (irreversible but deterministic)
- Text content is only exported with `FEEDBACK_INCLUDE_CONTENT=1` and mandatory PII redaction

**Makefile integration:**
```
make feedback-pipeline    # Full automated pipeline
make feedback-stage       # Extract + transform only (staging)
make feedback-load        # Load approved staging into training
make approve-feedback-data # Stage + load in one step
```

The `make flywheel` target includes `feedback-pipeline` as a dependency.
