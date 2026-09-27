<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MediaPlanner — Correct the Stale `music_generation` Narrative (Section F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the factually-stale "no `music_generation` capability exists" narrative from the one test fixture that still asserts it, without inventing doc-edit work that this investigation found isn't needed.

**Architecture:** No production code changes. This is a single test-fixture edit: replace a real, now-wired capability (`music_generation`) with an explicitly fictional one in a mocked-LLM test response, so the test keeps verifying "the strategy propagates whatever `unmetConstraints` the planner returns" without asserting a real capability gap that has since closed.

**Tech Stack:** Vitest, TypeScript.

---

## Investigation findings (done as part of writing this plan, not deferred to execution)

**1. Exact test location.** The real path (the spec's citation omits the `__tests__` directory) is:
`api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`

The stale narrative appears at:
- Line 113: `describe('MediaPlannerStrategy — happy path (30s/4K/audio+soundtrack example)', ...)` — fine, no factual claim, not touched.
- Line 114: `it('generates via MediaConsensusExecutor, then reports an unmet soundtrack constraint (no music_generation capability)', ...)` — false claim in the title.
- Line 130: comment `// Turn 1: no music_generation capability exists — final with unmetConstraints.` — false claim.
- Line 135: mocked LLM response `unmetConstraints: ['musical soundtrack — no music_generation capability exists']` — false claim.
- Lines 174–176: the assertion re-asserting that same string.

(The spec's approximate citation `130-135,174-175` is accurate to within a line or two — confirmed by reading the file directly.)

**2. Is `music_generation` actually wired now?** Yes, confirmed live, not a stub:
- `api/src/core/capabilities/capability-ontology.ts:372` registers `music_generation` as a real capability id (aliases `music`, `soundtrack_generation`, etc.), added "LOTE AX (2026-09-06), ElevenLabs Music onboarding."
- `api/src/services/music-orchestration-service.ts` is a full `MusicOrchestrationService` class (dynamic provider/model routing, no hardcoded models), not a placeholder.
- `api/src/routes/capabilities/capabilities-routes.ts:883-900` dispatches the `music_generation` capability to `services.music.generateMusic(...)`, and `services.music` is a real `MusicOrchestrationService` instance constructed at `capabilities-routes.ts:1727`.
- The ElevenLabs adapter implements `generateMusic` (backed by `POST /v1/music`); `api/src/providers/catalog/consolidation-matrix.ts:214` records a live probe against the real ElevenLabs key reaching the vendor (blocked only by the account's free-tier plan, a billing gate, not a code defect).
- `api/src/services/__tests__/music-orchestration-service.test.ts` and `api/src/providers/elevenlabs/__tests__/elevenlabs-adapter.test.ts` cover this path with passing unit tests.

So the spec's claim — that `MusicOrchestrationService` has existed and been fully wired since before this audit — is correct. The test fixture's "no `music_generation` capability exists" premise is genuinely false today.

**3. Does the stale narrative appear anywhere else in the repo (docs, ADRs, READMEs)?** No.
- Grepped `api/docs/adr/` for `music` / `soundtrack`: the only hit is `ADR-027-sab-worker-candidate-index.md:162`, which lists `music_generation` purely as one of 32 example capability names in an unrelated bitmask-truncation test scenario ("distinct capability count exceeds the 32-bit bitmask width"). It says nothing about music generation being unsupported.
- `ADR-024-agentic-capability-execution.md` (the most plausible candidate per the spec) contains no mention of `music` or `soundtrack` at all.
- Grepped the whole worktree (`api/`, `docs/`, all `*.md`/`*.ts`) for `music_generation` combined with `soundtrack`/`gap`/`unmetConstraints`: the only files combining these terms are the design spec itself and the one test file above. No committed doc anywhere states or implies "no `music_generation` capability exists."
- **Conclusion: no doc-edit task is needed.** This plan contains only the test-fixture fix.

---

### Task 1: Replace the stale `music_generation`-gap narrative with an explicitly fictional capability

**Files:**
- Modify: `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts:114,130,135,174-176`

This is a fixture-accuracy fix, not a new-behavior change: the test's real assertion is "the strategy correctly surfaces whatever `unmetConstraints` the mocked planner LLM returns" — it never actually checks real capability availability (the LLM response is fully mocked). Only the cover story is wrong. There is no red/green TDD cycle here since no behavior changes; the steps below are edit → confirm still green → commit.

- [ ] **Step 1: Edit the test title, comment, and both string literals**

Before (lines 113–136):
```typescript
describe('MediaPlannerStrategy — happy path (30s/4K/audio+soundtrack example)', () => {
  it('generates via MediaConsensusExecutor, then reports an unmet soundtrack constraint (no music_generation capability)', async () => {
    const invokerChat = vi
      .fn()
      // Turn 0: decompose into a video-generation action with constraints.
      .mockResolvedValueOnce(
        chatJson({
          kind: 'generate',
          capability: 'video_generation',
          prompt: 'a 30 second 4k sunrise video with audio',
          constraints: {
            durationSec: { minSec: 30 },
            resolution: { width: 3840, height: 2160 },
            requireAudioTrack: true,
          },
        })
      )
      // Turn 1: no music_generation capability exists — final with unmetConstraints.
      .mockResolvedValueOnce(
        chatJson({
          kind: 'final',
          content: 'Here is your 30s 4K video. A musical soundtrack could not be added.',
          unmetConstraints: ['musical soundtrack — no music_generation capability exists'],
        })
      );
```

After:
```typescript
describe('MediaPlannerStrategy — happy path (30s/4K/audio+soundtrack example)', () => {
  it('generates via MediaConsensusExecutor, then reports whatever unmet constraint the planner LLM returns', async () => {
    const invokerChat = vi
      .fn()
      // Turn 0: decompose into a video-generation action with constraints.
      .mockResolvedValueOnce(
        chatJson({
          kind: 'generate',
          capability: 'video_generation',
          prompt: 'a 30 second 4k sunrise video with audio',
          constraints: {
            durationSec: { minSec: 30 },
            resolution: { width: 3840, height: 2160 },
            requireAudioTrack: true,
          },
        })
      )
      // Turn 1: the mocked planner LLM reports an unmet constraint. The
      // capability name below ("holographic_soundtrack_generation") is
      // deliberately fictional and must never be added to
      // `capability-ontology.ts` for real — this test only verifies that
      // MediaPlannerStrategy propagates whatever `unmetConstraints` the
      // planner returns, not that any specific capability is unavailable.
      // (Previously this used `music_generation`, which was accurate when
      // written but has been a real, fully wired capability — see
      // `music-orchestration-service.ts` and the ElevenLabs adapter's
      // `generateMusic` — since LOTE AX (2026-09-06); using a real
      // capability name here made the test's premise go stale once that
      // capability shipped.)
      .mockResolvedValueOnce(
        chatJson({
          kind: 'final',
          content: 'Here is your 30s 4K video. A musical soundtrack could not be added.',
          unmetConstraints: [
            'musical soundtrack — no holographic_soundtrack_generation capability exists',
          ],
        })
      );
```

- [ ] **Step 2: Update the matching assertion**

Before (lines 174–176):
```typescript
    expect(result.metadata.unmetConstraints).toEqual([
      'musical soundtrack — no music_generation capability exists',
    ]);
```

After:
```typescript
    expect(result.metadata.unmetConstraints).toEqual([
      'musical soundtrack — no holographic_soundtrack_generation capability exists',
    ]);
```

- [ ] **Step 3: Run the test to confirm it still passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`
Expected: PASS (2 tests in this file — the happy-path test and the "rejects a final action missing unmetConstraints" test — both green; this change only touches fixture text and a matching assertion, no strategy behavior changed).

- [ ] **Step 4: Commit**

```bash
git add api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts
git commit -m "test(media-planner): stop asserting a fictional music_generation gap

music_generation has been a real, fully wired capability since LOTE AX
(2026-09-06) — MusicOrchestrationService + the ElevenLabs adapter's
generateMusic are live. Swap the test fixture to an explicitly
fictional capability name so the test keeps verifying unmetConstraints
propagation without depending on a capability staying unimplemented.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Out of scope / no-op findings

- **No ADR or doc edit.** Investigated and confirmed: no file under `api/docs/adr/` (including `ADR-024-agentic-capability-execution.md`) or elsewhere in the repo's `docs/` contains the "no `music_generation` capability" narrative. `ADR-027-sab-worker-candidate-index.md`'s mention of `music_generation` is an unrelated example in a bitmask-truncation list. Nothing in this repo needs a doc update for Section F.
- If the stale narrative lives in the *original architecture-proposal document* (outside this repo, wherever that proposal is published/stored), that is outside this plan's scope per the spec's own instruction — flag it to the user separately rather than searching further inside the repo.
