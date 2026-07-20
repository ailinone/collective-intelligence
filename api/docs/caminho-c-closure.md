<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Caminho-C — Closure Note

**Status:** structurally complete (4 commits, 4 surfaces, 25 tests).
**Operator handoff:** Phases 6–10 (rebuild → deploy → measure → drop → audit).

## What "Caminho-C" Means

The user's earlier decision tree, asked at the start of the SOTA closure
plan: *"resolve issues #1 (all models functional) and #2 (all requests
functional) FULLY before connecting CapabilitySearchService to
dynamic-model-selector."*

Pragmatic interpretation: lay the structural rails so that when an
operator runs Phase 6/7 and observes baseline behaviour, the wiring
to enable HCRA-aware selection is one config flip away — not a code
change. This note documents the rails.

## The Four Stages

### Stage 1 — Translator + Ontology Gap Closure

**Commit:** `d110a32` — `feat(capability): legacy<->URI translator + close 6 ontology gaps`

**Surface:** `api/src/capability/legacy-capability-uri.ts` + 6 entries
added to `api/src/capability/ontology/seed.ts`.

**What it does:** every legacy `ModelCapability` enum value
(`'chat' | 'vision' | …`) round-trips losslessly to a canonical URI
(`http://ailin.dev/cap/v1/<slug>`). The cross-check test
`every legacy capability slug is present in ONTOLOGY_SEED` caught a
real 6-row drift between the legacy union and the seed. The fix added
proper ontology entries (with synonyms, descriptions, broader/narrower
edges) for `reranking`, `retrieval`, `code_edit`, `moderation`,
`safety`, `long_context`.

**Why a translator (vs a refactor):** during the HCRA backfill window
~half the catalog has only the legacy `capabilities[]` array. A
translator lets the rest of the codebase speak URI-native while the
backfill catches up. No flag day.

**Tests:** 10/10 (`api/src/capability/__tests__/legacy-capability-uri.test.ts`).

### Stage 2 — Selector URI-Track Filter + Legacy Fallback

**Commit:** `2b45079` — `feat(selector): URI-track capability matching with legacy fallback`

**Surface:** `dynamic-model-selector.ts` filter at line ~388.

**What it does:** the in-memory ALL-of capability filter now prefers
the URI track when `model.capabilityUris` is populated. When it isn't
(unmigrated row, empty array), the filter falls through to the legacy
`capabilities[]` array. Both tracks enforce ALL-of semantics — a model
missing any one required capability is rejected.

**Why a two-track filter (vs URI-only):** flag day is hostile during
backfill. A URI-only filter would silently exclude every unmigrated
row from selection — the long tail of pre-HCRA models would just
disappear. Two-track keeps them visible while the materialiser catches
up.

**Tests:** 9/9 (`api/src/core/selection/__tests__/capability-uri-matching.test.ts`).
Mixed-population test simulates a backfill mid-flight.

### Stage 3 — HCRA Confidence-Aware Ranking

**Commit:** `32779b4` — `feat(selector): HCRA confidence-aware ranking in calculateCapabilityFit`

**Surface:** `dynamic-model-selector.ts:1561` — `calculateCapabilityFit`
becomes a 50/50 blend of (a) context-window adequacy (existing) and
(b) HCRA capability-confidence (new geometric mean over required URIs).

**What it does:** among the survivors of the Stage 2 filter, prefer
models with stronger HCRA evidence on the required capabilities.
A model with `capabilityConfidence={chat:0.95, vision:0.92}` ranks
above one at `{chat:0.55, vision:0.5}`. Geometric mean enforces the
ALL-of "weakest link" property — `[1.0, 0.1]` ranks below `[0.6, 0.6]`
even though arithmetic means tie.

**Why backfill-neutrality (returns 0.5 when no confidence map):**
penalising unmigrated rows would hide working providers from the
selector during the HCRA backfill window. 0.5 means "no signal —
fall back to the upstream gates" — effectively making this dimension
a no-op for unmigrated rows while still rewarding migrated rows with
strong evidence.

**Why geometric (vs arithmetic) mean:** arithmetic mean would let a
model with `[1.0, 0.1]` tie one with `[0.6, 0.6]` despite being
dangerously weak on one capability. Geometric mean (`exp(mean(log(c)))`)
penalises the weakest link, matching the ALL-of semantic the upstream
filter uses.

**Defence in depth:** if a future refactor bypasses the Stage 2 filter
and a model with a missing URI reaches scoring, the per-URI clamp at
`Math.max(0.01, …)` keeps the geometric mean finite (returns ~0.215
for a single missing URI in a 3-cap query rather than zero).

**Tests:** 13/13 (`api/src/core/selection/__tests__/capability-confidence-ranking.test.ts`).

### Stage 4 — CapabilitySearchService Module-Level Singleton

**Commit:** `f16f8e9` — `refactor(capability-search): module-level singleton + test stub injection`

**Surface:** `api/src/capability/search/capability-search-singleton.ts`.

**What it does:** extracts the route-local cache (previously in
`capabilities-search-routes.ts:127-133`) into a module-level singleton
with a public getter, test stub injection, and reset semantics. Mirrors
the existing `getCapabilityPool()` pattern.

**Why now (vs after Phase 6/7 measurement):** the structural shape is
the cheap part. Wiring the singleton means any future surface that
wants RRF-based candidate generation in the hot path — selector,
admission control, batched orchestration — gets it via one import.
The route-local cache made the service unreachable from anywhere else
in the codebase. With the extraction, the operator gate moves from
"need to refactor the route" to "need to enable the flag in the
selector" — a much smaller call.

**What it does NOT do:** wire the singleton into the selector hot path.
That's intentional. Per the user's prior decision (resolve #1 + #2
first), selector calls `CapabilitySearchService` only after Phase 6
measures the latency cost of RRF (≈10–50ms per selection). Until then,
the singleton sits ready but unused by selection.

**Tests:** 3/3 (`api/src/capability/search/__tests__/capability-search-singleton.test.ts`).

## End-to-End Data Path (Now Wired)

```
materialiser.ts:writeProjection
  └─ UPDATE models SET capability_uris, capability_confidence, …
       │
       ▼
Prisma (raw models table read)
  └─ record.capabilityUris, record.capabilityConfidence
       │
       ▼
dynamic-model-selector.ts mapper (line ~335)
  └─ Model.capabilityUris, Model.capabilityConfidence
       │
       ├─► Stage 2 filter (line ~388) — URI track preferred, legacy fallback
       │
       └─► Stage 3 ranking (line 1561) — geometric mean confidence boost
              │
              ▼
       SelectedModel.score (multi-objective optimizer)
```

Every join in this chain is unit-tested. The chain is operator-bound
only at the materialiser source: `materialiseAllCapabilities()` runs
when an operator triggers it (or on the scheduled job, when the env
gate is on). Before that runs, the selector behaves identically to
pre-Caminho-C — Stage 2's legacy fallback and Stage 3's neutrality
guarantee no regression.

## Test Inventory

| Surface | File | Count |
|---|---|---|
| Stage 1 translator + ontology cross-check | `api/src/capability/__tests__/legacy-capability-uri.test.ts` | 10 |
| Stage 2 URI-track filter | `api/src/core/selection/__tests__/capability-uri-matching.test.ts` | 9 |
| Stage 3 confidence ranking | `api/src/core/selection/__tests__/capability-confidence-ranking.test.ts` | 13 |
| Stage 4 singleton | `api/src/capability/search/__tests__/capability-search-singleton.test.ts` | 3 |
| Pre-existing canonical guards | `api/src/core/selection/__tests__/provider-kind-canonical-coverage.test.ts` | 4 |
| **Total** | | **39** |

Last full run: 39/39 green. Catalog invariants: 371/371. Capability+selection
combined: 67/67.

## What This Closure Does NOT Cover

- **Live selection latency under RRF.** Stage 4 sets up the singleton
  but the selector hot path still uses the in-memory ranking. Switching
  to RRF requires Phase 6/7 measurement first; if RRF adds >50ms p99,
  we keep in-memory ranking and use the singleton only for the human-
  facing search route.

- **Materialiser scheduling.** The materialiser is operator-triggered.
  This closure assumes whoever runs Phase 6 also runs the materialiser
  before measuring the selection latency baseline.

- **pgvector embedding regeneration.** When the ontology gains 6 new
  rows (Stage 1), the embedder must be re-run for the new entries.
  The embed worker has its own scheduled job; this closure assumes
  the operator triggers it as part of Phase 6.

## Operator Punch List (Caminho-C Specific)

These are the ops actions to fully activate Caminho-C in production.
**Run them in order** — each step depends on the previous.

### Prerequisites
```bash
export DATABASE_URL="postgresql://ci_user:ci_password@localhost:5434/ci_db"
# Or in prod: the connection string for the live ci-api DB.
export HCRA_EMBEDDER_URL="http://localhost:8080"
export HCRA_EMBEDDER_MODEL="BAAI/bge-small-en-v1.5"
```

### 1. Reseed the ontology (idempotent)

Pushes `ONTOLOGY_SEED` — including the 6 new entries from Stage 1
(`reranking`, `retrieval`, `code_edit`, `moderation`, `safety`,
`long_context`) — into `capability_ontology`. Without this, lexical
recall hits 0 for the new slugs.

```bash
pnpm tsx scripts/hcra-reseed-ontology.ts
# Expected: "[hcra-reseed] upserting <N> ontology entries..." then
# "done in Xs — ontology rows: N, edges refreshed: M"
```

### 2. Generate embeddings for the new ontology rows

The embed worker fills NULL embeddings on `capability_ontology` and
`models`. Without this, vector recall returns 0 for the new slugs and
the RRF fusion degrades to lexical-only.

```bash
# Ontology only (faster — ~6 rows for the new entries):
pnpm tsx scripts/hcra-run-embeddings.ts --skip-models

# Or full sweep (ontology + all unmigrated models):
pnpm tsx scripts/hcra-run-embeddings.ts
```

### 3. Run the materialiser

Bayesian noisy-OR fusion over `model_capability_assertions` →
`models.capability_uris / capability_confidence / capability_sources`.
Until this runs, Stage 3 ranking returns the neutral 0.5 for every
model — the new scoring dimension does nothing in practice.

```bash
pnpm tsx scripts/hcra-materialise.ts
# Expected: "models_written=<N> models_cleared=<M> caps_emitted=<K>
# caps_suppressed=<L>"
```

### 4. Verify the search route surfaces the new entries

```bash
curl -s 'localhost:3001/v1/capabilities/ontology/search?q=reranking' \
  -H "Authorization: Bearer $TOKEN" | jq '.hits | length'
# Expect: > 0
curl -s 'localhost:3001/v1/capabilities/ontology/search?q=safety' \
  -H "Authorization: Bearer $TOKEN" | jq '.hits[0].uri'
# Expect: "http://ailin.dev/cap/v1/safety"
```

### 5. (Optional) Enable RRF in the selector hot path

Currently NOT wired. The singleton (`getCapabilitySearchService()`)
is reachable from the selector module but no call site invokes it
in `score()`. If Phase 6 measurements show RRF p99 < 50ms acceptable,
wire it via a feature flag and gate it behind an env var like
`SELECTOR_RRF_ENABLED=true`. Until then, in-memory ranking is the
production behaviour.

### Ordering rationale

Step 1 must precede step 2 (you can't embed rows that don't exist).
Step 2 must precede step 4 (vector recall needs embeddings). Step 3
is independent of 1-2 *for existing models* but DOES depend on
existing assertions; if the assertions table is empty, step 3 writes
nothing and Stage 3 stays in neutral mode. Step 4 is the smoke test
for steps 1-2; step 3 has no equivalent route-level smoke test —
inspect `SELECT capability_uris, capability_confidence FROM models LIMIT 5`
in the DB instead.

## Sequencing Pointer

After running the operator punch list above, the SOTA closure plan's
Phase 6 (local rebuild + measurement) becomes meaningful — the
selector will actually see HCRA confidence values instead of all
0.5 neutrals.

Before the operator punch list runs, behavioural metrics will look
pre-Caminho-C even though the structural code is in place. This is
expected and not a regression — it's the "lazy activation" property
the four stages were designed for.

---

**Author:** structural review, 2026-04-29.
**Commits:** `d110a32`, `2b45079`, `32779b4`, `f16f8e9`.
**Adjacent docs:** `provider-runtime-baseline.json`,
`provider-runtime-matrix.csv`, `phase-3-bytez-closure.md`,
`operator-action-punch-list.md`, `phase-10-canonical-audit.md`.
