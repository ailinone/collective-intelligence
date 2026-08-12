// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The prepaid wallet gate is deliberately EXCLUDED from the shared
 * orchestration gate, and this test is the mechanical enforcement of that.
 *
 * Why it matters: `PREPAID_WALLET_GATE_ENABLED` is a known landmine on exactly
 * the routes the shared gate is wired into. `normalizeChatRequest` rewrites
 * every `ailin-*` alias to the literal model `'auto'`, and `resolveTier` reads
 * `req.model` FIRST (`prepaid-wallet-gate.ts:56-58`), so `'auto'` resolves to a
 * real chargeable pricing cell. Org wallets are $0 with no top-up path
 * (the payments service is not deployed). The alias-pricing fix merged
 * separately (#266); spreading the wallet gate to more routes is still its own
 * decision, not a side effect of this one. Doing it here would multiply the
 * blast radius from one route to four.
 *
 * The primary barrier is structural: `OrchestrationGateInput` carries no
 * `messages`, no `max_tokens`, no `ailin_alias` and no `ChatRequest`, so
 * `gateChatRequest` and `gateTierRequest` cannot be called from inside the
 * helper without a type error. This test is the second barrier — it fails
 * loudly if a future change "helpfully" widens the input type and adds the
 * import.
 *
 * There is a third, independent blocker worth knowing about: 429 (quota) and
 * 403 (governance) are already declared on these routes in `openapi-spec.json`,
 * but 402 — which `prepaid-wallet-gate.ts:122-134` returns — is declared on
 * none of them, so adding the wallet here would also trip the OpenAPI contract
 * workflow.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const GATE_SOURCE = readFileSync(path.resolve(__dirname, '../orchestration-gate.ts'), 'utf8');

/** Strip block and line comments so the file's own prose about the wallet doesn't trip the assertions. */
const GATE_CODE = GATE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function loadCode(relFromSrc: string): string {
  return readFileSync(path.resolve(__dirname, '../..', relFromSrc), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const CHAT_ROUTES_CODE = loadCode('routes/chat/chat-routes.ts');

describe('orchestration gate — wallet exclusion', () => {
  it('imports no prepaid-wallet module', () => {
    expect(GATE_CODE).not.toContain('prepaid-wallet-gate');
    expect(GATE_CODE).not.toContain('prepaid-wallet');
  });

  it('imports no pricing-tier module', () => {
    expect(GATE_CODE).not.toContain('pricing-tier-billing');
    expect(GATE_CODE).not.toContain('pricing-tiers');
  });

  it('calls neither wallet nor tier gate', () => {
    expect(GATE_CODE).not.toContain('gateChatRequest');
    expect(GATE_CODE).not.toContain('gateTierRequest');
    expect(GATE_CODE).not.toContain('debitChatRequest');
  });

  it('imports exactly the two intended gate services', () => {
    const gateImports = [...GATE_CODE.matchAll(/from '(@\/services\/[^']+)'/g)].map((m) => m[1]);
    expect(gateImports.sort()).toEqual([
      '@/services/org-governance-service',
      '@/services/org-governance-service',
      '@/services/quota-service',
      '@/services/security-audit-service',
    ]);
  });

  it('never returns 402 — the wallet status code', () => {
    expect(GATE_CODE).not.toContain('402');
  });

  it('is check-only: it records no usage', () => {
    // Recording stays at the single `trackChatUsage` chokepoint. If the gate
    // recorded too, the routes that already call trackChatUsage would
    // double-debit and double-increment the quota counter.
    expect(GATE_CODE).not.toContain('trackChatUsage');
    expect(GATE_CODE).not.toContain('recordQuotaUsage');
    expect(GATE_CODE).not.toContain('recordUsageEvents');
    expect(GATE_CODE).not.toContain('billing-usage-tracker');
  });

  it('never touches the Fastify reply', () => {
    expect(GATE_CODE).not.toMatch(/\breply\b/);
  });
});

/**
 * The barrier above only reads `orchestration-gate.ts`, and that is a real
 * limitation: the gate was excluded from the wallet, but a ROUTE can add wallet
 * exposure the gate file cannot see. `trackChatUsage` calls `debitChatRequest`
 * inside its `Promise.all`, so every new `trackChatUsage` call site is also a
 * new wallet debit site.
 *
 * WHY THIS BLOCK LOOKS DIFFERENT FROM THE ONE IT REPLACED — read before editing.
 * The previous version sliced `chat-routes.ts` with a pair of `indexOf` calls
 * anchored on two endpoint string literals, to isolate one handler. #271 deleted
 * both of those handlers, so both anchors returned -1 and the slice degraded to
 * `slice(-1)` (the file's LAST CHARACTER) or `slice(-1, -1)` (the EMPTY STRING).
 * Against an empty haystack every `not.toContain` assertion passes — the block
 * kept reporting green while checking nothing at all.
 *
 * So this version does two things differently, and both are deliberate:
 *   1. NO SLICING. Each route file is read whole. There is no anchor that can go
 *      stale and silently shrink the haystack.
 *   2. EVERY negative assertion is paired with a POSITIVE anchor on the same
 *      string. A negative assertion alone cannot distinguish "the wallet is
 *      absent" from "the file is absent"; the positive anchor fails loudly in
 *      the second case, which is exactly the failure mode that got past the old
 *      block.
 */
const GATED_ROUTE_FILES: ReadonlyArray<{ file: string; endpoint: string }> = [
  { file: 'routes/responses/responses-routes.ts', endpoint: "'/v1/responses'" },
  {
    file: 'routes/extended-thinking/extended-thinking-routes.ts',
    endpoint: "'/v1/chat/completions/extended-thinking'",
  },
];

describe('gated routes — wallet exposure', () => {
  it.each(GATED_ROUTE_FILES)('$file is really the gated file it claims to be', ({ file, endpoint }) => {
    const code = loadCode(file);
    // POSITIVE ANCHORS FIRST. If the file moved, was renamed, or failed to load,
    // these fail — so the negative assertions below can never pass vacuously.
    expect(code.length).toBeGreaterThan(1000);
    expect(code).toContain('evaluateOrchestrationGate');
    expect(code).toContain(endpoint);
  });

  it.each(GATED_ROUTE_FILES)('$file adds no wallet or pricing-tier call', ({ file }) => {
    const code = loadCode(file);
    // The gate is check-only and carries no ChatRequest, so it cannot reach the
    // wallet itself. This asserts the ROUTE did not acquire one alongside it.
    expect(code).not.toContain('gateChatRequest');
    expect(code).not.toContain('gateTierRequest');
    expect(code).not.toContain('debitChatRequest');
    expect(code).not.toContain('prepaid-wallet-gate');
    expect(code).not.toContain('pricing-tier-billing');
  });
});

/**
 * `/v1/chat/completions` is NOT wired to the shared gate and must stay that way
 * in this change: it already runs its own inline quota + governance block and is
 * the only route holding the prepaid wallet. Pinned because the tempting
 * "cleanup" during a later refactor is to route it through the shared helper,
 * which would silently drop its wallet reserve.
 */
describe('/v1/chat/completions — untouched by this change', () => {
  it('keeps its wallet gate and does not adopt the shared helper', () => {
    // Positive anchor: this is the flagship route file and it still holds the
    // one legitimate wallet call site.
    expect(CHAT_ROUTES_CODE).toContain('gateChatRequest');
    expect(CHAT_ROUTES_CODE).not.toContain('evaluateOrchestrationGate');
  });

  it('records streaming cost through exactly one trackChatUsage chokepoint', () => {
    // One call site on the single-streaming path. If a second appears, the
    // "one HTTP request, one usage row" property is at risk and the salvage
    // decision recorded in catalog-cost-estimate.ts needs revisiting.
    expect([...CHAT_ROUTES_CODE.matchAll(/trackChatUsage\(\{/g)].length).toBe(1);
  });
});

/**
 * THE SALVAGE, PINNED AS UNWIRED.
 *
 * `catalog-cost-estimate.ts` survived #271 but its two call sites did not. It is
 * kept because it fixes a real revenue under-report (`totalCostOverride: 0` on
 * the flagship streaming path) — but wiring it there is a BILLING change that
 * this PR is not allowed to make, because that number feeds
 * `recordQuotaUsage` -> `usage_quotas.costUsd` -> `checkQuota`, which
 * `/v1/chat/completions` enforces as a hard 429 with no feature flag.
 *
 * This pin fails the moment someone wires it, which is the point: the wiring is
 * fine, but only together with the flag and the pre-deploy quota analysis
 * described in `catalog-cost-estimate.ts`. See that file's header for the
 * follow-up.
 *
 * THIS BLOCK IS THE ONLY SAFEGUARD. Do not assume the orphan guard
 * (`scripts/check-orphans.mjs`, a Quality Gates step) is a second one — it is
 * not, in either direction:
 *
 *   - It cannot catch the module going dead, because it builds its reference
 *     haystack from ALL TS sources INCLUDING TESTS (`check-orphans.mjs:88-101`;
 *     `walkAll` skips only `node_modules`, `generated` and `dist`, unlike the
 *     `walk` that produces the candidate list). Scanning that haystack for the
 *     guard's needle today returns exactly two files, and BOTH are tests:
 *     `routes/chat/catalog-cost-estimate.test.ts` and this file. So a
 *     deliberately-unwired module with its own unit test passes the guard on
 *     its test alone — the guard would stay green even if every production
 *     reason to keep the module evaporated.
 *   - It cannot catch the module getting wired either; that is not what it
 *     checks. Only the assertions below do that.
 *
 * The irony is worth stating plainly so nobody "cleans it up": the test
 * asserting this module is UNUSED is itself one of the two references keeping
 * the orphan guard green for it. Deleting this block does not just remove the
 * pin — it also drops the module toward being reported as an orphan.
 */
describe('catalog-cost-estimate — deliberately unwired', () => {
  it('has no production call site yet', () => {
    // Positive anchor: the module exists and still exports the estimator.
    const estimator = loadCode('routes/chat/catalog-cost-estimate.ts');
    expect(estimator).toContain('export function estimateStreamCostUsd');

    // And chat-routes has not imported or called it.
    expect(CHAT_ROUTES_CODE).not.toContain('catalog-cost-estimate');
    expect(CHAT_ROUTES_CODE).not.toContain('estimateStreamCostUsd');
    expect(CHAT_ROUTES_CODE).toContain('totalCostOverride: 0');
  });
});
