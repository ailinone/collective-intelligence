<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Phase 7 — Production Parity Baseline (2026-04-28)

**Purpose:** captures the local post-fix state so a prod deploy can be diffed
mechanically against this snapshot. The actual deploy is operator-bound.

## Local baseline (captured at 23:12 UTC)

| Metric | Value | Source |
|---|---:|---|
| `models` row count | 64,409 | `SELECT COUNT(*) FROM models;` |
| `/v1/models` count | 64,045 | `curl /v1/models \| jq '.data \| length'` |
| Distinct provider_ids | 51 | `SELECT COUNT(DISTINCT provider_id) FROM models;` |
| Vision models | 1,534 | `capabilities @> '["vision"]'` |
| Embedding models | 495 | `capabilities @> '["embeddings"]' OR '["embedding"]'` |
| TTS models | 144 | `capabilities @> '["tts"]' OR '["text_to_speech"]'` |
| Reasoning models | 1,541 | `capabilities @> '["reasoning"]'` |
| Chat-pool providers | 48 / 51 | `≥1 active model with chat capability` |

## Top-10 providers by model count (local)

| # | provider_id | models |
|---:|---|---:|
| 1 | huggingface | 58,092 |
| 2 | orqai | 819 |
| 3 | nanogpt | 633 |
| 4 | cometapi | 574 |
| 5 | aiml | 524 |
| 6 | requesty | 448 |
| 7 | poe | 380 |
| 8 | openrouter | 371 |
| 9 | edenai | 358 |
| 10 | aihubmix | 218 |

## Branch state at baseline capture

Branch: `main`, 10 commits ahead of `origin/main`:

```
c85b844 discovery: fix aggregator → openrouter provider misattribution
6ed6b84 catalog: Phase 5 — invariant tests + production boot guard
858dccd catalog: Phase 4c+4d — pinnedFallback schema + 16 staticModels migrations
f39c035 catalog: Phase 4b — replace denyByDefault gate with contentPolicyClass tag (mancer/venice)
7571eda feat(catalog): Phase 4a — universal "habilitado e nunca censurado" flip
ea54eeb docs(phase-3b): staticModels DROP-or-MIGRATE decisions for all 16 entries
562398a docs(phase-3a)+test: adapter audit + coverage invariant (8/8 green)
5ab1be8 feat(providers): import SOTA provider catalog subsystem (92 files, 23.2k LOC)
7b5b6a8 docs(diagnosis): classify 21 plugin failures into 6 fix-path buckets
5e6bd1c docs(matrix): capture phase-1 81-row provider-runtime-matrix
```

Uncommitted at baseline: `api/src/providers/catalog/provider-catalog.types.ts`
(deprecated `staticModels` field re-added with migration-window comment to
restore TypeScript compilation against the consumers
`catalog-provider-plugin.ts:270` and `central-model-discovery-service.ts:1712`).

## Deploy readiness checklist

Before triggering prod deploy via
`gh workflow run experiment-admin.yml -f action=deploy`:

- [ ] **Commit the TS type fix** — `git add api/src/providers/catalog/provider-catalog.types.ts && git commit`
- [ ] **Push 10 unpushed commits to origin/main** — `git push origin main`
- [ ] **CI build green for HEAD** — verify via `gh run list --workflow=flexible-cicd.yml --limit=1`
- [ ] **Confirm GHCR image exists** — `gh api repos/ailinone/ci/packages/container/ci-api/versions --jq '.[0].metadata.container.tags'`
- [ ] **Trigger deploy** — `gh workflow run experiment-admin.yml -f action=deploy`
- [ ] **Watch deploy** — `gh run watch`

## Acceptance criteria for parity

After deploy, capture the same metrics from prod and verify:

- **Model count delta** ≤ 1% (64,053 ≤ prod_count ≤ 64,765)
- **Provider count** within ±2 (49 ≤ distinct_providers ≤ 53)
- **HF Hub correctly attributed** — `huggingface` provider_id has > 50,000 models
  (NOT `openrouter`, which would indicate the bug fix was reverted)
- **Per-provider counts** within ±5 for top-20 providers
- **Capability coverage** — vision/embeddings/tts each ≥1 model, ≥10 providers
- **HTTP bind time** ≤ 180s

## Known parity considerations

1. **GCP secrets differ between local `.env` and prod GCP Secret Manager.**
   Some providers may materialise in prod that don't appear in this local
   snapshot (e.g. `xai`, `bytez`, `ai21` had vanished from local — they may
   reappear in prod with valid GCP-stored credentials).
2. **Hub aggregator natural flux.** Hubs like `aihubmix`, `nanogpt`, `aiml`
   re-paginate fresh each cycle. Per-provider counts can drift ±15% per day
   based on hub-side catalog changes. Compare against a prod cycle ≤24h old.
3. **Self-hosted providers (`vllm`, `lm-studio`, `ollama`, etc.) only
   materialise where the infra is running.** Prod may have these enabled in
   a way local does not, or vice-versa.

## Operator handoff

Prod deploy is gated on the operator pushing the 10 commits to `origin/main`.
Once deploy completes, run:

```bash
# From any machine with prod read access:
curl -s "$PROD_URL/v1/models" | jq '.data | length' > prod-model-count.txt
psql "$PROD_DATABASE_URL" -c "SELECT provider_id, COUNT(*) FROM models GROUP BY 1 ORDER BY 2 DESC LIMIT 20;" > prod-top-20.txt
diff <(awk '{print $1}' < prod-top-20.txt) <(awk '{print $1}' < local-top-20.txt)
```

A delta-report markdown file (`prod-parity-report-2026-04-XX.md`) should be
checked into `api/docs/` after deploy with the same column layout as this
baseline.
