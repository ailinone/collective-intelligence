// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Zero-hardcoded model-inventory guard (2026-09-03, LOTE AI convergence).
 *
 * Mission contract (SOTA §4/§5): a production model must NOT exist in the
 * `ci` model inventory merely because its identifier was typed into source
 * code. Model identifiers may appear in unit/contract-test fixtures,
 * documentation examples and migration tests — but MUST NOT become
 * production inventory from those values.
 *
 * This guard enforces three structural invariants over production code
 * (`api/src`, tests excluded):
 *
 *   (1) **No `staticModels` arrays** — the legacy `staticModels:` property
 *       must not be (re)introduced anywhere in production source. The
 *       catalog migrated every site to the audited `pinnedFallback`
 *       mechanism on 2026-04-28 (Phase 4d); `catalog-provider-plugin.ts`
 *       keeps a read-only compatibility branch only.
 *
 *   (2) **No uppercase MODEL-array constants** — `const KNOWN_MODELS = [...]`
 *       style inventories in production files are forbidden unless they are
 *       on the explicit dated allowlist below (with an elimination plan).
 *       Constants whose arrays contain no string literals (pure numbers,
 *       empty) are ignored — they cannot encode model IDs.
 *
 *   (3) **pinnedFallback closure** — the set of catalog providers carrying
 *       `pinnedFallback.models` must be EXACTLY the legacy allowlist below.
 *       Adding a new pinned inventory silently is impossible: the test
 *       fails with a diff. Removing one also fails until the allowlist is
 *       shrunk — the allowlist may only shrink over time (elimination
 *       plan per entry). Cross-checked against the
 *       DISCOVERY_COMPLIANCE_REGISTRY buckets that legitimately classify
 *       pinned inventories so the two sources of truth cannot drift.
 *
 * The scanner itself is regex-structural (not full AST) but every pattern
 * is covered by embedded self-tests below proving both detection and
 * false-positive control. If a pattern proves too brittle, fix the pattern
 * AND its self-test in the same commit — never delete a self-test.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';
import { PROVIDER_CATALOG } from '../providers.catalog';
import { DISCOVERY_COMPLIANCE_REGISTRY } from '../consolidation-matrix';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = join(__dirname, '..', '..', '..');

// ─── Allowlists ───────────────────────────────────────────────────────────

/**
 * Legacy pinnedFallback inventories (catalog rows whose model list is
 * operator-curated in source). This set may only SHRINK. Every entry has a
 * classification in DISCOVERY_COMPLIANCE_REGISTRY and a dated elimination
 * plan; removing the catalog row's pinnedFallback requires updating this
 * allowlist in the same commit (and vice versa — see closure test).
 *
 * 2026-09-12 — allowlist GREW by 1 (cartesia). NOT a regression of the
 * shrink-only ratchet: cartesia is a NEW by-design row, not a re-addition
 * of a previously-eliminated one. Migrated off a switch case (which this
 * guard never scanned) onto a catalog row with a curated pinnedFallback
 * — same `no-list-endpoint` terminal state as recraft/runwayml/bfl/
 * inworld/v0/topaz below, proven by both Cartesia's own docs
 * (docs.cartesia.ai/api-reference/tts/bytes — model_id is a request
 * PARAMETER on that page, not a listable resource) and the cartesia-js
 * SDK's current file tree (no `models` resource file). See
 * providers.catalog.ts's discovery-audit comment on this row for the
 * full citation.
 *
 * Elimination plan (tracked per mission SOTA §11):
 *   - by-design rows (no upstream /models, ever): recraft, runwayml, bfl,
 *     inworld, v0, topaz, cartesia → terminal state, they ARE the inventory
 *     contract (see `pinnedFallback-by-design` bucket). "By design" now
 *     means route-absence was PROVEN, not merely undocumented: v0, voyage,
 *     bfl and inworld each 404 on `/v1/models` while their host answers
 *     other paths. runwayml and topaz additionally RECONFIRMED (LOTE AR,
 *     2026-09-06) with a real, valid credential — both still 404 their
 *     candidate discovery path identically to a same-host control path even
 *     WITH a working key, sanity-checked against each adapter's own known-
 *     real endpoint — so this is now a proven terminal state, not merely
 *     "no key available".
 *   - debt rows (upstream surface exists, parser pending): inflection →
 *     write the parser, drop the pin, move the registry entry to
 *     compliant-dynamic-discovery. (relace closed this exact path 2026-09-09,
 *     see the LOTE AT note below.)
 *   - deployment-scoped / seed rows: aws-bedrock (bootstrap pins ahead of
 *     first authenticated deployment discovery), azure-openai, databricks,
 *     replicate, qianfan, voyage → replaced by authenticated discovery /
 *     on-demand validation when credentials or endpoints permit.
 *
 * 2026-09-04 (LOTE AK) — allowlist SHRANK by 4. perplexity, writer,
 * atlascloud and avian were removed because a discriminated live probe
 * (`/v1/models` vs a nonsense control path on the same host, so an
 * auth-first middleware cannot masquerade as a live route) proved each
 * vendor really does serve a listing endpoint. Their catalog rows dropped
 * pinnedFallback and moved to `compliant-dynamic-discovery`. The ratchet
 * direction is intact: this set may only shrink.
 *
 * 2026-09-05 (LOTE AL) — allowlist SHRANK by 1. qianfan removed: official
 * docs (cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y) confirm GET /v2/models
 * returns a standard {data:[{id,context_length,...}]} body, already covered
 * by the hub parser. The catalog row dropped pinnedFallback and moved to
 * `compliant-dynamic-discovery`.
 *
 * 2026-09-05 (LOTE AN, GAP-AK-6) — allowlist SHRANK by 2, the last two
 * "deployment-scoped / seed" rows whose enumeration route was documented and
 * credentialed but simply never called:
 *   - databricks: `DatabricksModelFetcher` now enumerates
 *     GET /api/2.0/serving-endpoints (Bearer DATABRICKS_TOKEN, already wired).
 *     The 9 pins were a snapshot of the canonical Foundation Model APIs, but a
 *     serving endpoint is workspace-PRIVATE — the list over-claimed endpoints a
 *     workspace may not have provisioned and under-claimed its custom ones.
 *   - aws-bedrock: `AWSBedrockModelFetcher` (ListFoundationModels via the AWS
 *     SDK) was already registered as the `aws-bedrock-hub` source; the 13 pins
 *     only masked the fact that the row never consulted it. The same change
 *     removed that fetcher's `estimateModelSpecs()` keyword table, which
 *     invented context windows and per-token pricing that Bedrock does not
 *     report at all.
 * NEITHER is live-validated: no AWS credential and no Databricks workspace
 * exist in this environment. Both are mock-tested against structurally
 * faithful fixtures of the documented responses — see GAP-AK-6.
 *
 * 2026-09-06 (LOTE AR) — allowlist SHRANK by 1. vivgrid removed: an
 * authenticated probe with a real key found GET /v1/models -> 200, a
 * genuine OpenAI-shaped model list (previously the global 401 auth gate
 * made route existence unprovable either way). The catalog row dropped
 * pinnedFallback and moved to `compliant-dynamic-discovery`. replicate
 * stays pinned deliberately (reason='curated-shortlist' — /v1/models works
 * but returns thousands of noisy, mostly non-LLM predictions; a real key
 * this session reconfirmed the route works exactly as already documented,
 * which does not change the curation rationale).
 *
 * 2026-09-09 (LOTE AT, GAP-AK-6 closure) — allowlist SHRANK by 1. relace
 * removed: the official OpenAPI spec (docs.relace.ai/api-reference/
 * openapi.json) documents a real `GET /models` on models.relace.ai
 * ("the catalog for open-weight models hosted by Relace"), Bearer-authed,
 * returning a standard {data:[{id,context_length,pricing,...}]} body
 * already covered by the hub parser — a DIFFERENT host than the row's
 * previous baseUrl (instantapply.endpoint.relace.run, absent from the
 * current spec's servers list entirely). The catalog row's baseUrl moved to
 * models.relace.ai/v1 (matching the spec's documented `/v1/chat/completions`
 * OAI-compat surface), integrationMode flipped catalog-only ->
 * discovery+execution, and pinnedFallback was dropped. Of the 3 previously
 * pinned ids, only `relace-apply-3` is independently confirmed real (it is
 * literally the sole enum value of `InstantApplyRequest.model` in the spec)
 * — `relace-code-reranker` and `relace-embedding` appear NOWHERE in the
 * spec (there is no `/v1/embeddings` path at all), so they were unverified/
 * likely-fabricated, not merely undiscovered. None of the 3 are carried
 * forward as catalog rows: they are fixed single-purpose tool contracts
 * (code-apply/rerank/compact/search), not a family of interchangeable chat
 * models this catalog's discovery/pinnedFallback semantics enumerate — see
 * the `relace` catalog entry's own notes for the full architecture
 * rationale.
 */
const LEGACY_PINNED_INVENTORY: ReadonlySet<string> = new Set([
  'v0', 'voyage', 'recraft', 'runwayml', 'topaz', 'bfl', 'cartesia',
  'replicate', 'inworld', 'azure-openai',
  'inflection',
]);

/**
 * Uppercase MODEL-array constants tolerated in production code, keyed
 * `relative-path::CONST_NAME`. Each carries a reason + plan.
 */
const LEGACY_MODEL_CONST_ARRAYS: ReadonlySet<string> = new Set([
  // Prefix hints used to ROUTE, not a model inventory (voyage-*, rerank-*).
  // Not eliminable — it is a namespace declaration, not an ID list.
  'providers/voyage/voyage-adapter.ts::KNOWN_MODEL_PREFIXES',
  // DEBT (2026-09-03): genuine hardcoded seed IDs. Elimination: Jina
  // exposes model metadata at account scope — replace with the documented
  // models endpoint/parser, then delete this allowlist entry.
  'services/model-fetchers/jina-model-fetcher.ts::DEFAULT_JINA_SEED_MODELS',
]);

// ─── Scanner ──────────────────────────────────────────────────────────────

function listProductionTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'dist') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === '__tests__' || name === '__mocks__') continue;
        walk(full);
      } else if (
        name.endsWith('.ts') && !name.endsWith('.d.ts') &&
        !name.includes('.test.') && !name.includes('.spec.')
      ) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Pattern (1): legacy `staticModels: [...]` property with a non-empty array. */
const STATIC_MODELS_RE = /staticModels\s*:\s*\[[^\]]*\S[^\]]*\]/;

/**
 * Pattern (2): uppercase *MODEL* const array literals containing at least
 * one string literal (i.e. capable of encoding model IDs).
 */
const MODEL_CONST_RE =
  /(?:const|let|var)\s+([A-Z][A-Z0-9_]*MODEL[A-Z0-9_]*)\s*=\s*\[([^\]]*['"][^\]]*)\]/g;

interface Finding {
  key: string;
  file: string;
  detail: string;
}

/** Strip line + block comments so comment mentions cannot false-positive. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
}

function scanModelConstArrays(files: string[], srcRoot: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    MODEL_CONST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODEL_CONST_RE.exec(src)) !== null) {
      const rel = relative(srcRoot, file).replaceAll('\\', '/');
      const key = `${rel}::${m[1]}`;
      if (!LEGACY_MODEL_CONST_ARRAYS.has(key)) {
        findings.push({ key, file: rel, detail: m[0].slice(0, 80) });
      }
    }
  }
  return findings;
}

function scanStaticModels(files: string[], srcRoot: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    if (STATIC_MODELS_RE.test(src)) {
      findings.push({
        key: relative(srcRoot, file).replaceAll('\\', '/'),
        file: relative(srcRoot, file).replaceAll('\\', '/'),
        detail: 'legacy staticModels array literal',
      });
    }
  }
  return findings;
}

// ─── Guard tests ──────────────────────────────────────────────────────────

describe('zero-hardcode guard: production model inventories', () => {
  const files = listProductionTsFiles(SRC_ROOT);

  it('production tree is non-trivial (scanner sanity)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no legacy staticModels array exists anywhere in production code', () => {
    const findings = scanStaticModels(files, SRC_ROOT);
    expect(findings).toEqual([]);
  });

  it('no new uppercase MODEL-array constants outside the dated allowlist', () => {
    const findings = scanModelConstArrays(files, SRC_ROOT);
    expect(findings).toEqual([]);
  });
});

describe('zero-hardcode guard: pinnedFallback closure', () => {
  const pinnedProviders = PROVIDER_CATALOG
    .filter((e) => {
      const pin = (e as { pinnedFallback?: { models?: readonly unknown[] } }).pinnedFallback;
      return pin && Array.isArray(pin.models) && pin.models.length > 0;
    })
    .map((e) => e.providerId);

  it('every pinned inventory provider is on the legacy allowlist (no silent additions)', () => {
    const unexpected = pinnedProviders.filter((id) => !LEGACY_PINNED_INVENTORY.has(id));
    expect(unexpected).toEqual([]);
  });

  it('the allowlist contains no stale entries (no silent removals)', () => {
    const stale = [...LEGACY_PINNED_INVENTORY].filter((id) => !pinnedProviders.includes(id));
    expect(stale).toEqual([]);
  });

  it('pinned providers are cross-classified in DISCOVERY_COMPLIANCE_REGISTRY buckets', () => {
    const registryClassified = new Set([
      ...DISCOVERY_COMPLIANCE_REGISTRY['pinnedFallback-by-design'],
      ...DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-hardcoded-inventory'],
      // deployment-scoped / seed pins legitimately live in these buckets
      ...DISCOVERY_COMPLIANCE_REGISTRY['compliant-deployment-discovery'],
      ...DISCOVERY_COMPLIANCE_REGISTRY['compliant-dynamic-discovery'],
      // execution-only pins awaiting runtime materialization (voyage,
      // replicate, azure-openai, databricks, qianfan) — tracked debt, not
      // silent hardcode. writer/atlascloud/avian left this bucket on
      // 2026-09-04 (LOTE AK) when their listing endpoints were proven live.
      ...DISCOVERY_COMPLIANCE_REGISTRY['non-compliant-runtime-not-materialized'],
    ]);
    const unclassified = pinnedProviders.filter((id) => !registryClassified.has(id));
    expect(unclassified).toEqual([]);
  });
});

// ─── Scanner self-tests (false-positive control + detection proof) ────────

describe('zero-hardcode guard: scanner self-tests', () => {
  it('detects a staticModels array in synthetic source', () => {
    expect(STATIC_MODELS_RE.test("staticModels: ['gpt-fake-1', 'gpt-fake-2']")).toBe(true);
    expect(STATIC_MODELS_RE.test('staticModels: [{ id: 1 }]')).toBe(true);
  });

  it('ignores empty staticModels (cannot carry inventory)', () => {
    expect(STATIC_MODELS_RE.test('staticModels: []')).toBe(false);
  });

  it('ignores staticModels mentions in comments/strings without arrays', () => {
    expect(STATIC_MODELS_RE.test('// staticModels was removed 2026-04-28')).toBe(false);
  });

  it('detects uppercase MODEL-array consts with string literals', () => {
    const src = "const KNOWN_MODELS = ['model-a', 'model-b'] as const;";
    MODEL_CONST_RE.lastIndex = 0;
    expect(MODEL_CONST_RE.test(src)).toBe(true);
  });

  it('ignores MODEL consts without string literals (numbers/enums only)', () => {
    const src = 'const MODEL_LIMIT_MAX = [1, 2, 4];';
    MODEL_CONST_RE.lastIndex = 0;
    expect(MODEL_CONST_RE.test(src)).toBe(false);
  });

  it('ignores lowercase model variables and non-const fields', () => {
    const src = "const models = response.data.map((m) => m.id);";
    MODEL_CONST_RE.lastIndex = 0;
    expect(MODEL_CONST_RE.test(src)).toBe(false);
  });

  it('ignores documentation strings mentioning model lists', () => {
    const src = "// the docs list SUPPORTED_MODELS at https://example.com";
    MODEL_CONST_RE.lastIndex = 0;
    expect(MODEL_CONST_RE.test(src)).toBe(false);
  });
});
