<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-022: Capability Ontology & Hybrid Capability Retrieval Architecture (HCRA)

**Status**: Proposed
**Date**: 2026-04-19
**Context**: Model discovery — capability representation, storage, and search at 20k-model scale
**Related**: L2 (Model Equivalence), L5/L10 (Bandits), L7 (Feedback Loop), L9 (pgvector — promoted from "future" to active), L11 (Event Sourcing)
**Supersedes (in part)**: hardcoded `ModelCapability` union in `api/src/types/index.ts`

## Context

Today the catalog has 6,868 models and is growing. We measured the provenance of every capability claim currently stored:

| Source | % of claims | Trust |
|--------|------------|-------|
| Regex on model name/description | **90.4%** | Weak (false positives dominate) |
| Modality / parameter inference (OpenRouter, Bedrock format) | 7.5% | Strong (indirect but structured) |
| Provider-declared explicit (NanoGPT `?detailed=true`, Mistral, AiHubMix) | **2.2%** | Gold |

Concretely: when the L5 Thompson Sampling bandit picks a model for a "vision + tool-use" request, **9 in 10** of the underlying capability bits were guessed from substrings. This is the bottleneck for routing quality and the reason cross-provider retry sees a 61% mismatch on capability filters in the C3 pilot.

Three forces converge:

1. **Scale target — 20k models**: a hardcoded TypeScript union (`type ModelCapability = 'vision' | ...`) cannot evolve at 20k-model pace. New providers (Eden AI exposes 302 sub-features, CometAPI 358 model-types) push the closed enum daily.
2. **Search becomes the read path**: the L5/L10 bandits, the canary gate (L6), and forthcoming admin UIs all need *capability-first* lookup ("models that handle Portuguese OCR with function calling, ≥128k context, ≤$2/1M output, currently funded"). JSONB GIN scans on `capabilities @> '["vision"]'` won't scale to faceted + semantic queries.
3. **Provenance is now compliance-relevant**: ADR-021 requires that we can audit where every fact about a model came from. A regex match in `addKeywordCapabilities()` is *not* a defensible source.

The Hybrid Capability Retrieval Architecture (HCRA) addresses all three by separating **ontology** (what capabilities exist), **assertions** (who claimed what, with what confidence), and **search** (how callers query).

## Decision

### Architecture: 3 Layers

```
┌───────────────────────────────────────────────────────────────┐
│  Layer 3 — Search API                                         │
│  /v1/capabilities/search   (3-stage: parse → recall → rerank) │
│  /v1/capabilities/facets   (counts per capability for filters)│
│  /v1/capabilities/expand   (URI → synonyms, broader, narrower)│
└───────────────────────────────────────────────────────────────┘
                           ▲
┌───────────────────────────────────────────────────────────────┐
│  Layer 2 — Index (Postgres + pgvector)                        │
│  models.capability_uris        TEXT[]                         │
│  models.capability_confidence  JSONB  {uri: float}            │
│  models.embedding              VECTOR(384)                    │
│  model_capability_assertions   (event-sourced provenance)     │
└───────────────────────────────────────────────────────────────┘
                           ▲
┌───────────────────────────────────────────────────────────────┐
│  Layer 1 — Ontology (governance)                              │
│  capability_ontology           (URIs, labels, broader/narrower│
│                                 synonyms, schema_version)     │
└───────────────────────────────────────────────────────────────┘
```

Capabilities become **first-class data** with stable URIs (e.g. `http://ailin.dev/cap/v1/vision`), versioned via `schema_version`, with broader/narrower (SKOS-style) and multilingual labels. The TypeScript `ModelCapability` union is deprecated to a *cached snapshot* re-generated nightly from the table — code keeps autocompletion, but truth lives in the DB.

### 1. Schema — `capability_ontology`

```sql
CREATE TABLE capability_ontology (
  uri              TEXT PRIMARY KEY,                  -- http://ailin.dev/cap/v1/vision
  schema_version   INTEGER NOT NULL DEFAULT 1,
  preferred_label  TEXT NOT NULL,                     -- "Vision"
  labels           JSONB NOT NULL DEFAULT '{}',       -- {en: "Vision", pt: "Visão", zh: "视觉"}
  synonyms         TEXT[] NOT NULL DEFAULT '{}',      -- ["image-input", "multimodal-image"]
  description      TEXT,
  broader          TEXT[] NOT NULL DEFAULT '{}',      -- URIs of parent capabilities (SKOS broader)
  narrower         TEXT[] NOT NULL DEFAULT '{}',      -- URIs of children
  category         TEXT NOT NULL,                     -- modality | task | safety | language | tool | meta
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','deprecated','experimental')),
  embedding        VECTOR(384),                       -- for semantic expansion of queries
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deprecated_by    TEXT REFERENCES capability_ontology(uri),
  CONSTRAINT chk_uri_format CHECK (uri ~ '^http://ailin\.dev/cap/v[0-9]+/[a-z0-9_-]+$')
);

CREATE INDEX idx_cap_ont_synonyms_gin     ON capability_ontology USING GIN (synonyms);
CREATE INDEX idx_cap_ont_labels_gin       ON capability_ontology USING GIN (labels jsonb_path_ops);
CREATE INDEX idx_cap_ont_broader_gin      ON capability_ontology USING GIN (broader);
CREATE INDEX idx_cap_ont_narrower_gin     ON capability_ontology USING GIN (narrower);
CREATE INDEX idx_cap_ont_category_active  ON capability_ontology (category) WHERE status = 'active';
CREATE INDEX idx_cap_ont_embedding_hnsw   ON capability_ontology USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**Why URIs not slugs**: a URI is unambiguous across schema versions. `vision` in v1 may split into `vision_image` + `vision_video` in v2; both can coexist while consumers migrate, and `deprecated_by` chains the redirect.

### 2. Schema — patches to `models`

```sql
ALTER TABLE models
  ADD COLUMN capability_uris       TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN capability_confidence JSONB       NOT NULL DEFAULT '{}',  -- {uri: 0.0..1.0}
  ADD COLUMN capability_sources    JSONB       NOT NULL DEFAULT '{}',  -- {uri: ['provider-declared',...]}
  ADD COLUMN capability_updated_at TIMESTAMPTZ,
  ADD COLUMN embedding             VECTOR(384);                         -- model-card embedding for similarity

CREATE INDEX idx_models_cap_uris_gin       ON models USING GIN (capability_uris);
CREATE INDEX idx_models_active_cap_uris    ON models USING GIN (capability_uris)
  WHERE active = true;
CREATE INDEX idx_models_cap_conf_gin       ON models USING GIN (capability_confidence jsonb_path_ops);
CREATE INDEX idx_models_embedding_hnsw     ON models USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE active = true;
CREATE INDEX idx_models_cap_updated_brin   ON models USING BRIN (capability_updated_at);

-- Legacy column retained for migration window; drop in next major.
COMMENT ON COLUMN models.capabilities IS
  'DEPRECATED — derived from capability_uris. Read capability_uris instead.';
```

**Why three columns instead of one denormalized JSON**: GIN on `TEXT[]` is ~3× faster than GIN on `JSONB jsonb_path_ops` for `@>` containment, and we can build a `WHERE active` partial index. Confidence and sources are scanned only after the recall step narrows to ≤1k candidates, so JSONB is fine there.

### 3. Schema — `model_capability_assertions` (event-sourced provenance)

```sql
CREATE TABLE model_capability_assertions (
  id              BIGSERIAL PRIMARY KEY,
  model_uid       TEXT NOT NULL REFERENCES models(uid) ON DELETE CASCADE,
  capability_uri  TEXT NOT NULL REFERENCES capability_ontology(uri),
  source          TEXT NOT NULL
                  CHECK (source IN (
                    'provider-declared','helicone-oracle','modality-derived',
                    'parameter-derived','name-regex','llm-extracted','operator-override'
                  )),
  source_detail   JSONB NOT NULL DEFAULT '{}',       -- e.g. {endpoint: '/models?detailed=true', field: 'vision'}
  confidence      REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  asserted_value  BOOLEAN NOT NULL DEFAULT TRUE,     -- false = explicit denial (rare but needed)
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_days        INTEGER NOT NULL DEFAULT 30,       -- after which assertion staleness penalises confidence
  superseded_at   TIMESTAMPTZ,
  superseded_by   BIGINT REFERENCES model_capability_assertions(id)
);

CREATE INDEX idx_mca_model_cap_active
  ON model_capability_assertions (model_uid, capability_uri)
  WHERE superseded_at IS NULL;
CREATE INDEX idx_mca_observed_brin ON model_capability_assertions USING BRIN (observed_at);
CREATE INDEX idx_mca_source        ON model_capability_assertions (source) WHERE superseded_at IS NULL;
```

This is **append-only** (mirrors L11 `routing_event` pattern). The `models.capability_*` columns are a *materialized projection* refreshed by the merge worker. If we ever doubt a value, `SELECT * FROM model_capability_assertions WHERE model_uid = ? AND capability_uri = ? ORDER BY observed_at DESC` gives the full history.

### 4. Bayesian fusion (replaces hierarchical precedence)

Per `(model, capability)`, the worker computes:

```
P(cap | sources) = 1 - Π_i (1 - confidence_i × source_weight[source_i] × freshness(observed_at_i))
```

with calibrated `source_weight`:

| Source | Weight | Notes |
|--------|--------|-------|
| `provider-declared` | 0.95 | Provider can lie / be stale |
| `helicone-oracle`   | 0.85 | Cross-checked but indirect |
| `modality-derived`  | 0.75 | Strong but inferred |
| `parameter-derived` | 0.65 | "API accepts" ≠ "model excels" |
| `llm-extracted`     | 0.60 | LLM-as-extractor on docs |
| `name-regex`        | 0.20 | Kept as faint signal, never decisive alone |
| `operator-override` | 1.00 | Human review |

`freshness(t) = exp(-Δdays / ttl_days)`. A capability lands in `capability_uris` iff `P ≥ 0.5`; the value goes into `capability_confidence` for ranking.

This generalises ADR-016/decision-1b's hierarchical precedence: when a strong source exists, it dominates the product; when only weak sources exist, *several* of them can still cross 0.5 — the fallback the previous design lost.

### 5. Search API — 3-stage retrieval

`POST /v1/capabilities/search`
```json
{
  "query": "vision + portuguese OCR + tools, ≥128k context, ≤$2/1M output",
  "filters": { "active": true, "funded": true, "max_output_cost_usd_per_1m": 2.0 },
  "limit": 20
}
```

Stage A — **Parse**: extract structured filters + free-text intent (regex first, LLM if confidence low).
Stage B — **Recall** (≤300 candidates):
```sql
SELECT m.uid, m.capability_uris, m.capability_confidence, m.embedding
FROM models m
WHERE m.active = true
  AND m.capability_uris @> ARRAY['http://ailin.dev/cap/v1/vision',
                                 'http://ailin.dev/cap/v1/function_calling']
  AND m.context_window >= 128000
  AND m.output_cost_per_1m <= 2.0
ORDER BY m.embedding <=> $query_embedding
LIMIT 300;
```
Stage C — **Rerank**: combine `Σ capability_confidence[uri]` × bandit posterior (L5) × cosine similarity. Return top-20 with full provenance.

`/facets` does fast `unnest(capability_uris)` + `GROUP BY` on the active-models partial index — sub-50ms even at 20k.
`/expand` walks `broader`/`narrower`/`synonyms` for query expansion.

### 6. Sprint plan (5 sprints, ~6 weeks)

| Sprint | Scope | Exit criteria |
|--------|-------|---------------|
| **1 — Foundation** | Migration: ontology + assertions + models patches. Seed ontology with the 60 current capabilities mapped to URIs. Backfill assertions from current `models.capabilities` (source = `name-regex`, confidence = 0.2). | All 6,868 models have ≥1 assertion; ontology has 60 URIs; existing JSONB column unchanged. |
| **2 — Ingestion** | Refactor merger to Bayesian fusion + URIs. Refactor 3 high-volume fetchers (NanoGPT `?detailed=true`, CometAPI `/api/models`, Eden AI `/v2/info/provider_subfeatures`). Embedding worker (BGE-small-en-v1.5, 384d). | Provider-declared share ≥ 25% (from 2.2%). All active models have `embedding`. |
| **3 — Search API** | `/search`, `/facets`, `/expand` endpoints with 3-stage retrieval. L5 bandit reads `capability_confidence`. | p95 search latency < 80ms at 7k models; bandit weights confidence in arm scoring. |
| **4 — Operationalization** | Helicone oracle worker (daily). LLM-extraction worker for docs-only providers. Drift detector: alert when assertion contradicts current materialised value. | Drift dashboard live; oracle weight rises to 15% of assertions. |
| **5 — Scale to 20k** | Migrate remaining 30+ fetchers off `OpenAICompatibleHubModelFetcher` to declarative source adapters (YAML). Capability composition detection (e.g. `vision` + `function_calling` + `long_context` → `multimodal_agent` synthetic capability). Drop legacy `models.capabilities` column. | 20k-model load test: search p95 < 150ms; ingestion drains <5min. |

## Rationale

- **Why pgvector and not Pinecone/Weaviate**: HNSW in pgvector 0.7 hits sub-50ms at 100k vectors and we already pay the Postgres bill. Adding an external service for one read path would violate the "single source of truth" of L11. If/when we exceed 1M models we revisit.
- **Why URIs and not bigint IDs**: URIs survive backups, exports, and cross-system joins (e.g. when we federate ontologies with a partner's). The `chk_uri_format` constraint enforces the contract.
- **Why event-sourced assertions**: matches L11 `routing_event`. Compliance (ADR-021) requires we can answer "why did the system think gpt-5 had vision on April 17?" — the materialised column can't, the assertion log can.
- **Why Bayesian fusion over hierarchical precedence**: hierarchical drops a capability the moment any strong source exists but doesn't list it — even if 4 weak sources agree. Bayesian degrades gracefully and gives the bandits a *confidence* number, not a boolean. This was the missing piece in decision-1b.
- **Why deprecate the TypeScript union slowly**: hard removal would break ~40 call sites. Generated cached snapshot keeps autocompletion; the runtime checks against the DB.

## Consequences

### Positive
- Provider-declared truth becomes **the** input for routing decisions; regex demoted to tiebreaker.
- Search becomes the new primitive; bandits get richer features (confidence, embeddings).
- Adding a capability is a `INSERT INTO capability_ontology` — no code deploy.
- Provenance auditable per (model, capability, day) — ADR-021 compliance for free.
- Schema evolves via `schema_version` + `deprecated_by` — no destructive renames.

### Negative
- Three new tables, two new indexes per query path → **Postgres footprint grows ~30%**. BRIN on time + partial indexes on `active = true` mitigate but do not eliminate.
- pgvector requires extension install on prod DB (currently absent — Sprint 1 blocker).
- Backfill of 6,868 × ~5 capabilities = ~35k assertion rows at low confidence. Looks noisy until Sprint 2 lands stronger sources.
- LLM-extraction worker (Sprint 4) introduces a non-deterministic data path. Mitigated by `superseded_by` and operator-override tier.
- The legacy `ModelCapability` union must remain readable for 1 release while consumers migrate; stale generated snapshots can drift for ≤24h.

## Open Questions

1. **Embedding model & dimension**: BGE-small (384d) is cheap and Postgres-friendly. BGE-large (1024d) and OpenAI text-embedding-3-large (3072d) score higher on retrieval. Recommendation: start with 384d, benchmark recall@20 in Sprint 3, upgrade if < 0.85.
2. **Multilingual scope at launch**: ontology supports `labels: {en, pt, zh, ...}` but Sprint 1 will seed only `en` + `pt`. Other languages added on demand.
3. **Schema-version migration policy**: when `vision` splits into `vision_image` + `vision_video`, do we (a) rewrite all assertions, or (b) leave history and only re-materialise the projection? Recommendation: (b) — history is immutable.
4. **Operator-override UX**: assertion source `operator-override` needs a tiny admin UI (or CLI) before Sprint 1 ships, otherwise corrections require raw SQL.
5. **Confidence calibration**: source weights above are best-guess. Sprint 4 should add a calibration job comparing predicted-vs-observed capability success from L7 feedback.

## Implementation Notes

- Migration file: `api/prisma/migrations/<TS>_capability_ontology_and_hcra/migration.sql`. Three statements: ontology table, assertions table, models patches. Wrap in `BEGIN; ... COMMIT;` and add `CREATE EXTENSION IF NOT EXISTS vector;` at the top.
- New module tree:
  ```
  api/src/capability/
    ontology/         loader.ts, expander.ts, embedder.ts
    assertions/       writer.ts, materialiser.ts (Bayesian fusion worker)
    search/           parser.ts, recall.ts, rerank.ts, controller.ts
    sources/          provider-declared.ts, helicone-oracle.ts, llm-extracted.ts
  ```
- Existing `model-capability-merger.ts` (Layer 1b/2b scaffold) becomes the **interim** merger — replaced by `assertions/materialiser.ts` in Sprint 2. Keep its API stable so callers don't churn.
- L5 (`provider-bandit.ts`) and L10 (`contextual-provider-bandit.ts`) need a one-line change in Sprint 3 to read `capability_confidence[uri]` instead of `capability_uris.includes(uri) ? 1 : 0`.

## References

- SKOS — Simple Knowledge Organization System (W3C): https://www.w3.org/TR/skos-reference/
- pgvector HNSW: https://github.com/pgvector/pgvector#hnsw
- Snorkel weak supervision (source-weight calibration): https://www.snorkel.org
- ADR-016 (Privacy mode serializer enforcement) — established source-weight precedent
- ADR-021 (Retention & erasure) — compliance template followed here
- L11 `routing_event_store.ts` — append-only pattern reused for assertions
