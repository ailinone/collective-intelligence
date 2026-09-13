// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Structural contract for the long-context delegation call-site wiring
 * (2026-09 follow-up to LOTE AW / the pickDelegationModel dead-code audit).
 *
 * Root cause this locks: `buildContext()`'s session-affinity-pin-reuse
 * branch used to gate BOTH resolving the pin AND calling
 * `applyLongContextHandling()` on `passesContextWindow` (i.e.
 * `contextSize < pinnedModel.contextWindow`). But
 * `applyLongContextHandling()`'s own delegation step
 * (`pickDelegationModel()`) only fires when the request does NOT fit —
 * `contextSize > resolved.model.contextWindow`, checked AFTER compaction,
 * which only ever shrinks `contextSize`. Those two conditions are mutually
 * exclusive: gating entry on "fits" made the "doesn't fit" recovery path
 * unreachable from any real request, confirmed by `git grep
 * pickDelegationModel` finding no production call site.
 *
 * A full behavioral proof of this wiring needs `buildContext()` itself,
 * which needs Prisma (`getChatEligibleModels`) + Redis
 * (`SessionAffinityService`) + the provider registry + half a dozen other
 * services via DI — out of scope for this hermetic suite (same reasoning as
 * `preferred-model-honor-wiring.test.ts` and
 * `streaming-media-gate-modality-structural.test.ts`). Two other suites
 * cover the parts that ARE hermetically testable end to end:
 *   - `session-affinity-pin-admission.test.ts`: the REAL admission decision
 *     (`evaluateSessionAffinityPinAdmission`), proving it admits an
 *     over-budget pin instead of rejecting it.
 *   - `context-compaction-delegation-wiring.test.ts`: the REAL
 *     `applyLongContextHandling()` (ContextCompactionService +
 *     pickDelegationModel), proving delegation actually fires and its
 *     result is used.
 * This file is the missing third link: it proves those two real pieces are
 * actually WIRED TOGETHER in the source — the exact gap that let the old
 * mutually-exclusive-conditions bug ship with 100% green tests on both
 * pieces in isolation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_PATH = join(__dirname, '..', 'orchestration-engine.ts');
const engineSource = readFileSync(ENGINE_PATH, 'utf8');

describe('buildContext() long-context admission gate — structural wiring', () => {
  it('REGRESSION GUARD: the pin-reuse branch is no longer gated on the exact old mutually-exclusive condition', () => {
    // The precise pre-fix shape. If this text reappears, the entry gate has
    // regressed back to requiring "fits" to even attempt long-context
    // handling, silently making pickDelegationModel() dead again.
    expect(engineSource).not.toMatch(
      /if\s*\(\s*pinnedModel\s*&&\s*passesContextWindow\s*&&\s*passesCredit\s*\)/
    );
  });

  it('the pin-reuse branch gates on the pure admission verdict, not on passesContextWindow', () => {
    expect(engineSource).toMatch(/if\s*\(\s*pinnedModel\s*&&\s*admission\.admit\s*\)/);
  });

  it('admission is computed via the real, separately-tested evaluateSessionAffinityPinAdmission()', () => {
    expect(engineSource).toMatch(
      /const\s+admission\s*=\s*evaluateSessionAffinityPinAdmission\(\{/
    );
  });

  it('applyLongContextHandling() is called INSIDE the admission.admit branch, not re-gated on passesContextWindow', () => {
    const branchStart = engineSource.indexOf('if (pinnedModel && admission.admit) {');
    const branchEnd = engineSource.indexOf('} else if (pinnedModel) {', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branchBody = engineSource.slice(branchStart, branchEnd);

    expect(branchBody).toMatch(/contextSize\s*=\s*await\s+this\.applyLongContextHandling\(\{/);
    // The call itself must not be wrapped in its own passesContextWindow
    // check — it should run unconditionally within the admitted branch (see
    // applyLongContextHandling's own shouldCompact() gate for why that's
    // safe: it no-ops when nothing needs to happen).
    const callIdx = branchBody.indexOf('this.applyLongContextHandling({');
    const precedingCode = branchBody.slice(0, callIdx);
    // The only `if` allowed between the branch start and the call is the
    // `if (resolved) {` null-check — no `if (passesContextWindow` anywhere.
    expect(precedingCode).not.toMatch(/if\s*\([^)]*passesContextWindow/);
  });

  it('a final fit re-check (via the shared modelFitsContext()) drops the pin when compaction+delegation still do not fit', () => {
    const branchStart = engineSource.indexOf('if (pinnedModel && admission.admit) {');
    const branchEnd = engineSource.indexOf('} else if (pinnedModel) {', branchStart);
    const branchBody = engineSource.slice(branchStart, branchEnd);

    const fitCheckIdx = branchBody.search(
      /if\s*\(\s*!modelFitsContext\(\s*context\.precomputedModelSelection\?\.model,\s*contextSize\s*\)\s*\)/
    );
    const applyCallIdx = branchBody.indexOf('this.applyLongContextHandling({');
    expect(fitCheckIdx).toBeGreaterThan(-1);
    // The re-check must come AFTER the long-context handling call (it needs
    // the post-compaction/delegation state), not before it.
    expect(fitCheckIdx).toBeGreaterThan(applyCallIdx);

    const afterFitCheck = branchBody.slice(fitCheckIdx);
    expect(afterFitCheck).toMatch(/context\.precomputedModelSelection\s*=\s*undefined/);
    expect(afterFitCheck).toMatch(/context\.preferredModelIds\s*=\s*undefined/);
  });

  it('evaluateSessionAffinityPinAdmission and modelFitsContext are exported (unit-testable without booting the engine)', () => {
    expect(engineSource).toMatch(/export function modelFitsContext\(/);
    expect(engineSource).toMatch(/export function evaluateSessionAffinityPinAdmission\(/);
  });
});
