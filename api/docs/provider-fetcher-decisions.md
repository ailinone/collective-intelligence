<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Phase 3B — staticModels Fetcher Decisions

**Source of truth:** [provider-runtime-matrix.csv](provider-runtime-matrix.csv) +
catalog rows in [providers.catalog.ts](../src/providers/catalog/providers.catalog.ts).

**Goal:** every catalog entry currently using `staticModels` either gains a
working dynamic discovery path (DROP `staticModels`, flip to
`discovery+execution`) OR migrates to the new `pinnedFallback` field with
explicit semantics (no-list-endpoint, workspace-scoped, per-deployment,
proprietary-schema). The literal `staticModels` field is forbidden after
Phase 4.

---

## Schema change

Add to [provider-catalog.types.ts](../src/providers/catalog/provider-catalog.types.ts):

```ts
pinnedFallback?: {
  /** Curated list of model IDs the router treats as canonical when no live discovery is available. */
  models: readonly string[];
  /** Why this provider can't be discovered dynamically. */
  reason:
    | 'no-list-endpoint'
    | 'workspace-scoped'
    | 'per-deployment'
    | 'proprietary-schema';
  /** ISO-8601 date of the last operator review of the model list. CI fails if older than 90 days. */
  lastReviewedAt: string;
};
```

`staticModels` becomes a forbidden key (Phase 5 invariant test). Boot
behaviour for `pinnedFallback`:
1. Catalog loader registers the listed models as canonical pinned entries.
2. Capability search treats them as first-class.
3. Routing strategies treat them as live candidates with a `synthetic: true`
   flag (so health-check failures don't propagate the way they would for
   discovered models).

---

## 16 decisions

| # | Line | providerId | Decision | New `integrationMode` | Reason |
|---|---|---|---|---|---|
| 1 | 158 | perplexity | **DROP** staticModels | (already `discovery+execution`) | OAI-compat `/v1/models` works (matrix shows 19 models in DB despite staticModels) |
| 2 | 620 | voyage | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | Voyage `/v1/models` exists; embeddings+rerank list is dynamic |
| 3 | 792 | recraft | **MIGRATE** to `pinnedFallback` | (keep `execution-only`) | reason=no-list-endpoint; image-only API has no `/models` route |
| 4 | 823 | runwayml | **MIGRATE** to `pinnedFallback` | (keep `execution-only`) | reason=no-list-endpoint; video-only API |
| 5 | 877 | bfl | **MIGRATE** to `pinnedFallback` | (keep `execution-only`) | reason=no-list-endpoint; FLUX image-only API |
| 6 | 957 | replicate | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | `replicate-model-fetcher.ts` already exists; `discoveryPath=native-file` per matrix |
| 7 | 1019 | bytez | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | `bytez-native-model-fetcher.ts` aggregator already materializes models (4 in DB) |
| 8 | 1090 | inworld | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | `inworld-model-fetcher.ts` already exists (6 in DB) |
| 9 | 1230 | azure-openai | **MIGRATE** to `pinnedFallback` | (keep `execution-only`) | reason=per-deployment; URL embeds operator-chosen deployment alias — no global `/models` |
| 10 | 1356 | databricks | **MIGRATE** to `pinnedFallback` | (keep `execution-only`) | reason=workspace-scoped; foundation-model APIs vary per workspace |
| 11 | 2036 | writer | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | Writer `/v1/models` returns `{models: [...]}` shape; bridge fetcher handles it via response-shape adapter (Phase 4) |
| 12 | 2163 | atlascloud | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | Pure OAI-compat at `api.atlascloud.ai/v1` |
| 13 | 2188 | avian | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | Pure OAI-compat at `api.avian.io/v1` |
| 14 | 2237 | qianfan | **DROP** staticModels + flip mode | `discovery+execution` (was `execution-only`) | Pure OAI-compat at `qianfan.baidubce.com/v2/...`; bce-v3 bearer auth |
| 15 | 2310 | inflection | **MIGRATE** to `pinnedFallback` | (keep `catalog-only`) | reason=proprietary-schema; layercake.pubwestus3.inf7ks8.com surfaces only a custom `/external/api/inference` route, no `/models` |
| 16 | 2379 | relace | **MIGRATE** to `pinnedFallback` | (keep `catalog-only`) | reason=proprietary-schema; specialty code-edit endpoint with no model listing |

**Tally:**
- DROP `staticModels` (8): perplexity, voyage, replicate, bytez, inworld, writer, atlascloud, avian, qianfan
  *(9 entries; perplexity was already `discovery+execution`)*
- MIGRATE to `pinnedFallback` (7): recraft, runwayml, bfl, azure-openai, databricks, inflection, relace
- **Total: 16** ✓

**Mode flips (Phase 4 input):**
- `execution-only` → `discovery+execution`: 8 (voyage, replicate, bytez, inworld, writer, atlascloud, avian, qianfan)
- No mode change for the 7 `pinnedFallback` migrations or for perplexity.

---

## Per-fetcher dependency check

For each "DROP staticModels + flip to discovery+execution" decision, verify the
discovery path before flipping in Phase 4:

| providerId | discoveryPath (matrix) | live verification owner |
|---|---|---|
| perplexity | oai-compat-bridge | bridge already running; Phase 6 measures |
| voyage | static-only → must become embeddings-aware bridge OR custom fetcher | Phase 4 review: voyage `/v1/models` actually returns rerank+embed mixed; may need custom shape adapter |
| replicate | native-file (`replicate-model-fetcher.ts`) | fetcher exists; flip mode and rebuild |
| bytez | hardcoded-source (`bytez-native-model-fetcher.ts` aggregator) | already materializes 4 in DB |
| inworld | native-file (`inworld-model-fetcher.ts`) | already materializes 6 in DB |
| writer | static-only → must become bridge with `{models: [...]}` shape adapter | Phase 4 may need a one-off shape transform |
| atlascloud | static-only → bridge | Phase 4 flips, Phase 6 verifies |
| avian | static-only → bridge | Phase 4 flips, Phase 6 verifies |
| qianfan | static-only → bridge | Phase 4 flips, Phase 6 verifies (also depends on operator-provisioned GCP secret per Phase 2) |

**Risk:** writer and voyage have non-canonical `/models` shapes. If the
Phase-6 rebuild shows zero discovered models for either, escalate to Phase 3B
custom fetcher (build `writer-model-fetcher.ts` / `voyage-model-fetcher.ts`).

---

## `pinnedFallback` migration template

For each MIGRATE decision, the catalog edit looks like:

```diff
   apiKeyEnvVar: 'RECRAFT_API_KEY',
-  staticModels: ['recraftv3', 'recraftv2'],
+  pinnedFallback: {
+    models: ['recraftv3', 'recraftv2'],
+    reason: 'no-list-endpoint',
+    lastReviewedAt: '2026-04-28',
+  },
```

`lastReviewedAt` for all 7 migrations = `2026-04-28` (today). Phase 5 CI guard
fires if any `lastReviewedAt` is older than 90 days.

---

## Net effect after Phase 4 lands

| Metric | Before | After | Δ |
|---|---|---|---|
| Catalog entries with `staticModels` | 16 | 0 | −16 |
| Catalog entries with `pinnedFallback` | 0 | 7 | +7 |
| Catalog entries in `execution-only` mode | 13 | 5 | −8 |
| Catalog entries in `discovery+execution` mode | (current) | +8 | +8 |

**Phase 3B exit criteria met:** every of the 16 staticModels entries has an
explicit DROP-or-MIGRATE decision with a named fix. Phase 4 consumes this
table directly into the catalog edit PR.
