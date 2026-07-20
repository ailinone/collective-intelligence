// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 6 Fix 1 — route-layer guard for the pin-propagation pipe.
 *
 * Why this test exists
 * ────────────────────
 * The 2026-04-30 production probe (api/docs/phase-6-runtime-evidence-2026-04-30.md
 * §4) found that a `POST /v1/chat/completions` with `model: 'openai/gpt-4o-mini'`
 * was silently routed to `openrouter/bodybuilder`. The dossier ascribed the
 * cause to the engine→strategy hop, but follow-up investigation showed that
 * hop is locked tight by `preferred-model-honor-{wiring,coverage}.test.ts`.
 * The actually-unprotected segment of the pipe was the **route layer** —
 * `normalizeChatRequest` in `chat-routes.ts:356-419` — which derives the
 * `user_specified_model` flag the engine then reads via
 * `getUserSpecifiedModelFlag(request)`.
 *
 * The flag-derivation contract has three branches that must all stay wired:
 *
 *   1. **Pre-set flag short-circuit** — if the caller (e.g. an upstream
 *      proxy or the eval harness) already set `user_specified_model`, we
 *      MUST respect it. This is what `'user_specified_model' in chatRequest`
 *      guards. Drop this and explicit `false` flags get overwritten by the
 *      inference path on the next line.
 *
 *   2. **Alias-resolution carve-out** — when the request comes in as e.g.
 *      `model: 'ailin-fast'` and `resolveAilinVirtualModelAlias` rewrites
 *      it to `openai/gpt-4o-mini` on `normalizedRequest.model`, the rewritten
 *      request looks identical to a user pin. Only `user_specified_model = false`
 *      tells the engine "the user did NOT pick this model — keep dynamic
 *      selection on." Drop this branch and every alias becomes a hard pin,
 *      defeating the whole virtual-alias system.
 *
 *   3. **Inference fallback** — `modelProvided && !explicitlyAuto`. The
 *      AND of two conditions is the load-bearing detail: if a refactor
 *      simplifies this to just `modelProvided`, then `model: 'auto'` requests
 *      get classified as user pins, the engine captures `'auto'` into
 *      `preferredModelFromRequest`, and HybridStrategy ends up trying to
 *      route to a non-existent `'auto'` model.
 *
 * Why a string-grep test (mirrors preferred-model-honor-wiring.test.ts)
 * ────────────────────────────────────────────────────────────────────
 * The classic regression mode is silent — a "tidy up the conditional"
 * refactor doesn't crash and doesn't fail any existing test, it just
 * silently flips the flag default for one edge class. Locking the
 * textual references is the only structural way to detect deletion.
 * Spinning up the full Fastify route to test the path requires Prisma +
 * pg + provider registry + the strategy DAG — that's the scope of an
 * integration test, not a contract guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_PATH = join(__dirname, '..', 'chat-routes.ts');
const ENGINE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'core',
  'orchestration',
  'orchestration-engine.ts',
);

const routesSource = readFileSync(ROUTES_PATH, 'utf8');
const engineSource = readFileSync(ENGINE_PATH, 'utf8');

describe('Phase 6 Fix 1 — chat-routes pin-extraction wiring contract', () => {
  // ────────────────────────────────────────────────────────────────────
  // The function exists and is positioned to be called before the
  // request reaches the orchestration engine.
  // ────────────────────────────────────────────────────────────────────

  it('normalizeChatRequest is defined as a top-level normalizer', () => {
    // Signature lock — if someone renames/extracts it without updating
    // call sites, the function disappears from the source surface and
    // this test fires before the runtime breakage.
    expect(routesSource).toMatch(/function\s+normalizeChatRequest\s*\(/);
  });

  it('normalizeChatRequest invokes resolveAilinVirtualModelAlias on the model field', () => {
    // The alias system is the ENTRY POINT for virtual aliases like
    // ailin-fast/ailin-quality. Without this call, every alias request
    // arrives at the engine with a fake model id and gets pinned by the
    // inference fallback — defeating the alias-routing feature entirely.
    expect(routesSource).toMatch(
      /const\s+aliasResolution\s*=\s*resolveAilinVirtualModelAlias\s*\(\s*modelValue\s*\)/,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Branch 1 — pre-set flag short-circuit
  // ────────────────────────────────────────────────────────────────────

  it('respects an upstream-set user_specified_model flag (via hasUserFlag short-circuit)', () => {
    // The `else if (!hasUserFlag)` guard is what protects an explicit
    // `user_specified_model: false` (or `true`) from being overwritten
    // by the inference fallback below. Without it, a CLI that sends
    // `{ model: 'gpt-4', user_specified_model: false }` (because the
    // model came from system policy, not the user) gets silently
    // re-pinned.
    expect(routesSource).toMatch(
      /const\s+hasUserFlag\s*=\s*['"]user_specified_model['"]\s+in\s+chatRequest/,
    );
    expect(routesSource).toMatch(/else\s+if\s*\(\s*!hasUserFlag\s*\)/);
  });

  // ────────────────────────────────────────────────────────────────────
  // Branch 2 — alias-resolution carve-out
  // ────────────────────────────────────────────────────────────────────

  it('forces user_specified_model=false when an alias was resolved', () => {
    // The MOST critical branch: alias rewriting transforms the model
    // string from `'ailin-fast'` to a real provider/model id. Once the
    // rewrite happens, the request is structurally indistinguishable
    // from a user pin. Only this explicit `= false` assignment tells
    // the engine to keep DynamicModelSelector active rather than
    // hard-pinning the alias resolution.
    expect(routesSource).toMatch(
      /if\s*\(\s*aliasResolution\s*\)\s*\{[\s\S]{0,120}?normalizedRequest\.user_specified_model\s*=\s*false/,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Branch 3 — inference fallback (modelProvided && !explicitlyAuto)
  // ────────────────────────────────────────────────────────────────────

  it('inference fallback uses modelProvided AND !explicitlyAuto (not modelProvided alone)', () => {
    // The AND is the load-bearing detail. Dropping `!explicitlyAuto`
    // would classify `model: 'auto'` as a user pin, the engine would
    // capture `'auto'` into preferredModelFromRequest, and the strategy
    // would attempt to route to a non-existent model. The opposite
    // direction (dropping `modelProvided`) would also break: empty
    // string would suddenly become "user-pinned to ''".
    expect(routesSource).toMatch(
      /normalizedRequest\.user_specified_model\s*=\s*modelProvided\s*&&\s*!explicitlyAuto/,
    );
  });

  it('explicitlyAuto includes BOTH the literal "auto" string AND any alias resolution', () => {
    // `explicitlyAuto` is what `!explicitlyAuto` checks against above.
    // It MUST match BOTH conditions or the inference path leaks:
    //   - `'auto'` literal → otherwise users that pass `model: 'auto'`
    //     get pinned to the literal string 'auto'
    //   - alias resolution non-null → otherwise an alias-resolved
    //     request would be pinned by the inference fallback BEFORE the
    //     branch-2 carve-out gets to run (the order matters because
    //     branch-2 runs in `if (aliasResolution)` while branch-3 runs
    //     in `else if (!hasUserFlag)` — disjoint branches).
    expect(routesSource).toMatch(
      /const\s+explicitlyAuto\s*=\s*modelValue\.toLowerCase\(\)\s*===\s*['"]auto['"]\s*\|\|\s*aliasResolution\s*!==\s*null/,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-layer linkage: the engine MUST read the same field name the
  // route sets. If anyone renames the flag in one place but not the
  // other, the pin pipe silently breaks.
  // ────────────────────────────────────────────────────────────────────

  it('orchestration engine reads the user_specified_model flag set by the route', () => {
    // The contract is a string-named field. Both ends MUST agree on
    // the spelling. The route sets `user_specified_model` (snake_case)
    // and the engine reads it via the typed helper getUserSpecifiedModelFlag.
    // Any drift here breaks the pipe silently.
    expect(engineSource).toMatch(/getUserSpecifiedModelFlag\s*\(\s*request\s*\)/);
  });

  it('orchestration engine references the user_specified_model field name (snake_case spelling)', () => {
    // Belt-and-suspenders: the type helper is one indirection away from
    // the raw field. This assertion confirms the field name itself
    // appears somewhere in the engine — catches refactors that split
    // the helper out into a different module without updating BOTH
    // sides of the import path. The match is kept loose (a comment, a
    // type read, or a key access all count) because the goal is just
    // "the engine still mentions this contract by name."
    expect(engineSource).toMatch(/user_specified_model/);
  });
});

describe('Security — ailin_billing precedence contract', () => {
  // ────────────────────────────────────────────────────────────────────
  // The billing profile (markup multipliers, flat fees, minimum/maximum
  // charge) is a SERVER revenue policy keyed off the resolved alias. A
  // client must NOT be able to send `ailin_billing: { enabled: false }`
  // (or lowered multipliers/fees) to zero out / reduce the platform markup
  // it should be charged — `applyBillingProfile()` short-circuits on
  // `enabled === false` and returns the raw provider cost.
  //
  // Regression mode is silent: the old code only applied the alias profile
  // when `normalizedRequest.ailin_billing === undefined`, so any client
  // value silently won. We grep the source to lock the authoritative
  // behaviour because exercising the runtime path requires the full
  // Fastify + Prisma + provider-registry stack (integration scope).
  // ────────────────────────────────────────────────────────────────────

  it('does NOT gate the alias billing profile on a client-undefined check', () => {
    // The vulnerable form was:
    //   if (aliasResolution?.billing && normalizedRequest.ailin_billing === undefined)
    // which let a client-supplied ailin_billing take precedence. That exact
    // conjunction must not reappear.
    expect(routesSource).not.toMatch(
      /aliasResolution\?\.billing\s*&&\s*normalizedRequest\.ailin_billing\s*===\s*undefined/,
    );
  });

  it('applies the alias billing profile authoritatively (alias profile always wins)', () => {
    // When the alias carries a billing profile it is assigned unconditionally
    // — no client-value guard.
    expect(routesSource).toMatch(
      /if\s*\(\s*aliasResolution\?\.billing\s*\)\s*\{[\s\S]{0,160}?normalizedRequest\.ailin_billing\s*=\s*aliasResolution\.billing/,
    );
  });

  it('strips any client-supplied ailin_billing when the alias has no billing profile', () => {
    // A client cannot inject a more-favorable profile when none was
    // server-configured; the client value is deleted.
    expect(routesSource).toMatch(/delete\s+normalizedRequest\.ailin_billing/);
  });
});
