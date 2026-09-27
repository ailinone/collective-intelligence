<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MediaPlanner — Image Editing with Verify (Section D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the planner a dedicated `edit` action kind for `image_editing` that a plain `capability_call` cannot provide today: a real deterministic dimension/format check on the edited output, a vision-judge before/after comparison confirming the edit instruction was actually followed, and a bounded (max 2 attempts) retry before giving up.

**Architecture:** Additive only, per the approved design's explicit rejection of generalizing `capability_call` (see spec "Out of scope"). A new `edit` action is added to `PlannerActionSchema` (`media-planner-types.ts`) alongside the existing `capability_call` / `generate` / `final` — none of those three are touched. `MediaPlannerStrategy` gets one new branch in its turn loop that: (1) resolves the image to edit from `PlannerState.artifacts`, (2) dispatches the actual provider call through the *existing, unmodified* `capabilityDispatcher` / `executeCapabilityByPlan` path already used for `capability_call` actions (targeting the already-registered `image_editing` capability — no new dispatch mechanism), (3) runs a new `image-deterministic-gate.ts` (mirrors `media-deterministic-gate.ts`, but probes real image bytes with the `image-size` library instead of shelling out to ffmpeg), (4) optionally runs a new before/after vision-judge comparison built on the existing `MediaJudgeEvaluator`/`buildMediaJudgeContent` machinery, and (5) retries the whole generate→gate→judge cycle up to 2 times before recording a clear failure in the turn transcript.

**Tech Stack:** TypeScript, Zod, Vitest, `image-size` (new, zero-dependency, CommonJS-compatible — see Task 3 for why `sharp` was rejected).

---

## Investigation findings (verified against the actual worktree before writing tasks below)

**1. `PlannerActionSchema` (`api/src/core/orchestration/strategies/media-planner-types.ts:152-156`) currently has exactly three members** — `capability_call` (line 123), `generate` (line 131), `final` (line 145) — confirmed by reading the file directly. The spec's claim holds.

**2. The dispatch loop is in `MediaPlannerStrategy.execute()`, `api/src/core/orchestration/strategies/media-planner-strategy.ts:268-447`.** The `if (action.kind === 'generate')` branch runs `305-378`; the `capability_call` fallthrough starts at `380`. The new `edit` branch is inserted between them (after `378`, before `380`) — additive, same pattern as the existing branches.

**3. `media-deterministic-gate.ts` is the correct shape to mirror** (`api/src/core/orchestration/strategies/media-deterministic-gate.ts`): a single exported async function (`runDeterministicMediaGate`), a `*ConstraintSet` input type, a `DeterministicGateResult` output type with a closed `status` union (`pass | fail | skipped_unavailable | skipped_no_bytes | skipped_no_constraints`), and a pure, separately-exported `evaluateConstraints()` helper for unit testing without mocking the probe. **Deviation from spec:** the spec describes this file as living at the same directory level, which is correct, but doesn't mention its test file's location — confirmed as a sibling file `media-deterministic-gate.test.ts` (NOT under `__tests__/`), which this plan mirrors for `image-deterministic-gate.test.ts`.

**4. No `sharp` or `image-size` dependency exists in this codebase today.** `sharp` appears twice in `api/package.json` but only inside `"pnpm".overrides` (`"sharp@<0.35.0": ">=0.35.0"`, `"sharp@<0.35.4": ">=0.35.4"`) — these are transitive-dependency security-patch pins, not a usable direct dependency; `sharp` does not appear in `dependencies` or `devDependencies`. No image-probing library exists anywhere in the tree. Task 3 adds one.

**5. `buildMediaJudgeContent` (`api/src/core/orchestration/strategies/evaluation/media-judge-evaluator.ts:233-266`) takes a single `MediaCandidateArtifact` + `sampledFrames: readonly string[]`** — it has no before/after concept, so it cannot be called unmodified with two images. Task 4 adds a sibling pure function, `buildImageEditJudgeContent`, in the same file, reusing the same header/content-part construction style and the same `MediaJudgeClient`/`MediaJudgeEvaluatorConfig` safety-gate machinery in `MediaJudgeEvaluator` (new method `evaluateImageEdit`, gates copied verbatim from `evaluateVisualMedia`, `media-judge-evaluator.ts:114-131`).

**6. `MediaConsensusStrategy` (`api/src/core/orchestration/strategies/media-consensus-strategy.ts`) does NOT contain a sequential "retry on gate failure" loop.** This is a correction to the spec's Task D.5 wording ("mirrors the retry-on-gate-fail pattern already used in `MediaConsensusStrategy`"). What that file actually does (`execute()`, lines 189-257) is generate **N candidates in parallel up front** (`Promise.all`, line 214-216), gate+judge each independently (`evaluateCandidate`, lines 316-398), filter out gate/judge failures as outliers (line 231), and pick the best survivor — or return `degraded: true` with `degradedReason: 'all_candidates_outliers'` if every candidate failed (lines 232-256). There is no re-generation of a failed candidate anywhere in that file. A real grep across `api/src/core/orchestration/strategies/*.ts` for retry loops found sequential-retry patterns only in `hybrid-strategy.ts` (`executeModelWithRetry`) and `parallel-strategy.ts` (retry fan-out once with a fresh model set on failure) — neither is the media-generation path.
   The pattern this plan actually mirrors for the **sequential, bounded, degrade-with-a-clear-reason** shape is `MediaPlannerStrategy`'s own outer turn loop (`media-planner-strategy.ts:268-457`): a bounded `for` loop that keeps trying, and on exhaustion appends a plain-language reason instead of throwing (`449-457`). Task 5 below implements a small inner version of that same shape (loop up to `maxEditAttempts`, plain-language failure reason on exhaustion) for a single edit action, and separately reuses `MediaConsensusStrategy`'s **gate-outranks-judge ordering** (`evaluateCandidate`, lines 320-358: a gate failure short-circuits before any judge call) since that ordering *is* real and worth reusing.
   This distinction is called out explicitly in Task 5's code comments so a future reader doesn't go looking for a retry loop in `media-consensus-strategy.ts` that doesn't exist.

**7. Section B's `ImageCapabilityAttributes` does not exist yet anywhere in this codebase** (confirmed: no `interface ImageCapabilityAttributes` anywhere; only `VideoCapabilityAttributes` exists, at `api/src/providers/catalog/provider-catalog.types.ts:247-290`). Per this plan's brief, Task 2 defines a local stub in a new, small, clearly-marked file so it is a pure import-path swap once Section B's plan lands and defines the real, generic `capabilityAttributes: Partial<Record<Capability, CapabilityAttributes>>` on `ProviderCatalogEntry`.

**8. The underlying provider call already exists and needs no new code.** `image_editing` is a fully registered capability (`api/src/core/capabilities/capability-registry.ts:207-211`) already dispatched today through `executeCapabilityByPlan` → `capabilities-routes.ts:961-998`, which calls `services.image.editImage(...)` (`ImagesOrchestrationService.editImage`, `api/src/services/images-orchestration-service.ts:514-578`). The route already accepts `{ image_base64, mask_base64?, prompt, size, response_format, model?, n }` as a plain JSON body (`CapabilityRequestBody = Record<string, unknown>`) and returns `{ data: { data: Array<{url?, b64_json?, revised_prompt?}> }, resolvedProvider, resolvedModel, executionPath }` (`CapabilityModeResult`, `capabilities-routes.ts:84-89`). Task 5 dispatches through this exact existing path via `this.deps.capabilityDispatcher` (already injected into `MediaPlannerStrategy` for `capability_call` actions) — **no new provider-adapter code, no new `ImagesOrchestrationService` wiring.** This is what "does not touch `capability_call`'s existing dispatch path" means in practice: the same `CapabilityDispatcher` function is reused, called directly from the new `edit` branch, rather than the LLM having to emit a `capability_call` action itself.

---

## Task 1: `edit` action kind in `PlannerActionSchema`

**Files:**
- Modify: `api/src/core/orchestration/strategies/media-planner-types.ts`
- Test: `api/src/core/orchestration/strategies/__tests__/media-planner-types.edit-action.test.ts` (new — no dedicated test file exists yet for this module; existing coverage of `PlannerActionSchema` lives inline inside `media-planner-strategy.test.ts`, but a schema-only unit test belongs next to the schema itself)

- [ ] **Step 1: Write the failing test for the new schema**

Create `api/src/core/orchestration/strategies/__tests__/media-planner-types.edit-action.test.ts`:

```typescript
/**
 * PlannerActionSchema — `edit` action kind (Section D).
 *
 * Additive coverage only. The existing `capability_call` / `generate` /
 * `final` members are already covered by `media-planner-strategy.test.ts`
 * and are NOT touched by this change — this file only proves the new
 * member parses correctly and rejects malformed input.
 */
import { describe, it, expect } from 'vitest';
import { PlannerActionSchema } from '../media-planner-types';

describe('PlannerActionSchema — edit action', () => {
  it('parses a minimal edit action (prompt only)', () => {
    const parsed = PlannerActionSchema.parse({
      kind: 'edit',
      prompt: 'make the sky more orange at sunset',
    });
    expect(parsed).toEqual({ kind: 'edit', prompt: 'make the sky more orange at sunset' });
  });

  it('parses an edit action with sourceArtifactIndex and constraints', () => {
    const parsed = PlannerActionSchema.parse({
      kind: 'edit',
      prompt: 'remove the background',
      sourceArtifactIndex: 0,
      constraints: {
        dimensions: { width: 1024, height: 1024, tolerancePct: 0.1 },
        format: 'png',
      },
      reasoning: 'the user asked for a transparent background',
    });
    expect(parsed.kind).toBe('edit');
    if (parsed.kind === 'edit') {
      expect(parsed.sourceArtifactIndex).toBe(0);
      expect(parsed.constraints?.format).toBe('png');
    }
  });

  it('rejects an edit action missing "prompt"', () => {
    expect(() => PlannerActionSchema.parse({ kind: 'edit' })).toThrow();
  });

  it('rejects an edit action with a negative sourceArtifactIndex', () => {
    expect(() =>
      PlannerActionSchema.parse({ kind: 'edit', prompt: 'x', sourceArtifactIndex: -1 })
    ).toThrow();
  });

  it('still parses the existing three action kinds unmodified (regression guard)', () => {
    expect(PlannerActionSchema.parse({ kind: 'final', content: 'done', unmetConstraints: [] }).kind).toBe(
      'final'
    );
    expect(
      PlannerActionSchema.parse({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }).kind
    ).toBe('generate');
    expect(
      PlannerActionSchema.parse({ kind: 'capability_call', capability: 'pdf_understanding' }).kind
    ).toBe('capability_call');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-types.edit-action.test.ts`
Expected: FAIL — `PlannerActionSchema.parse` throws on `kind: 'edit'` because the discriminated union has no such member yet (ZodError: invalid discriminator value).

- [ ] **Step 3: Add `EditActionSchema` and wire it into the union**

In `api/src/core/orchestration/strategies/media-planner-types.ts`, add the schema right after `GenerateActionSchema` (after line 137, before the `FinalActionSchema` comment on line 139):

```typescript
/** Objective image constraints checked by `image-deterministic-gate.ts` —
 *  mirrors `MediaConstraintSetSchema`'s shape (duration/resolution/audio)
 *  but for the two things a still image actually has: dimensions and
 *  file format. See `image-capability-attributes.ts` for the TS-level
 *  type this schema's shape is kept in sync with. */
const ImageEditConstraintSetSchema = z
  .object({
    dimensions: z
      .object({
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        tolerancePct: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    format: z.string().min(1).optional(),
  })
  .strict();

/**
 * Dispatch an `image_editing` step through the deterministic-gate +
 * vision-judge + bounded-retry cycle (Section D). ADDITIVE next to
 * `capability_call` / `generate` / `final` — none of those three schemas
 * or their dispatch code are modified by this action kind's existence.
 *
 * `sourceArtifactIndex` references `PlannerState.artifacts` (0-based).
 * When omitted, `MediaPlannerStrategy` uses the MOST RECENT artifact
 * (`state.artifacts.length - 1`) — the common case of "edit what was just
 * generated." An LLM planner action is a small JSON object, not a place to
 * smuggle megabytes of base64 image data, which is why this references an
 * artifact by index instead of carrying image bytes inline.
 */
const EditActionSchema = z.object({
  kind: z.literal('edit'),
  prompt: z.string().min(1),
  sourceArtifactIndex: z.number().int().min(0).optional(),
  constraints: ImageEditConstraintSetSchema.optional(),
  reasoning: z.string().optional(),
});
```

Then update the union and exports (replace the existing block at lines 152-161):

```typescript
export const PlannerActionSchema = z.discriminatedUnion('kind', [
  CapabilityCallActionSchema,
  GenerateActionSchema,
  EditActionSchema,
  FinalActionSchema,
]);

export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type CapabilityCallAction = z.infer<typeof CapabilityCallActionSchema>;
export type GenerateAction = z.infer<typeof GenerateActionSchema>;
export type EditAction = z.infer<typeof EditActionSchema>;
export type FinalAction = z.infer<typeof FinalActionSchema>;
```

- [ ] **Step 4: Add the `edit_result` turn outcome variant**

In the same file, extend the `PlannerTurnOutcome` union (currently lines 165-190) — add one new member between `'generation_result'` and `'native_collapse'`:

```typescript
  | {
      readonly type: 'edit_result';
      readonly success: boolean;
      /** How many generate→gate→judge cycles were attempted (1..maxEditAttempts). */
      readonly attempts: number;
      readonly summary: string;
      readonly hasArtifact: boolean;
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-types.edit-action.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full existing media-planner-strategy suite as a regression guard**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`
Expected: PASS, unchanged (this task only added a union member and a new outcome variant — `media-planner-strategy.ts` does not reference `edit`/`edit_result` yet, so `tsc`/vitest must still compile and pass exactly as before).

- [ ] **Step 7: Commit**

```bash
cd api && git add src/core/orchestration/strategies/media-planner-types.ts src/core/orchestration/strategies/__tests__/media-planner-types.edit-action.test.ts
git commit -m "feat(media-planner): add edit action kind to PlannerActionSchema"
```

---

## Task 2: Local `ImageCapabilityAttributes` stub (Section B dependency)

**Files:**
- Create: `api/src/core/orchestration/strategies/image-capability-attributes.ts`
- Test: none (pure type + one trivial constant; exercised transitively by Task 3's tests)

**Section B dependency note (read before editing):** Section B's plan generalizes `ProviderCatalogEntry.videoCapabilityAttributes` into `capabilityAttributes: Partial<Record<Capability, CapabilityAttributes>>` in `api/src/providers/catalog/provider-catalog.types.ts` (sibling to the real `VideoCapabilityAttributes` at line 247 of that file), and that generic type is meant to carry the real `ImageCapabilityAttributes`. As of this plan being written, Section B's plan has not been executed and no such type exists anywhere in the repo (verified: `grep -rn "interface ImageCapabilityAttributes"` across `api/src` returns nothing). Rather than block Task 5 on Section B landing, this task defines a minimal local stub with the exact field semantics Section B's spec text promises ("dimensions, supported formats"), isolated in its own file so the eventual swap is a pure import-path change.

- [ ] **Step 1: Create the stub type file**

Create `api/src/core/orchestration/strategies/image-capability-attributes.ts`:

```typescript
/**
 * ImageCapabilityAttributes — LOCAL STUB, Section D dependency on Section B.
 *
 * Section B ("Attribute-aware catalog — generic type + 3-tier discovery")
 * defines the CANONICAL `ImageCapabilityAttributes` as part of a generic
 * `capabilityAttributes: Partial<Record<Capability, CapabilityAttributes>>`
 * on `ProviderCatalogEntry` (`api/src/providers/catalog/provider-catalog.types.ts`,
 * sibling to the real `VideoCapabilityAttributes` at line 247 of that file).
 *
 * As of this plan's writing (2026-09-23), Section B's plan had not yet been
 * executed in this codebase — `ImageCapabilityAttributes` did not exist
 * anywhere. Section D (image editing with verify) needs SOME shape for
 * "dimensions, supported formats" to keep `image-deterministic-gate.ts`'s
 * request-vs-actual comparison type-safe, so this file defines a minimal
 * local stand-in.
 *
 * TODO(section-B-dependency): once Section B's plan lands and defines the
 * real `ImageCapabilityAttributes` in `provider-catalog.types.ts`, delete
 * this file and re-point every import of it (currently only
 * `image-deterministic-gate.ts`) at the real type instead. The field names
 * below were chosen to match Section B's own spec wording ("dimensions,
 * supported formats") as closely as possible so the swap should not require
 * changing any call site's logic — only the import path.
 */
export interface ImageCapabilityAttributes {
  readonly maxWidthPx?: number;
  readonly maxHeightPx?: number;
  readonly minWidthPx?: number;
  readonly minHeightPx?: number;
  /** Lowercase format identifiers, e.g. ['png', 'jpeg', 'webp'] — matches
   *  the `type` string the `image-size` library returns (see
   *  `image-deterministic-gate.ts`), not a MIME type. */
  readonly supportedFormats?: readonly string[];
  readonly attributesVerifiedAt?: string;
}
```

- [ ] **Step 2: Commit**

```bash
cd api && git add src/core/orchestration/strategies/image-capability-attributes.ts
git commit -m "feat(media-planner): add local ImageCapabilityAttributes stub pending Section B"
```

(No red/green cycle here — this is a pure type declaration with no behavior. It gets exercised by Task 3's tests.)

---

## Task 3: `image-deterministic-gate.ts`

**Files:**
- Modify: `api/package.json` (add `image-size` dependency)
- Create: `api/src/core/orchestration/strategies/image-deterministic-gate.ts`
- Test: `api/src/core/orchestration/strategies/image-deterministic-gate.test.ts` (sibling to the file, mirroring where `media-deterministic-gate.test.ts` actually lives — NOT under `__tests__/`)

**Library choice — verified, not assumed:** `sharp` is NOT a usable dependency today (see Investigation finding 4 — it only appears in `pnpm.overrides` for transitive-dependency CVE pinning). This plan adds **`image-size@^1.2.1`** instead of `sharp` or `image-size@2.x`, for two concrete reasons verified against the actual npm registry during planning:
1. `sharp` is a ~40MB native addon (libvips) that would need to compile per-platform; this gate only needs to read a width/height/format header, not decode or transform pixels — `image-size` reads just enough of the file header to answer that, with zero runtime dependencies.
2. `image-size@2.x` (`npm view image-size version` → `2.0.4`) is ESM-only (`"type": "module"`, no CJS `main`/`exports` fallback), and this project's `api/tsconfig.json` is `"module": "CommonJS"` — importing it would require a dynamic `import()` or module-format workaround. `image-size@1.2.1` (verified via `npm view image-size@1.2.1 dist.unpackedSize main exports` → `main: "dist/index.js"`, no `"type"` field, i.e. plain CommonJS) has zero dependencies and exports a synchronous `imageSize(buffer: Uint8Array): { width, height, type, orientation? }` that accepts a `Buffer` directly (`Buffer` extends `Uint8Array`) — no temp file needed, matching how `probeMedia` in the existing gate takes an in-memory `Buffer`.

- [ ] **Step 1: Add the dependency**

```bash
cd api && pnpm add image-size@1.2.1
```

Verify the exact pin landed in `api/package.json`'s `dependencies` (not `devDependencies` — this ships in the gate's production code path) and that `api/pnpm-lock.yaml` was updated.

- [ ] **Step 2: Write the failing test**

Create `api/src/core/orchestration/strategies/image-deterministic-gate.test.ts`:

```typescript
/**
 * image-deterministic-gate — tests.
 *
 * Mocks `image-size`'s `imageSize()` (same mocking style as
 * `media-deterministic-gate.test.ts` mocks `probeMedia`) so this suite
 * never reads a real file. Property that matters most: an out-of-spec
 * fixture is REJECTED (`status: 'fail'`) with the concrete violation
 * reported, and every missing-input case degrades to a `skipped_*` status
 * rather than fabricating a pass — same fail-open/fail-closed philosophy as
 * the media gate this file mirrors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const imageSize = vi.fn();

vi.mock('image-size', () => ({
  imageSize: (...args: unknown[]) => imageSize(...args),
}));

import {
  runImageDeterministicGate,
  evaluateImageConstraints,
  type ImageEditConstraintSet,
} from './image-deterministic-gate';
import type { AilinArtifact } from '@/types';

beforeEach(() => {
  vi.clearAllMocks();
  imageSize.mockReturnValue({ width: 1024, height: 1024, type: 'png' });
});

function imageArtifact(overrides: Partial<AilinArtifact> = {}): AilinArtifact {
  return {
    modality: 'image',
    stage_name: 'edit-turn',
    stage_index: 0,
    b64_json: Buffer.from('fake image bytes').toString('base64'),
    mime_type: 'image/png',
    ...overrides,
  };
}

describe('runImageDeterministicGate — skip cases (never fabricates a verdict)', () => {
  it('no artifact → skipped_no_bytes', async () => {
    const r = await runImageDeterministicGate(undefined, { format: 'png' });
    expect(r.status).toBe('skipped_no_bytes');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('artifact with .error (edit call failed) → skipped_no_bytes', async () => {
    const r = await runImageDeterministicGate(
      imageArtifact({ error: 'provider 500', b64_json: undefined }),
      { format: 'png' }
    );
    expect(r.status).toBe('skipped_no_bytes');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('no constraints supplied → skipped_no_constraints', async () => {
    const r = await runImageDeterministicGate(imageArtifact(), undefined);
    expect(r.status).toBe('skipped_no_constraints');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('artifact has a url but no inline bytes → skipped_no_bytes (never fetches remote)', async () => {
    const r = await runImageDeterministicGate(
      imageArtifact({ b64_json: undefined, url: 'https://example.test/out.png' }),
      { format: 'png' }
    );
    expect(r.status).toBe('skipped_no_bytes');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('imageSize throws (unrecognized/corrupt format) → skipped_unavailable, never throws', async () => {
    imageSize.mockImplementation(() => {
      throw new Error('unsupported file type');
    });
    const r = await runImageDeterministicGate(imageArtifact(), { format: 'png' });
    expect(r.status).toBe('skipped_unavailable');
  });
});

describe('runImageDeterministicGate — pass/fail', () => {
  it('matching dimensions and format → pass', async () => {
    imageSize.mockReturnValue({ width: 1024, height: 1024, type: 'png' });
    const r = await runImageDeterministicGate(imageArtifact(), {
      dimensions: { width: 1024, height: 1024 },
      format: 'png',
    });
    expect(r.status).toBe('pass');
    expect(r.violations).toHaveLength(0);
  });

  it('wrong format → fail with a "format" violation', async () => {
    imageSize.mockReturnValue({ width: 1024, height: 1024, type: 'jpg' });
    const r = await runImageDeterministicGate(imageArtifact(), { format: 'png' });
    expect(r.status).toBe('fail');
    expect(r.violations).toEqual([{ constraint: 'format', expected: 'png', actual: 'jpg' }]);
  });

  it('undersized dimensions beyond tolerance → fail with a "dimensions" violation', async () => {
    imageSize.mockReturnValue({ width: 800, height: 800, type: 'png' });
    const r = await runImageDeterministicGate(imageArtifact(), {
      dimensions: { width: 1024, height: 1024, tolerancePct: 0.1 },
    });
    expect(r.status).toBe('fail');
    expect(r.violations[0]?.constraint).toBe('dimensions');
  });

  it('undersized dimensions WITHIN tolerance → pass', async () => {
    imageSize.mockReturnValue({ width: 950, height: 950, type: 'png' });
    const r = await runImageDeterministicGate(imageArtifact(), {
      dimensions: { width: 1024, height: 1024, tolerancePct: 0.1 },
    });
    expect(r.status).toBe('pass');
  });
});

describe('evaluateImageConstraints — pure helper', () => {
  it('reports no violations for an empty constraint set', () => {
    const violations = evaluateImageConstraints(
      { width: 1, height: 1, type: 'png' },
      {} as ImageEditConstraintSet
    );
    expect(violations).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/image-deterministic-gate.test.ts`
Expected: FAIL — `./image-deterministic-gate` module does not exist yet.

- [ ] **Step 4: Implement the gate**

Create `api/src/core/orchestration/strategies/image-deterministic-gate.ts`:

```typescript
/**
 * image-deterministic-gate — objective, pre-judge constraint checking for
 * IMAGE EDITS (Section D — "Image editing with verify").
 *
 * Mirrors `media-deterministic-gate.ts`'s shape exactly (same
 * pass/fail/skipped_* status union, same never-throws contract, same
 * fail-open-on-unknown-data philosophy) but probes real image bytes with
 * `image-size` — a lightweight, zero-dependency header-only reader — instead
 * of shelling out to ffmpeg/ffprobe, since a still image needs only
 * dimensions + format, not duration/codec/audio-track inspection.
 *
 * NEVER throws — every failure mode (missing bytes, unrecognized format,
 * the `image-size` call itself throwing) resolves to a `skipped_*` status so
 * an edit is never silently disqualified by an infrastructure hiccup
 * instead of an actual constraint violation.
 */
import { imageSize } from 'image-size';
import type { AilinArtifact } from '@/types';
import { logger } from '@/utils/logger';
import type { ImageCapabilityAttributes } from './image-capability-attributes';

const log = logger.child({ component: 'image-deterministic-gate' });

export interface ImageDimensionConstraint {
  readonly width?: number;
  readonly height?: number;
  /** Fractional tolerance below the target, e.g. 0.1 = 10% under is still
   *  OK. Default 0 (exact-or-above) — mirrors
   *  `media-deterministic-gate.ts`'s `ResolutionConstraint.tolerancePct`. */
  readonly tolerancePct?: number;
}

/**
 * Constraints the image gate can check OBJECTIVELY from a probed file
 * header. Kept structurally close to `ImageCapabilityAttributes` (dimensions
 * + format) so a future caller can derive one from the other without a
 * translation layer.
 */
export interface ImageEditConstraintSet {
  readonly dimensions?: ImageDimensionConstraint;
  /** Lowercase format identifier compared against `image-size`'s `type`
   *  field (e.g. 'png', 'jpg', 'webp') — NOT a MIME type. */
  readonly format?: string;
}

export type ImageGateStatus =
  | 'pass'
  | 'fail'
  /** No usable bytes to probe (edit call failed, or only a remote `url` was
   *  returned with no inline `b64_json` — this gate deliberately never
   *  fetches a remote URL itself, matching the media gate's contract). */
  | 'skipped_no_bytes'
  /** No constraints were supplied, or the artifact's modality isn't 'image'. */
  | 'skipped_no_constraints'
  /** `image-size` could not read the header (corrupt bytes, unsupported
   *  format) — an infrastructure/data problem, not a constraint failure. */
  | 'skipped_unavailable';

export interface ImageGateViolation {
  readonly constraint: 'dimensions' | 'format';
  readonly expected: string;
  readonly actual: string;
}

export interface ImageGateResult {
  readonly status: ImageGateStatus;
  readonly probe?: { readonly width?: number; readonly height?: number; readonly type?: string };
  readonly violations: readonly ImageGateViolation[];
  readonly notes?: string;
}

/** Referenced for documentation/type-parity with Section B — not consumed
 *  directly by this gate (this gate compares the REQUEST's constraints
 *  against the ACTUAL probed output, the same relationship
 *  `runDeterministicMediaGate` has to `MediaConstraintSet`; a provider's
 *  catalog-level `ImageCapabilityAttributes` is a routing-time concern,
 *  handled by Section B's pre-filter in `images-orchestration-service.ts`,
 *  not by this post-generation gate). */
export type { ImageCapabilityAttributes };

export async function runImageDeterministicGate(
  artifact: AilinArtifact | undefined,
  constraints: ImageEditConstraintSet | undefined
): Promise<ImageGateResult> {
  if (!artifact || artifact.error) {
    return {
      status: 'skipped_no_bytes',
      violations: [],
      notes: artifact?.error ? `artifact generation failed: ${artifact.error}` : 'no artifact',
    };
  }
  if (!constraints || Object.keys(constraints).length === 0) {
    return { status: 'skipped_no_constraints', violations: [] };
  }
  if (artifact.modality !== 'image') {
    return {
      status: 'skipped_no_constraints',
      violations: [],
      notes: `image gate only applies to modality "image", got "${artifact.modality}"`,
    };
  }
  if (!artifact.b64_json) {
    return {
      status: 'skipped_no_bytes',
      violations: [],
      notes: artifact.url
        ? 'artifact has a url but no inline b64_json; the deterministic gate does not fetch remote bytes'
        : 'artifact has no inline bytes to probe',
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(artifact.b64_json, 'base64');
  } catch {
    return { status: 'skipped_no_bytes', violations: [], notes: 'b64_json was not valid base64' };
  }
  if (buffer.length === 0) {
    return { status: 'skipped_no_bytes', violations: [], notes: 'decoded artifact buffer is empty' };
  }

  let probe: { width?: number; height?: number; type?: string };
  try {
    probe = imageSize(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'image gate: imageSize probe failed');
    return { status: 'skipped_unavailable', violations: [], notes: `probe failed: ${message}` };
  }

  const violations = evaluateImageConstraints(probe, constraints);
  return { status: violations.length > 0 ? 'fail' : 'pass', probe, violations };
}

// ─── pure helpers (exported for tests) ──────────────────────────────────

export function evaluateImageConstraints(
  probe: { width?: number; height?: number; type?: string },
  constraints: ImageEditConstraintSet
): ImageGateViolation[] {
  const violations: ImageGateViolation[] = [];

  if (constraints.format && probe.type && constraints.format.toLowerCase() !== probe.type.toLowerCase()) {
    violations.push({ constraint: 'format', expected: constraints.format, actual: probe.type });
  }

  if (constraints.dimensions && probe.width !== undefined && probe.height !== undefined) {
    const tolerance = constraints.dimensions.tolerancePct ?? 0;
    if (constraints.dimensions.width !== undefined) {
      const floor = constraints.dimensions.width * (1 - tolerance);
      if (probe.width < floor) {
        violations.push({
          constraint: 'dimensions',
          expected: `width >= ${Math.round(floor)}px`,
          actual: `${probe.width}px`,
        });
      }
    }
    if (constraints.dimensions.height !== undefined) {
      const floor = constraints.dimensions.height * (1 - tolerance);
      if (probe.height < floor) {
        violations.push({
          constraint: 'dimensions',
          expected: `height >= ${Math.round(floor)}px`,
          actual: `${probe.height}px`,
        });
      }
    }
  }

  return violations;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/image-deterministic-gate.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
cd api && git add package.json pnpm-lock.yaml src/core/orchestration/strategies/image-deterministic-gate.ts src/core/orchestration/strategies/image-deterministic-gate.test.ts
git commit -m "feat(media-planner): add image-deterministic-gate using image-size"
```

---

## Task 4: Vision-judge before/after comparison

**Files:**
- Modify: `api/src/core/orchestration/strategies/evaluation/media-judge-evaluator.ts`
- Test: `api/src/core/orchestration/strategies/evaluation/media-judge-evaluator.image-edit.test.ts` (new — kept separate from the existing `media-judge-evaluator.test.ts` to avoid growing an already-focused file, following this directory's own precedent of suffixed sibling test files, e.g. `consensus-strategy.artifacts.test.ts` next to `consensus-strategy.ts`)

- [ ] **Step 1: Write the failing test**

Create `api/src/core/orchestration/strategies/evaluation/media-judge-evaluator.image-edit.test.ts`:

```typescript
/**
 * MediaJudgeEvaluator — before/after image-edit verification (Section D).
 *
 * `evaluateImageEdit` is a NEW method alongside the existing `evaluate()`
 * contract (it does not implement `StrategyOutputEvaluator` — a before/after
 * PAIR of images has no equivalent single-`CandidateArtifact` shape). It
 * reuses the exact same safety gates as `evaluateVisualMedia` (disabled
 * config, missing judge model id, zero/invalid budget, no injected client)
 * and the same `MediaJudgeClient`/`buildImageEditJudgeContent` machinery.
 */
import { describe, it, expect, vi } from 'vitest';
import { MediaJudgeEvaluator, buildImageEditJudgeContent } from './media-judge-evaluator';
import type { MediaJudgeClient, MediaJudgeEvaluatorConfig, MediaJudgeInput } from './media-judge-evaluator.types';
import type { AilinArtifact } from '@/types';

const baseConfig: MediaJudgeEvaluatorConfig = {
  enabled: true,
  judgeModelId: 'vision-judge-x',
  maxCostUsd: 0.01,
  timeoutMs: 1000,
  rubricVersion: 'media-v1',
  criticRole: 'spec_compliance',
};

function preArtifact(): AilinArtifact {
  return {
    modality: 'image',
    stage_name: 'gen-turn',
    stage_index: 0,
    b64_json: 'cHJlLWVkaXQtaW1hZ2UtYnl0ZXM=',
    mime_type: 'image/png',
  };
}

function postArtifact(): AilinArtifact {
  return {
    modality: 'image',
    stage_name: 'edit-turn',
    stage_index: 1,
    b64_json: 'cG9zdC1lZGl0LWltYWdlLWJ5dGVz',
    mime_type: 'image/png',
  };
}

describe('buildImageEditJudgeContent', () => {
  it('includes the edit instruction and both images, labeled before/after', () => {
    const content = buildImageEditJudgeContent(
      'make the sky orange',
      preArtifact(),
      postArtifact()
    );
    const text = content
      .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    expect(text).toContain('make the sky orange');
    expect(text.toUpperCase()).toContain('BEFORE');
    expect(text.toUpperCase()).toContain('AFTER');
    const images = content.filter((p) => p.type === 'image_url');
    expect(images).toHaveLength(2);
  });
});

describe('MediaJudgeEvaluator.evaluateImageEdit — safety gates', () => {
  it('disabled config → unavailable, client never called', async () => {
    const mediaClient: MediaJudgeClient = { judgeMedia: vi.fn() };
    const ev = new MediaJudgeEvaluator({ ...baseConfig, enabled: false }, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });

  it('no injected client → unavailable', async () => {
    const ev = new MediaJudgeEvaluator(baseConfig, undefined);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
  });

  it('missing pre or post bytes → unavailable, never fabricates a verdict', async () => {
    const mediaClient: MediaJudgeClient = { judgeMedia: vi.fn() };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make it brighter',
      preArtifact: { ...preArtifact(), b64_json: undefined },
      postArtifact: postArtifact(),
    });
    expect(r.validationStatus).toBe('unavailable');
    expect(mediaClient.judgeMedia).not.toHaveBeenCalled();
  });
});

describe('MediaJudgeEvaluator.evaluateImageEdit — real (mocked) call', () => {
  it('dispatches through the injected client and returns its verdict', async () => {
    const judgeMedia = vi.fn(
      async (input: MediaJudgeInput) =>
        ({ score: 0.9, verdict: 'pass' as const, confidence: 0.8, costUsd: 0.001 })
    );
    const mediaClient: MediaJudgeClient = { judgeMedia };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make the sky orange',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(judgeMedia).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe('pass');
    expect(r.score).toBe(0.9);
    expect(r.validationStatus).toBe('fully_validated');
  });

  it('client throws → uncertain/unavailable, never throws out of evaluateImageEdit', async () => {
    const mediaClient: MediaJudgeClient = {
      judgeMedia: vi.fn().mockRejectedValue(new Error('provider timeout')),
    };
    const ev = new MediaJudgeEvaluator(baseConfig, mediaClient);
    const r = await ev.evaluateImageEdit({
      editInstruction: 'make the sky orange',
      preArtifact: preArtifact(),
      postArtifact: postArtifact(),
    });
    expect(r.verdict).toBe('uncertain');
    expect(r.validationStatus).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/media-judge-evaluator.image-edit.test.ts`
Expected: FAIL — `buildImageEditJudgeContent` is not exported and `evaluateImageEdit` does not exist on `MediaJudgeEvaluator`.

- [ ] **Step 3: Implement `buildImageEditJudgeContent` and `evaluateImageEdit`**

In `api/src/core/orchestration/strategies/evaluation/media-judge-evaluator.ts`, add this exported pure function after `buildMediaJudgeContent` (after line 266, before `joinNotes`):

```typescript
/**
 * Build the before/after judge prompt for an IMAGE EDIT (Section D). Unlike
 * `buildMediaJudgeContent` (one candidate, N sampled frames of the SAME
 * artifact), this presents TWO DIFFERENT images — the pre-edit source and
 * the post-edit result — and asks the judge to confirm the stated edit
 * instruction was followed between them. Deliberately reuses plain
 * `text`/`image_url` parts (not the `video_frame` type, which encodes a
 * temporal-sequence-of-one-artifact concept that doesn't apply to a
 * before/after PAIR of distinct artifacts) so no provider-adapter
 * normalization changes are needed — every adapter already understands
 * `text`/`image_url`.
 */
export function buildImageEditJudgeContent(
  editInstruction: string,
  preArtifact: AilinArtifact,
  postArtifact: AilinArtifact
): MessageContent[] {
  const header = [
    'task_type=image_editing',
    `You are verifying an IMAGE EDIT. Compare the BEFORE image to the AFTER image and confirm ` +
      `whether the following edit instruction was followed: "${editInstruction}"`,
  ].join('\n\n');

  const preMime = preArtifact.mime_type?.startsWith('image/') ? preArtifact.mime_type : 'image/jpeg';
  const postMime = postArtifact.mime_type?.startsWith('image/') ? postArtifact.mime_type : 'image/jpeg';

  return [
    { type: 'text', text: header },
    { type: 'text', text: 'BEFORE (original image):' },
    { type: 'image_url', image_url: { url: `data:${preMime};base64,${preArtifact.b64_json}`, detail: 'low' } },
    { type: 'text', text: 'AFTER (edited image):' },
    { type: 'image_url', image_url: { url: `data:${postMime};base64,${postArtifact.b64_json}`, detail: 'low' } },
  ];
}
```

Add the `AilinArtifact` import to the existing import block near the top of the file (it currently imports `MessageContent` from `@/types` at line 38 — extend that line):

```typescript
import type { AilinArtifact, MessageContent } from '@/types';
```

Then add the new method to the `MediaJudgeEvaluator` class, right after `evaluateVisualMedia` (after line 196, before `failedGeneration`):

```typescript
  /**
   * Before/after image-edit verification (Section D). Does NOT implement
   * `StrategyOutputEvaluator.evaluate()` — a before/after PAIR has no
   * single-`CandidateArtifact` shape to fit that contract — but reuses the
   * EXACT same safety-gate order and client/config plumbing as
   * `evaluateVisualMedia` above, so an edit-verification call degrades
   * exactly as safely as a normal media-judge call.
   */
  async evaluateImageEdit(input: {
    readonly editInstruction: string;
    readonly preArtifact: AilinArtifact;
    readonly postArtifact: AilinArtifact;
    readonly judgeModelOverride?: string;
  }): Promise<EvaluationResult> {
    if (input.preArtifact.error || input.postArtifact.error) {
      return this.failedGeneration(input.postArtifact.error ?? input.preArtifact.error ?? 'unknown error');
    }
    if (!input.preArtifact.b64_json || !input.postArtifact.b64_json) {
      return this.unavailable('image_edit_missing_bytes');
    }
    if (!this.config.enabled) {
      return this.unavailable('media_judge_disabled');
    }
    const effectiveJudgeModelId =
      input.judgeModelOverride && input.judgeModelOverride.trim().length > 0
        ? input.judgeModelOverride.trim()
        : this.config.judgeModelId;
    if (!effectiveJudgeModelId || effectiveJudgeModelId.trim().length === 0) {
      return this.unavailable('judge_model_id_missing');
    }
    if (!Number.isFinite(this.config.maxCostUsd) || this.config.maxCostUsd <= 0) {
      return this.unavailable('budget_zero_or_invalid');
    }
    if (!this.mediaClient) {
      return this.unavailable('media_judge_client_unavailable');
    }

    const content = buildImageEditJudgeContent(
      input.editInstruction,
      input.preArtifact,
      input.postArtifact
    );

    let raw: LLMJudgeRawResult;
    try {
      raw = await withTimeout(
        this.mediaClient.judgeMedia({
          judgeModelId: effectiveJudgeModelId,
          rubricVersion: this.config.rubricVersion,
          criticRole: this.criticRole ?? 'spec_compliance',
          task: { taskType: 'image_editing', userMessageExcerpt: input.editInstruction.slice(0, 200) },
          content,
          role: 'voter',
          maxCostUsd: this.config.maxCostUsd,
          timeoutMs: this.config.timeoutMs,
        }),
        this.config.timeoutMs
      );
    } catch (err) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        notes: `image-edit judge call failed: ${errorMessage(err)}`,
        validationStatus: 'unavailable',
      };
    }

    if (!isValidRaw(raw)) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        notes: 'image-edit judge returned malformed result',
        validationStatus: 'unavailable',
      };
    }

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: clamp01(raw.score),
      verdict: raw.verdict,
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      confidence: raw.confidence,
      judgeCostUsd: raw.costUsd ?? 0,
      notes: `${raw.shortRationale ?? ''} (image_edit_verification, judgeModel=${effectiveJudgeModelId})`.trim(),
      validationStatus: 'fully_validated',
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/media-judge-evaluator.image-edit.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the existing evaluator suite as a regression guard**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/media-judge-evaluator.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
cd api && git add src/core/orchestration/strategies/evaluation/media-judge-evaluator.ts src/core/orchestration/strategies/evaluation/media-judge-evaluator.image-edit.test.ts
git commit -m "feat(media-planner): add before/after image-edit vision-judge comparison"
```

---

## Task 5: `edit` action dispatch with bounded retry in `MediaPlannerStrategy`

**Files:**
- Modify: `api/src/core/orchestration/strategies/media-planner-strategy.ts`
- Test: `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.edit-action.test.ts` (new sibling test file, same directory/convention as the existing `media-planner-strategy.test.ts`)

- [ ] **Step 1: Write the failing tests**

Create `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.edit-action.test.ts`:

```typescript
/**
 * MediaPlannerStrategy — `edit` action dispatch (Section D).
 *
 * Mirrors the mocking style of `media-planner-strategy.test.ts`
 * (capabilityDispatcher / mediaConsensusExecutor via constructor DI,
 * persistMediaPlanRun mocked at module level). No real provider, DB, or
 * network call anywhere in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AilinArtifact, ChatRequest, Model, OrchestrationContext } from '@/types';
import type { CapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { CapabilityModeResult } from '@/routes/capabilities/capabilities-routes';

const persistMediaPlanRunMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../media-planner-repository', () => ({
  persistMediaPlanRun: (...args: unknown[]) => persistMediaPlanRunMock(...args),
}));

const imageSizeMock = vi.fn().mockReturnValue({ width: 1024, height: 1024, type: 'png' });
vi.mock('image-size', () => ({ imageSize: (...args: unknown[]) => imageSizeMock(...args) }));

const { MediaPlannerStrategy } = await import('../media-planner-strategy');

function makeRequest(text: string): ChatRequest {
  return { model: 'auto', messages: [{ role: 'user', content: text }] };
}

function makeInvoker(overrides: Partial<CapabilityInvoker> = {}): CapabilityInvoker {
  return {
    chat: vi.fn().mockRejectedValue(new Error('chat() not stubbed for this test')),
    transcribe: vi.fn().mockRejectedValue(new Error('not implemented')),
    synthesize: vi.fn().mockRejectedValue(new Error('not implemented')),
    translate: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateVideo: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateImage: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    ...overrides,
  };
}

function makeContext(
  models: Model[],
  invoker: CapabilityInvoker,
  overrides: Partial<OrchestrationContext> = {}
): OrchestrationContext {
  return {
    organizationId: 'org-test',
    userId: 'user-test',
    requestId: 'req-test',
    models,
    taskType: 'creative',
    contextSize: 1000,
    invoker,
    ...overrides,
  };
}

function chatJson(value: unknown) {
  return {
    id: 'r',
    object: 'chat.completion' as const,
    created: 0,
    model: 'planner-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: JSON.stringify(value) },
        finish_reason: 'stop' as const,
        logprobs: null,
      },
    ],
  };
}

const sourceImage: AilinArtifact = {
  modality: 'image',
  stage_name: 'seed',
  stage_index: 0,
  b64_json: Buffer.from('source image bytes').toString('base64'),
  mime_type: 'image/png',
};

beforeEach(() => {
  persistMediaPlanRunMock.mockClear();
  imageSizeMock.mockClear();
  imageSizeMock.mockReturnValue({ width: 1024, height: 1024, type: 'png' });
});

describe('MediaPlannerStrategy — edit action', () => {
  it('generate then edit: dispatches image_editing, gate passes, succeeds on first attempt', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(chatJson({ kind: 'edit', prompt: 'make the sky orange' }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: [] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };

    const editedB64 = Buffer.from('edited image bytes').toString('base64');
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: editedB64 }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor, capabilityDispatcher });
    const result = await strategy.execute(makeRequest('generate a cat then make the sky orange'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(1);
    expect(capabilityDispatcher.mock.calls[0][0]).toMatchObject({ id: 'image_editing' });
    expect(capabilityDispatcher.mock.calls[0][1]).toMatchObject({
      prompt: 'make the sky orange',
      image_base64: sourceImage.b64_json,
    });
    expect(result.artifacts).toHaveLength(2); // seed image + edited image
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean } }>;
    const editTurn = plan.find((t) => t.outcome.type === 'edit_result');
    expect(editTurn?.outcome.success).toBe(true);
  });

  it('no source artifact available → fails without calling the dispatcher', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'edit', prompt: 'make the sky orange' }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: ['edit failed: no source image'] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);
    const capabilityDispatcher = vi.fn();

    const strategy = new MediaPlannerStrategy({ capabilityDispatcher });
    const result = await strategy.execute(makeRequest('edit my photo'), context);

    expect(capabilityDispatcher).not.toHaveBeenCalled();
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean } }>;
    expect(plan[0].outcome).toMatchObject({ type: 'edit_result', success: false });
  });

  it('gate fails on every attempt → retries up to maxEditAttempts then reports failure', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(
        chatJson({
          kind: 'edit',
          prompt: 'resize to 1024x1024 png',
          constraints: { dimensions: { width: 1024, height: 1024 }, format: 'png' },
        })
      )
      .mockResolvedValueOnce(
        chatJson({ kind: 'final', content: 'could not verify the edit', unmetConstraints: ['1024x1024 png edit'] })
      );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };

    // Every attempt returns a WRONG format ('jpg' instead of the requested 'png').
    imageSizeMock.mockReturnValue({ width: 1024, height: 1024, type: 'jpg' });
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: Buffer.from('wrong format bytes').toString('base64') }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({
      mediaConsensusExecutor,
      capabilityDispatcher,
      maxTurns: 3,
    });
    const result = await strategy.execute(makeRequest('generate a cat then resize it'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(2); // default maxEditAttempts = 2
    const plan = result.metadata.plan as Array<{ outcome: { type: string; success?: boolean; attempts?: number } }>;
    const editTurn = plan.find((t) => t.outcome.type === 'edit_result');
    expect(editTurn?.outcome).toMatchObject({ success: false, attempts: 2 });
  });

  it('respects a maxEditAttempts override for deterministic tests', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'a cat' }))
      .mockResolvedValueOnce(
        chatJson({ kind: 'edit', prompt: 'resize', constraints: { format: 'png' } })
      )
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: [] }));
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const mediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue({
        bestCandidateIndex: 0,
        bestArtifact: sourceImage,
        candidates: [{}],
        totalJudgeCostUsd: 0,
        totalDurationMs: 5,
        degraded: false,
      }),
    };
    imageSizeMock.mockReturnValue({ width: 1024, height: 1024, type: 'jpg' }); // always wrong format
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { data: [{ b64_json: Buffer.from('x').toString('base64') }] },
        executionPath: 'native_adapter',
      } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({
      mediaConsensusExecutor,
      capabilityDispatcher,
      maxEditAttempts: 1,
    });
    await strategy.execute(makeRequest('generate a cat then resize it'), context);

    expect(capabilityDispatcher).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.edit-action.test.ts`
Expected: FAIL — `MediaPlannerDeps` has no `maxEditAttempts`, and `action.kind === 'edit'` is unhandled (falls through to the `capability_call` branch and throws on `action.capability` being `undefined`, or TypeScript fails to compile since `action.capability` doesn't exist on the `edit` member of the union).

- [ ] **Step 3: Implement the dispatch branch**

In `api/src/core/orchestration/strategies/media-planner-strategy.ts`:

**3a.** Extend the imports (replace the existing `media-planner-types` import block, lines 61-71):

```typescript
import {
  MEDIA_GENERATION_CAPABILITIES,
  PlannerActionSchema,
  type MediaConsensusExecutor,
  type PlannerAction,
  type PlannerBudget,
  type PlannerState,
  type PlannerStopReason,
  type PlannerTurn,
  type PlannerTurnOutcome,
} from './media-planner-types';
import { runImageDeterministicGate } from './image-deterministic-gate';
```

Also add, near the top of the file:

```typescript
import type { EvaluationResult } from './evaluation/strategy-output-evaluator';
```

**3b.** Add a structural executor interface next to `MediaConsensusExecutor`'s usage, and two new `MediaPlannerDeps` fields (extend the interface at lines 90-104):

```typescript
/**
 * Structural interface for the before/after image-edit judge (Section D).
 * `MediaJudgeEvaluator.evaluateImageEdit` already satisfies this shape —
 * TypeScript structural typing means a real instance can be passed in with
 * no adapter code, exactly like `MediaConsensusExecutor` above.
 */
export interface ImageEditJudge {
  evaluateImageEdit(input: {
    readonly editInstruction: string;
    readonly preArtifact: AilinArtifact;
    readonly postArtifact: AilinArtifact;
  }): Promise<EvaluationResult>;
}

export interface MediaPlannerDeps {
  readonly capabilityDispatcher?: CapabilityDispatcher;
  readonly mediaConsensusExecutor?: MediaConsensusExecutor;
  /** Falls back to the real singleton (`getCapabilityExecutionService()`) —
   *  only overridden in tests. */
  readonly capabilityExecutionService?: Pick<CapabilityExecutionService, 'executeWithCapabilities'>;
  /** Overrides `config.mediaPlanner.maxTurns` for this instance (tests). */
  readonly maxTurns?: number;
  /** Overrides `config.mediaPlanner.costCeilingMultiplier` for this instance (tests). */
  readonly costCeilingMultiplier?: number;
  /** Forwarded to `mediaConsensusExecutor.execute()` as `candidateCount` when set. */
  readonly candidateCount?: number;
  /** Injectable clock for deterministic duration assertions in tests. */
  readonly now?: () => number;
  /** Optional before/after vision-judge for `edit` actions (Section D). When
   *  absent, an edit that passes the deterministic gate is accepted without
   *  a subjective quality check — the same fail-open-on-missing-dependency
   *  posture `generate` already has for `mediaConsensusExecutor`. */
  readonly imageEditJudge?: ImageEditJudge;
  /** Bounded retry count for `edit` actions. Default 2, per the approved
   *  design ("Bounded retry: ... up to 2 times"). */
  readonly maxEditAttempts?: number;
}
```

**3c.** Insert the new branch in `execute()`'s turn loop, right after the `'generate'` branch's closing brace. Currently, line 377 is `continue;`, line 378 is the `}` that closes the `if (action.kind === 'generate')` block, line 379 is blank, and line 380 is the `// action.kind === 'capability_call'` comment — insert the new block after line 378's `}` and before line 379:

```typescript
      if (action.kind === 'edit') {
        const outcome = await this.runImageEdit(action, state);
        state.turns.push({
          turnIndex,
          action,
          outcome,
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
        continue;
      }

```

**3d.** Add the `runImageEdit` private method. Insert it right after `runNativeCollapse` (after its closing `}` — currently line 654 — and before `synthesizeDegradedSummary`):

```typescript
  /**
   * §D "Image editing with verify": dispatch through the EXISTING,
   * UNMODIFIED `image_editing` capability plan (the same
   * `capabilityDispatcher`/`executeCapabilityByPlan` path a `capability_call`
   * action already uses), then gate the result with
   * `runImageDeterministicGate` and, if a judge is wired, confirm the edit
   * instruction was followed via `ImageEditJudge.evaluateImageEdit`.
   *
   * Bounded retry (default 2 attempts, `deps.maxEditAttempts` overridable):
   * NOTE this does NOT mirror a "retry-on-gate-fail loop inside
   * `MediaConsensusStrategy`" — no such loop exists there (it generates N
   * candidates in parallel and filters outliers, never re-generates one).
   * This loop instead mirrors this class's OWN outer turn loop shape
   * (`execute()` above): keep trying up to a bound, and on exhaustion
   * produce a plain-language failure reason instead of throwing. It reuses
   * `MediaConsensusStrategy.evaluateCandidate`'s real, worth-keeping
   * property — the deterministic gate outranks the (paid) judge, so a gate
   * failure never reaches a judge call.
   */
  private async runImageEdit(
    action: Extract<PlannerAction, { kind: 'edit' }>,
    state: PlannerState
  ): Promise<PlannerTurnOutcome> {
    const sourceIndex = action.sourceArtifactIndex ?? state.artifacts.length - 1;
    const source = state.artifacts[sourceIndex];
    if (!source || !source.b64_json) {
      return {
        type: 'edit_result',
        success: false,
        attempts: 0,
        summary:
          sourceIndex < 0 || !state.artifacts.length
            ? 'no artifact has been produced yet to edit'
            : `artifact at index ${sourceIndex} has no inline image bytes to edit`,
        hasArtifact: false,
      };
    }
    if (!this.deps.capabilityDispatcher) {
      return {
        type: 'edit_result',
        success: false,
        attempts: 0,
        summary: 'capability dispatcher not wired',
        hasArtifact: false,
      };
    }
    const plan = getCapabilityExecutionPlan('image_editing');
    if (!plan) {
      return {
        type: 'edit_result',
        success: false,
        attempts: 0,
        summary: 'image_editing not in the live capability registry',
        hasArtifact: false,
      };
    }

    const maxAttempts = Math.max(1, this.deps.maxEditAttempts ?? 2);
    let lastFailureReason = 'unknown failure';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let edited: AilinArtifact;
      try {
        const { result } = await this.deps.capabilityDispatcher(plan, {
          image_base64: source.b64_json,
          prompt: action.prompt,
          response_format: 'b64_json',
        });
        edited = extractEditedArtifact(result, action);
      } catch (err) {
        lastFailureReason = `edit call failed: ${getErrorMessage(err)}`;
        continue;
      }
      if (edited.error) {
        lastFailureReason = `edit call failed: ${edited.error}`;
        continue;
      }

      const gate = await runImageDeterministicGate(edited, action.constraints);
      if (gate.status === 'fail') {
        lastFailureReason = `deterministic gate failed: ${gate.violations
          .map((v) => `${v.constraint} expected ${v.expected}, got ${v.actual}`)
          .join('; ')}`;
        continue;
      }

      if (this.deps.imageEditJudge) {
        const judgeResult = await this.deps.imageEditJudge.evaluateImageEdit({
          editInstruction: action.prompt,
          preArtifact: source,
          postArtifact: edited,
        });
        if (judgeResult.verdict === 'fail') {
          lastFailureReason = `vision judge rejected the edit: ${judgeResult.notes ?? 'no rationale given'}`;
          continue;
        }
      }

      state.artifacts.push(edited);
      return {
        type: 'edit_result',
        success: true,
        attempts: attempt,
        summary: `edit verified after ${attempt} attempt(s)`,
        hasArtifact: true,
      };
    }

    return {
      type: 'edit_result',
      success: false,
      attempts: maxAttempts,
      summary: `edit failed verification after ${maxAttempts} attempt(s): ${lastFailureReason}`,
      hasArtifact: false,
    };
  }

```

**3e.** Add the small extraction helper near the other module-level helpers at the bottom of the file (after `stripJsonCodeFence`, before `buildChatResponse`):

```typescript
/**
 * `CapabilityModeResult.data` is `unknown` (it's built generically for
 * every capability's response shape) — narrow it defensively rather than
 * trusting the JSON shape blindly. Mirrors the response shape
 * `capabilities-routes.ts`'s `image_editing` branch actually returns:
 * `{ data: { data: Array<{ url?, b64_json?, revised_prompt? }> } }`.
 */
function extractEditedArtifact(
  result: CapabilityModeResult,
  action: Extract<PlannerAction, { kind: 'edit' }>
): AilinArtifact {
  const outer = result.data as { data?: unknown } | undefined;
  const images = Array.isArray(outer?.data) ? (outer.data as Array<Record<string, unknown>>) : [];
  const first = images[0];
  const url = typeof first?.url === 'string' ? first.url : undefined;
  const b64Json = typeof first?.b64_json === 'string' ? first.b64_json : undefined;
  if (!first || (!url && !b64Json)) {
    return {
      modality: 'image',
      stage_name: 'media-plan-edit',
      stage_index: 0,
      error: 'image edit call returned no usable output',
    };
  }
  return {
    modality: 'image',
    stage_name: 'media-plan-edit',
    stage_index: 0,
    url,
    b64_json: b64Json,
    revised_prompt: typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined,
    provider: result.resolvedProvider,
    model: result.resolvedModel,
    metadata: { editInstruction: action.prompt },
  };
}
```

**3f.** Extend `summarizeTurnForTranscript`'s switch (currently lines 152-166) with the new outcome case, and extend the system prompt so the LLM is told to name a failed edit in `unmetConstraints`:

```typescript
    case 'edit_result':
      return outcome.success
        ? `Turn ${turn.turnIndex}: image edit verified after ${outcome.attempts} attempt(s) (${outcome.summary})`
        : `Turn ${turn.turnIndex}: image edit FAILED verification after ${outcome.attempts} attempt(s) — you MUST name this in the final action's unmetConstraints (${outcome.summary})`;
```

In `buildPlannerSystemPrompt` (lines 192-219), add the `edit` action to the response-shape list — insert this new line right after the existing `"generate"` line (currently line 212) and before the `"capability_call"` line:

```typescript
    '  {"kind":"edit","prompt":"...describe the edit...","sourceArtifactIndex"?:number,"constraints"?:{"dimensions"?:{"width"?:number,"height"?:number,"tolerancePct"?:number},"format"?:"png"|"jpeg"|"webp"|"..."},"reasoning"?:"..."} — use this (NOT capability_call) whenever the user wants to EDIT an existing image; it automatically verifies the edit and retries on failure',
```

**3g.** `buildPlannerToolManifest()` (lines 182-190) is left unmodified — `image_editing` still appears under `capability_call` tools for backward compatibility (a plain `capability_call` to `image_editing` still works, unverified, exactly as it does today); the system-prompt line added in 3f is what steers the LLM toward `edit` for editing tasks without removing the fallback path.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.edit-action.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full existing media-planner-strategy suite as a regression guard**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 6: Run the whole orchestration/strategies test directory to catch any TypeScript exhaustiveness break**

`summarizeTurnForTranscript`'s `switch` on `PlannerTurnOutcome['type']` has no `default` case — adding `edit_result` to the union without a matching `case` would be a TypeScript compile error, so a clean run here is a real correctness signal, not just a formality.

Run: `cd api && npx vitest run src/core/orchestration/strategies`
Expected: PASS across the whole directory.

- [ ] **Step 7: Commit**

```bash
cd api && git add src/core/orchestration/strategies/media-planner-strategy.ts src/core/orchestration/strategies/__tests__/media-planner-strategy.edit-action.test.ts
git commit -m "feat(media-planner): dispatch edit actions through gate+judge+bounded-retry"
```

---

## Task 6: Wire a real `ImageEditJudge` at the production call site (optional, mirrors Section A's posture)

**Files:**
- Modify: wherever `MediaPlannerStrategy` is constructed for production use — confirmed by grep to be the route referenced in `media-planner-strategy.ts`'s own module doc comment (`api/src/routes/capabilities/capabilities-routes.ts`, the `POST /v1/capabilities/media-plan/execute` handler). **Before editing, grep for `new MediaPlannerStrategy(` to find the exact current construction site(s) — do not assume the line number, this plan's earlier investigation only confirmed the file, not the exact call site, since Section E (chat pipeline integration) may have already added a second one by the time this task runs.**
- Test: extend whatever integration test already covers that route's media-planner wiring (find via grep for `MEDIA_PLANNER_ENABLED` in `__tests__`/`routes/**/__tests__`).

**This task is explicitly optional / best-effort** — per Investigation finding 5 and the `runImageEdit` design in Task 5, an edit with no `imageEditJudge` wired still works correctly (deterministic-gate-only verification, fail-open on the judge being absent, exactly like `generate` actions fail open when `mediaConsensusExecutor` is absent). Wiring a real judge here requires a real vision-capable judge model resolution, which is Section A's `ModelRoleResolver`/`requireVision` work — if Section A has not landed yet when this task runs, **skip this task and leave a one-line TODO comment at the `MediaPlannerStrategy` construction site** referencing this plan and Section A, rather than hand-rolling a parallel judge-model-resolution mechanism that Section A will make redundant.

- [ ] **Step 1: Grep for the current construction site**

```bash
cd api && grep -rn "new MediaPlannerStrategy(" src
```

- [ ] **Step 2: If Section A has landed** (real `MediaJudgeEvaluator` instances are already constructed and injected into `MediaConsensusStrategy` at this call site), construct one more `MediaJudgeEvaluator` configured with `criticRole: 'spec_compliance'` and pass it as `imageEditJudge` in the `MediaPlannerDeps` object literal. No new class is needed — `MediaJudgeEvaluator.evaluateImageEdit` (Task 4) already satisfies the `ImageEditJudge` structural interface (Task 5, step 3b).

- [ ] **Step 3: If Section A has NOT landed**, add a one-line comment at the construction site:

```typescript
// TODO(section-A-dependency, section-D-image-edit-verify-plan): once Section
// A wires a real vision-capable judge model via ModelRoleResolver, pass a
// MediaJudgeEvaluator(criticRole: 'spec_compliance') here as
// `imageEditJudge` so edit actions get a subjective before/after check on
// top of the deterministic gate. Absent, edits are still gated
// deterministically (dimensions/format) — this is a strictly additive
// quality improvement, not a correctness gap.
```

- [ ] **Step 4: Run whatever test suite covers that route**

Run the command discovered in Step 1's grep output's neighboring test file (do not guess — this call site's exact test command depends on which file Step 1 finds).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(media-planner): wire or TODO real ImageEditJudge at the production call site"
```

---

## Real-money batch — REQUIRES USER GO-AHEAD BEFORE RUNNING

**Do not run this task as part of automated plan execution. Stop after Task 6 and present this section to the user for explicit approval, with a cost estimate, before running anything below.**

Per the spec's Section 0 testing policy: "Any test that calls a real paid provider or a real judge model is called out explicitly in that section's plan, batched, and run only after an explicit go-ahead with a cost estimate."

### What this validates
One real edit request through a real image-editing provider (e.g. BFL/Flux, Recraft, or BytePlus — whichever is configured with a live API key in the target environment; grep `api/src/providers/*/[a-z]*-adapter.ts` for `imageEdit(` to confirm which adapters implement it, since this plan's earlier investigation only confirmed the ROUTE dispatches to `editImage`, not which specific provider key is live in this environment) plus one real vision-judge model call (a real, vision-capable model id resolved the same way Section A resolves one), confirming the whole `edit` → real gate → real judge chain works outside mocks — the one property no amount of mocking can prove.

### Cost estimate (fill in before asking for go-ahead)
- 1 real `image_editing` provider call (typically $0.01–$0.05 per edit depending on provider/model — confirm against the specific provider's current pricing in `api/src/providers/catalog/providers.catalog.ts` before quoting a number to the user).
- 1 real vision-judge model call (typically a few cents for a low-detail image + short JSON response — confirm against the judge model's actual per-token pricing before quoting a number).
- Total: low single-digit dollars or less, but state the ACTUAL numbers from the live catalog before asking, not this placeholder range.

### Steps (only after explicit go-ahead)
- [ ] Confirm which provider adapter has a live key in the target environment (`imageEdit` implementers: grep result from above).
- [ ] Confirm a vision-capable judge model id is configured (or resolve one manually the way Section A's `ModelRoleResolver` would).
- [ ] Construct a `MediaPlannerStrategy` with a real `capabilityDispatcher` (the actual `executeCapabilityByPlan`-backed one, not a mock), a real or mocked `mediaConsensusExecutor` (only the edit step needs to be real — seed `state.artifacts` via a cheap/free means if possible, e.g. a small local test image converted to base64, to avoid ALSO paying for a real image-generation call just to produce a source image), and a real `ImageEditJudge` (`MediaJudgeEvaluator` wired to a `ProviderMediaJudgeClient`).
- [ ] Run one edit request end to end, capture the real gate result and real judge verdict, and report both back to the user (score, verdict, rationale, actual cost incurred) as evidence the chain works — do not just report "it passed."
- [ ] Do not repeat this run automatically or add it to CI — it is a manual, one-off validation per the spec's cost policy, not a regression test.
