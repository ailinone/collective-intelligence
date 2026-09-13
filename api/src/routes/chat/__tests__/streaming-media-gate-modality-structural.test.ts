// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Streaming media-generation redirect gate — structural contract (2026-09-07).
 *
 * ROOT CAUSE this closes: `handleStreamingRequest` (chat-routes.ts) has a
 * single gate that redirects a `stream:true` request with generation intent
 * to the non-streaming pipeline (the only place a real image/video/audio/file
 * artifact is ever produced — see executeMediaGenerationStage, wired
 * exclusively into OrchestrationEngine.execute(), never into executeStream()).
 * Before this fix, that gate only fired for FILE modality
 * (`detectMediaGenerationModality(...) === 'file'`) — an image/video/audio
 * generation request sent via the default streaming chat UI fell all the way
 * through to the plain single-model chat fast path
 * (createStreamingPlan, requiredCapabilities: ['streaming'] only, zero
 * awareness of media intent), which asked an arbitrary chat model to answer
 * a request like "generate an image of a red bicycle" — producing a short
 * hallucinated non-answer ("Ball"/"B"-style garbage) instead of ever
 * attempting real generation.
 *
 * Deliberately a SOURCE-TEXT (readFileSync) contract, mirroring
 * chat-routes-pin-wiring.test.ts's rationale, for two independent reasons:
 *
 *   1. A real end-to-end exercise of this path needs a full Fastify + Prisma
 *      + provider-registry + orchestration stack — out of scope for a unit
 *      test (same reasoning as the pin-wiring suite).
 *   2. Actually IMPORTING chat-routes.ts pulls in its full module graph,
 *      including every provider adapter (anthropic, openai, ...) — see the
 *      sibling `streaming-media-gate-modality-behavioral.test.ts` for the
 *      real, imported-function coverage of the same decision. Keeping this
 *      file import-free means it stays green even in a dev sandbox with a
 *      stale/incomplete node_modules (observed here: a missing
 *      `.pnpm/@anthropic-ai+sdk@...` breaks module import of chat-routes.ts
 *      for EVERY test file that imports it, pre-existing and unrelated to
 *      this change — reproduces identically on the untouched
 *      `streaming-media-gate-text-extraction.test.ts`).
 *
 * This is what actually fails on unmodified main: the source there reads
 * `detectMediaGenerationModality(...) === 'file'`, so every assertion below
 * about a widened/non-'file'-only condition fails against it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_PATH = join(__dirname, '..', 'chat-routes.ts');
const routesSource = readFileSync(ROUTES_PATH, 'utf8');

describe('structural contract — handleStreamingRequest media-generation gate', () => {
  it('does NOT gate the streaming redirect on file-modality alone', () => {
    // The exact pre-fix condition. If this reappears, image/video/audio
    // requests silently lose their redirect again.
    expect(routesSource).not.toMatch(
      /detectMediaGenerationModality\([^)]*\)\s*===\s*['"]file['"]/
    );
  });

  it('gates the streaming redirect on ANY detected modality, not just one', () => {
    // The fixed shape: redirect whenever detectStreamingMediaGateModality
    // returns non-null (image, video, audio, OR file), not a single
    // hardcoded modality string.
    expect(routesSource).toMatch(
      /const\s+mediaGateModality\s*=\s*detectStreamingMediaGateModality\(chatRequest\)/
    );
    expect(routesSource).toMatch(/if\s*\(\s*mediaGateModality\s*!==\s*null\s*\)/);
  });

  it('detectStreamingMediaGateModality itself is not narrowed to a single modality', () => {
    // Guards the extracted decision function too — a future edit could
    // "simplify" its body back to a single-modality check without touching
    // the call site at all.
    const fnMatch = routesSource.match(
      /export function detectStreamingMediaGateModality[\s\S]*?\n\}/
    );
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch ? fnMatch[0] : '';
    expect(fnBody).not.toMatch(/===\s*['"](file|image|video|audio)['"]/);
    expect(fnBody).toMatch(/return\s+detectMediaGenerationModality\(/);
  });

  it('the modality gate runs BEFORE createStreamingPlan (no wasted streaming-only model selection)', () => {
    const gateIndex = routesSource.indexOf(
      'const mediaGateModality = detectStreamingMediaGateModality(chatRequest)'
    );
    const streamingPlanIndex = routesSource.indexOf('orchestrationEngine.createStreamingPlan(');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(streamingPlanIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(streamingPlanIndex);
  });

  it('the gate block still unconditionally returns, so a redirected request never falls through', () => {
    const gateIndex = routesSource.indexOf('if (mediaGateModality !== null) {');
    expect(gateIndex).toBeGreaterThan(-1);
    // The redirect branch's closing `return;` must appear before the next
    // top-level section comment ("Track all attempts"), i.e. still inside
    // the same guarded block, not moved out or made conditional.
    const afterGate = routesSource.slice(gateIndex);
    const returnIndex = afterGate.indexOf('return;');
    const nextSectionIndex = afterGate.indexOf('// Track all attempts');
    expect(returnIndex).toBeGreaterThan(-1);
    expect(nextSectionIndex).toBeGreaterThan(-1);
    expect(returnIndex).toBeLessThan(nextSectionIndex);
  });

  it('disableVideoEarlyPath stays unconditionally true on the redirect (unchanged mechanic, shared by all 4 modalities)', () => {
    // The redirect still forces the legacy detectVideoGenerationIntent early
    // path off unconditionally, so a widened gate does not reintroduce the
    // 2026-07-17 defect (a mixed file+video message double-firing generation).
    expect(routesSource).toMatch(/disableVideoEarlyPath:\s*true/);
  });
});
