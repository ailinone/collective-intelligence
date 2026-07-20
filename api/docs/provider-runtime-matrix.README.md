<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# provider-runtime-matrix.csv — README

Single source of truth for the 81-provider catalog. Joined static evidence from the catalog, GCP, and code with derived runtime evidence from the post-c85b844 baseline boot.

## When this file changes

- **Catalog edits** (Phase 4 transformations) → re-run the static-side capture script and regenerate columns 1–21.
- **Runtime baseline rotation** (any new full boot of `ci-api`) → re-run the dynamic-side capture script and regenerate columns 18, 19, 22, 23.
- **Caminho-C ships** (CapabilitySearchService wired into model selection) → flip columns 24, 25 from `operator-bound` to actual values, then drop this caveat from the README.

## Column key

| # | Column | Source | Type |
|---|---|---|---|
| 1 | `providerId` | `providers.catalog.ts` | static |
| 2 | `integrationClass` | catalog `integrationClass` | static |
| 3 | `integrationMode` | catalog `integrationMode` | static |
| 4 | `hasStaticModels` | `'staticModels' in entry` | static |
| 5 | `apiKeyEnvVar` | catalog `apiKeyEnvVar` | static |
| 6 | `apiKeyOptional` | catalog `apiKeyOptional` | static |
| 7 | `enabledByDefault` | catalog `enabledByDefault` | static |
| 8 | `denyByDefault` | catalog `denyByDefault` | static |
| 9 | `secretInProviderSecrets` | grep `PROVIDER_SECRETS` in `load-secrets-into-env.ts` | static |
| 10 | `secretInEnvVarToProvider` | grep `ENV_VAR_TO_PROVIDER` in `load-secrets-into-env.ts` | static |
| 11 | `secretInLlmProviderEnvVars` | grep `LLM_PROVIDER_ENV_VARS` in `central-model-discovery-service.ts` | static |
| 12 | `secretWiredAllTables` | logical AND of 9 ∧ 10 ∧ 11 | derived |
| 13 | `secretExistsInGCP` | `gcloud secrets list --filter='name~ailin-'` (last refreshed: see `provider-runtime-baseline.json`) | snapshot |
| 14 | `fetcherExists` | resolved by `central-model-discovery-service.ts` source registry OR catalog-bridge auto-instantiation | derived |
| 15 | `fetcherIsHardcoded` | true iff a hand-written entry in `central-model-discovery-service.ts:1599-1825` (vs catalog-bridged) | static |
| 16 | `discoveryPath` | `oai-compat-bridge` / `hardcoded-source` / `native-file` / `static-only` / `none` / `none-catalog-only` / `none-quarantined` | derived |
| 17 | `adapterExists` | resolved by `provider-registry.ts` (default factory or explicit `adapterClass`) | derived |
| 18 | `pluginStatus` | boot logs from baseline run — `registered` / `failed` / `skipped` | runtime |
| 19 | `modelsInDb` | `SELECT COUNT(*) FROM models WHERE provider_id=$1` from baseline run | runtime |
| 20 | `status` | `green` / `amber` / `red` rollup | derived |
| 21 | `decision` | `KEEP` / `FIX` / `DROP` per Phase-9 drop-list | curated |
| 22 | `endpointResponds` | derived from 18 + 19 — see Derivation Rules below | derived |
| 23 | `inV1Models` | `modelsInDb > 0` — `/v1/models` is a 1:1 projection of the DB rows minus dedup | derived |
| 24 | `inSemanticSearch` | `operator-bound` until Caminho-C wires `CapabilitySearchService` into `dynamic-model-selector.ts:286` | runtime-pending |
| 25 | `inCapabilitySearch` | `operator-bound` — same wiring blocker as 24 | runtime-pending |
| 26 | `notes` | per-row remediation context | curated |

## Derivation rules

### `endpointResponds` (column 22)

| Boot-time state | endpointResponds | Reasoning |
|---|---|---|
| `registered` ∧ `modelsInDb > 0` | `true` | Health-check passed AND first discovery cycle returned ≥1 parseable model row. |
| `registered` ∧ `modelsInDb == 0` | `true-but-empty` | Health-check passed but discovery returned no rows. Either the endpoint genuinely has no listable inventory, the shape is non-coercible, or rate-limit at boot. Investigate per-provider in `provider-failure-diagnosis.md`. |
| `failed` | `unknown-or-false` | Plugin registration failed. Could be an auth error (4xx with valid endpoint), a missing-key error (no fetch attempted), a shape mismatch (parsing failure), or a 5xx. Pre-flight log inspection required to disambiguate. |
| `skipped` | `not-attempted` | Either `enabledByDefault: false` with no env override, or self-hosted opt-in. Endpoint reachability is unknown until enabled. |

### `inV1Models` (column 23)

`/v1/models` returns every DB row whose `provider_id` resolves to a registered runtime adapter. Dedup-by-id is applied only across providers that share the same canonical model id. Therefore `modelsInDb > 0` is necessary AND sufficient for `inV1Models = true` per provider.

The 364-row delta between `dbModelsTotal=64409` and `v1ModelsRunnable=64045` (see baseline) is the dedup loss across providers — not a per-provider exclusion.

### `inSemanticSearch` & `inCapabilitySearch` (columns 24, 25)

These read `operator-bound` until **Caminho-C** ships. Today:

- `CapabilitySearchService` exists at `api/src/capability/search/capability-search-service.ts` and is exposed via `/capabilities/search?q=…`.
- It uses RRF-fused (k=60) hybrid search: pgvector cosine on `embedding` ⨉ array-overlap on `capability_uris`.
- BUT: model selection at `api/src/services/dynamic-model-selector.ts:286` still issues raw `WHERE capabilities @> $1::jsonb` against the deprecated `capabilities` JSON column.
- Therefore: a provider can be returned by `/capabilities/search` (column 25 = true) yet not selected for routing (no causal effect on `inSemanticSearch` from the routing perspective).

To avoid encoding a misleading "true" into column 25 today, both columns read `operator-bound` until the wiring lands. After Caminho-C, regenerate via the dynamic-side capture script.

## How to regenerate

### Static columns (1–17, 20, 21)

```bash
node scripts/_phase1-matrix.cjs
```

(Reads catalog + greps secret tables. Idempotent.)

### Dynamic columns (18, 19, 22, 23)

```bash
docker compose -f docker/docker-compose.yml up -d --build
# Wait for HTTP bind (~150-180s)
node scripts/extend-runtime-matrix.mjs   # idempotent — no-op if header already has the 4 cols
```

The dynamic capture script reads from `provider-runtime-baseline.json` (committed snapshot). Update that file first if you want fresh numbers — see `provider-runtime-baseline.json._capturedAt`.

## Cross-references

- [provider-runtime-baseline.json](./provider-runtime-baseline.json) — boot-time snapshot powering columns 18, 19
- [provider-failure-diagnosis.md](./provider-failure-diagnosis.md) — per-row root cause for `pluginStatus=failed` rows
- [provider-drop-list.md](./provider-drop-list.md) — KEEP/HOLD/REGRESSION/DROP per Phase-9
- [phase-7-prod-parity-baseline.md](./phase-7-prod-parity-baseline.md) — local-vs-prod cardinality diff
- [phase-10-canonical-audit.md](./phase-10-canonical-audit.md) — 10-question audit closure
