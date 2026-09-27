<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MediaPlanner Section A — Real Judge/Critics in Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real, vision-capable `MediaJudgeEvaluator` critics into both production `MediaConsensusStrategy` call sites (replacing the current `critics: []` no-op), add a `requireVision` hard filter to `ModelRoleResolver`'s judge-role resolution so a vision judge is never silently substituted with a text-only model, verify judge cost really flows into `PlannerBudget`'s cost ceiling, and make it impossible for "no vision-capable judge model configured" to fail silently — it must show up in the persisted plan audit trail.

**Architecture:** Two new small, independently-testable modules do the real work — `resolveMediaJudgeModelId()` (calls `ModelRoleResolver` with `role: 'judge', requireVision: true` against the real catalog) and `buildMediaCritics()` (turns a resolved judge model id into 3 `MediaJudgeEvaluator` instances, one per `MediaCriticRole`, or an explicit unavailable-reason when resolution fails). Both production call sites (`capabilities-routes.ts`, `chat-request-processor.ts`) call `buildMediaCritics()` and pass its output straight into `MediaConsensusStrategy`'s existing `critics` constructor field — no change to `MediaConsensusStrategy`'s judging logic itself, which already works correctly once `critics` is non-empty (verified by reading `reconcileCriticResults`/`pickBestCandidate`). A new `qualityJudgingUnavailableReason` field threads from `MediaConsensusResult` through `MediaPlannerStrategy`'s per-turn audit record so a missing vision judge is visible in the persisted `WorkflowExecution` row, not just an internal `unavailable` score.

**Tech Stack:** TypeScript, Vitest, existing `ModelRoleResolver` / `MediaJudgeEvaluator` / `ProviderMediaJudgeClient` / `MediaConsensusStrategy` / `MediaPlannerStrategy` infrastructure (Part 1 + Part 2 of LOTE AT, already merged and tested).

**Important scope note (read before starting):** this plan implements **Section A only** of `docs/superpowers/specs/2026-09-23-media-planner-completion-design.md`. Section 0's cross-cutting testing/rollout policy applies: every task below uses mocked providers, zero cost. Task 11 (the real-money validation batch) is written up for reference but is explicitly **not** part of the task list an agent executes automatically — it requires the user's explicit go-ahead first.

---

## Verified-against-code corrections to the spec

The spec at `docs/superpowers/specs/2026-09-23-media-planner-completion-design.md` (Section A) was re-verified line-by-line against the current worktree before writing this plan. Two things the spec did not spell out, resolved here by reading the actual code:

1. **Neither `MediaJudgeEvaluator` nor `MediaConsensusStrategy` ever calls `ModelRoleResolver` itself.** `MediaJudgeEvaluatorConfig.judgeModelId` is a plain static string field (see `api/src/core/orchestration/strategies/evaluation/media-judge-evaluator.types.ts:24-40`). The existing text-judge production pattern (`consensus-execution-planner.ts` → `consensus-strategy.ts`'s `judgeModelOverride`) resolves the judge model **upstream**, once, before constructing the evaluator. This plan follows that same shape: a new `resolveMediaJudgeModelId()` helper (Task 3) is called once per request at the two `MediaConsensusStrategy` construction sites, and its result is baked into each critic's static `judgeModelId` at construction time — not re-resolved per critic, per candidate, or via `EvaluatorInput.judgeModelOverride` (that override path exists for the text judge's plan-driven flow and is intentionally left untouched).
2. **The spec's exact citation `media-planner-strategy.ts:338-372` is close but not exact.** The real cost-accounting + cost-ceiling code (`totalJudgeCostUsd += ...`, the ceiling check) spans lines 332-377 in the current file (verified below); the ceiling check itself (the `if` that sets `stopReason = 'cost_ceiling_exhausted'`) is at line 373-375, not 338-372. Task 7 below cites the corrected line numbers.
3. **The spec's "add the 3-critic reconciliation test" is already done.** `media-consensus-strategy.test.ts:157-178` ("runs multiple critics independently and reconciles their scores") already exercises `reconcileCriticResults`/`pickBestCandidate` with 3 mocked critics and distinct scores. No new unit test is needed for that specific case — Task 10 below instead adds the missing piece: an integration test using the **real** `MediaJudgeEvaluator` class (not a hand-rolled fake `StrategyOutputEvaluator`), so the wiring between `MediaJudgeEvaluator` → `ProviderMediaJudgeClient` → `reconcileCriticResults` is actually exercised end-to-end (mocked at the provider-adapter boundary only).
4. **`media-planner-strategy.test.ts` lives at `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`**, not directly under `strategies/` as a bare relative citation might suggest — confirmed by directory listing. All test file paths below use the verified `__tests__/` subdirectory.
5. **`totalJudgeCostUsd` already reads real provider pricing** — confirmed by reading `provider-media-judge-client.ts:137-152`, which computes `costUsd` via `resolved.adapter.calculateCost(...)` (the same real per-adapter cost calculator every other provider call in this codebase uses), not a stub. Task 7 is therefore a **verification test**, not a bug fix — see its notes.
6. **`generate_media`'s call site in `chat-request-processor.ts` is not gated by `MEDIA_PLANNER_ENABLED`** (that flag only gates the `POST /v1/capabilities/media-plan/execute` route via `resolveMediaPlanRouting`). Wiring real, paid critics into `generate_media` unconditionally the moment this plan merges would be a live cost/behavior change for every caller of that tool, which conflicts with Section 0's "no real-money batch runs silently" spirit even though Section A's text doesn't explicitly call for a flag here. This plan adds one: `config.mediaPlanner.judgeEnabled`, defaulting to `false` (Task 2), gating **both** call sites identically. This is a deliberate, minimal deviation from the spec's literal text, flagged here rather than silently added.

---

## Task 1: `requireVision` hard filter in `ModelRoleResolver`

**Files:**
- Modify: `api/src/core/orchestration/model-selection/model-role-types.ts:57-71` (add `requireVision` to `RoleConstraints`)
- Modify: `api/src/core/orchestration/model-selection/model-role-resolver.ts:716-730` (add the filter, right after the existing `requireJsonOutput` block)
- Test: `api/src/core/orchestration/model-selection/__tests__/model-role-resolver.judge.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `api/src/core/orchestration/model-selection/__tests__/model-role-resolver.judge.test.ts`, inside the existing `describe('ModelRoleResolver — judge', ...)` block, right before its closing `});` (currently line 141):

```typescript
  it('excludes non-vision models when requireVision=true', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'media-consensus',
      role: 'judge',
      candidatePool: [
        makeCandidate({
          id: 'text-only',
          model: makeModel({
            id: 'text-only',
            provider: 'p1',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
          }),
        }),
        makeCandidate({
          id: 'vision-capable',
          model: makeModel({
            id: 'vision-capable',
            provider: 'p2',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation', 'vision'] as ModelCapability[],
          }),
        }),
      ],
      constraints: { requireVision: true },
    });
    expect(r.selected[0]?.model.id).toBe('vision-capable');
    expect(
      r.rejected.some(
        (rej) => rej.modelId === 'text-only' && rej.reason === 'vision_not_supported'
      )
    ).toBe(true);
  });

  it('does not filter on vision when requireVision is unset (default, unchanged behavior)', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'media-consensus',
      role: 'judge',
      candidatePool: [
        makeCandidate({
          id: 'text-only',
          model: makeModel({
            id: 'text-only',
            provider: 'p1',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
          }),
        }),
      ],
      constraints: {},
    });
    expect(r.rejected.some((rej) => rej.reason === 'vision_not_supported')).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/model-selection/__tests__/model-role-resolver.judge.test.ts`
Expected: FAIL — `text-only` is not rejected with `vision_not_supported` (the constraint is silently ignored today because `RoleConstraints` has no `requireVision` field yet and no filter reads it).

- [ ] **Step 3: Add `requireVision` to `RoleConstraints`**

In `api/src/core/orchestration/model-selection/model-role-types.ts`, in the `RoleConstraints` interface (currently lines 57-71), add the new field immediately after `requireJsonOutput`:

```typescript
export interface RoleConstraints {
  readonly maxCostUsd?: number;
  readonly maxLatencyMs?: number;
  readonly minContextWindow?: number;
  readonly requiredCapabilities?: readonly (ModelCapability | string)[];
  readonly preferredCapabilities?: readonly (ModelCapability | string)[];
  readonly requireJsonOutput?: boolean;
  /** Hard filter: excludes any candidate lacking vision/multimodal input
   *  support. Set by callers (e.g. `MediaJudgeEvaluator`'s wiring) that are
   *  about to hand the judge base64 image/video frames — a judge that
   *  can't see the frames must never be silently substituted with a
   *  text-only model. Reuses the `'vision'` capability tag that
   *  `inferModelCapabilities` (services/model-capability-inference.ts)
   *  already derives from real input-modality metadata
   *  (`extractModelModalities`, populated at catalog-discovery time). */
  readonly requireVision?: boolean;
  readonly allowLocal?: boolean;
  readonly preferLocal?: boolean;
  readonly requireLocal?: boolean;
  readonly excludeModelIds?: readonly string[];
  readonly excludeProviderIds?: readonly string[];
  /** How many candidates to return. If unset, role-default applies. */
  readonly count?: number;
}
```

- [ ] **Step 4: Add the filter in `ModelRoleResolver.resolve()`**

In `api/src/core/orchestration/model-selection/model-role-resolver.ts`, insert a new block immediately after the existing `requireJsonOutput` if/else-if/else chain closes (after the `}` that currently ends at line 728, before the `// Rank + pick.` comment at line 730):

```typescript
    // 10. Role-specific: judge requires vision/multimodal input support
    //     when the caller is about to hand it base64 image/video frames
    //     (MediaJudgeEvaluator's visual-media path). Hard filter,
    //     independent of requireJsonOutput. Deliberately recorded under
    //     the SAME 'role_specific' trace stage as requireJsonOutput
    //     (not a new FilterStage) — this is one narrow addition and
    //     adding a new stage would require updating TraceBuilder.build()'s
    //     hardcoded stage list for no added clarity.
    if (input.constraints.requireVision) {
      trace.addCriterion('requireVision=true');
      pool = applyFilter({ ...ctx, pool }, 'role_specific', (c) =>
        modelHasCapability(c.model, 'vision')
          ? { ok: true }
          : { ok: false, reason: 'vision_not_supported' }
      );
    }

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/model-selection/__tests__/model-role-resolver.judge.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones and the 4 pre-existing ones).

- [ ] **Step 6: Run the full model-role-resolver test suite (regression check)**

Run: `cd api && npx vitest run src/core/orchestration/model-selection/__tests__/`
Expected: PASS — confirms the new filter doesn't change behavior for any other role or for judge resolution when `requireVision` is unset.

- [ ] **Step 7: Commit**

```bash
git add api/src/core/orchestration/model-selection/model-role-types.ts \
        api/src/core/orchestration/model-selection/model-role-resolver.ts \
        api/src/core/orchestration/model-selection/__tests__/model-role-resolver.judge.test.ts
git commit -m "feat(model-role-resolver): add requireVision hard filter for judge role"
```

---

## Task 2: Media-judge configuration values

**Files:**
- Modify: `api/src/config/index.ts:1102-1114`

- [ ] **Step 1: Add the new config fields**

In `api/src/config/index.ts`, extend the existing `mediaPlanner` block (currently lines 1102-1114):

```typescript
  // LOTE AT (Part 2) — MediaPlannerStrategy. `enabled` defaults false: the
  // entire pathway is unreachable until this is explicitly turned on (see
  // `resolveMediaPlanRouting` in
  // core/orchestration/strategies/media-planner-gate.ts, the single choke
  // point that reads this flag). `maxTurns` and `costCeilingMultiplier` are
  // PROVISIONAL defaults per the architecture's §8 — real product/cost
  // decisions still pending; exposed as env vars so they can be tuned
  // without a code change.
  //
  // `judgeEnabled` (Section A of the completion spec, 2026-09-23) gates
  // whether real MediaJudgeEvaluator critics get wired into
  // MediaConsensusStrategy at BOTH production call sites
  // (capabilities-routes.ts's media-plan/execute route AND
  // chat-request-processor.ts's generate_media tool). Defaults false: the
  // generate_media tool is NOT gated by `enabled` above (it's a standalone
  // chat tool, reachable regardless of the planner flag), so this is the
  // only switch standing between merging this code and it making real,
  // paid judge-model calls in production — must be turned on deliberately.
  mediaPlanner: {
    enabled: getEnvBoolean('MEDIA_PLANNER_ENABLED', false),
    maxTurns: getEnvNumber('MEDIA_PLANNER_MAX_TURNS', 3),
    costCeilingMultiplier: getEnvNumber('MEDIA_PLANNER_COST_CEILING_MULTIPLIER', 3),
    judgeEnabled: getEnvBoolean('MEDIA_PLANNER_JUDGE_ENABLED', false),
    judgeMaxCostUsd: getEnvNumber('MEDIA_PLANNER_JUDGE_MAX_COST_USD', 0.02),
    judgeTimeoutMs: getEnvNumber('MEDIA_PLANNER_JUDGE_TIMEOUT_MS', 15000),
    judgeRubricVersion: getEnv('MEDIA_PLANNER_JUDGE_RUBRIC_VERSION', 'media-judge-v1'),
  },
```

- [ ] **Step 2: Verify the config module still compiles and loads**

Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors. (This config object's shape isn't yet consumed anywhere — Tasks 4, 8, 9 add the consumers — so there is no runtime test for this step in isolation; the compile check is the verification.)

- [ ] **Step 3: Commit**

```bash
git add api/src/config/index.ts
git commit -m "feat(config): add MEDIA_PLANNER_JUDGE_* env vars for media-judge critics"
```

---

## Task 3: `resolveMediaJudgeModelId()` helper

**Files:**
- Create: `api/src/core/orchestration/strategies/evaluation/media-judge-model-resolution.ts`
- Test: `api/src/core/orchestration/strategies/evaluation/__tests__/media-judge-model-resolution.test.ts`

This resolves a real, vision-capable judge model id against the catalog, reusing the existing `buildConsensusRoleSpecificCandidatePools` judge-pool builder (already used in production by `chat-request-processor.ts`'s `computeConsensusPlanAndFingerprint`) rather than the full `ConsensusExecutionPlanner`/`ConsensusPlanDryRunService` stack — that stack additionally requires a live `ChatRequest`, the provider-operability hub, and multi-role (participant/synthesizer) resolution, none of which a judge-only lookup needs. This keeps the helper small and independently testable.

- [ ] **Step 1: Write the failing test**

Create `api/src/core/orchestration/strategies/evaluation/__tests__/media-judge-model-resolution.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveMediaJudgeModelId } from '../media-judge-model-resolution';
import type { Model } from '@/types';

function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    providerId: overrides.providerId ?? `provider-${overrides.id}`,
    provider: overrides.provider ?? `provider-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    contextWindow: overrides.contextWindow ?? 64000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    inputCostPer1k: overrides.inputCostPer1k ?? 0.001,
    outputCostPer1k: overrides.outputCostPer1k ?? 0.002,
    capabilities: overrides.capabilities ?? ['chat', 'text_generation'],
    performance: overrides.performance ?? {
      latencyMs: 1000,
      throughput: 100,
      quality: 0.9,
      reliability: 0.95,
    },
    status: overrides.status ?? 'active',
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
    metadata: overrides.metadata,
  };
}

describe('resolveMediaJudgeModelId', () => {
  it('returns the id of a vision-capable, active chat model from the catalog', async () => {
    const listCatalogModels = vi.fn().mockResolvedValue([
      makeModel({ id: 'text-only-judge', capabilities: ['chat', 'text_generation'] }),
      makeModel({
        id: 'vision-judge',
        capabilities: ['chat', 'text_generation', 'vision'],
      }),
    ]);

    const modelId = await resolveMediaJudgeModelId({ listCatalogModels });
    expect(modelId).toBe('vision-judge');
  });

  it('returns undefined when no vision-capable chat model exists in the catalog', async () => {
    const listCatalogModels = vi.fn().mockResolvedValue([
      makeModel({ id: 'text-only-judge', capabilities: ['chat', 'text_generation'] }),
    ]);

    const modelId = await resolveMediaJudgeModelId({ listCatalogModels });
    expect(modelId).toBeUndefined();
  });

  it('returns undefined when the catalog is empty', async () => {
    const listCatalogModels = vi.fn().mockResolvedValue([]);
    const modelId = await resolveMediaJudgeModelId({ listCatalogModels });
    expect(modelId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/__tests__/media-judge-model-resolution.test.ts`
Expected: FAIL — the module `../media-judge-model-resolution` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `api/src/core/orchestration/strategies/evaluation/media-judge-model-resolution.ts`:

```typescript
/**
 * resolveMediaJudgeModelId — resolves a real, vision-capable judge model
 * against the live catalog, via `ModelRoleResolver`'s `role: 'judge'`
 * resolution with `requireVision: true` (Section A of the MediaPlanner
 * completion design, 2026-09-23).
 *
 * Deliberately does NOT reuse `ConsensusExecutionPlanner` /
 * `ConsensusPlanDryRunService` — that stack additionally requires a live
 * `ChatRequest`, participant/synthesizer resolution, and the provider
 * operability hub, none of which a judge-only lookup needs. Instead this
 * reuses the SAME judge-pool builder
 * (`buildConsensusRoleSpecificCandidatePools`) already used in production
 * by `chat-request-processor.ts`'s `computeConsensusPlanAndFingerprint`,
 * then wraps each `Model` into the `ModelCandidate` shape the resolver
 * expects with conservative "assume healthy" defaults — the same
 * fallback the real consensus stack uses when the operability hub is
 * unreachable (see `consensus-plan-dry-run-service.ts`'s `wrapAsCandidate`
 * doc comment) — so this narrow lookup doesn't pull in the operability
 * hub as a dependency.
 */
import { getAllCatalogModels } from '@/services/model-catalog-service';
import { buildConsensusRoleSpecificCandidatePools } from '@/core/orchestration/model-selection/role-specific-candidate-pool-builder';
import { ModelRoleResolver, isLocalProvider } from '@/core/orchestration/model-selection/model-role-resolver';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';
import type { Model } from '@/types';

export interface MediaJudgeModelResolutionDeps {
  readonly resolver?: ModelRoleResolver;
  /** Defaults to the real `getAllCatalogModels()` singleton. Overridden
   *  in tests to avoid touching the DB/catalog cache. */
  readonly listCatalogModels?: () => Promise<readonly Model[]>;
}

function wrapJudgeCandidate(model: Model): ModelCandidate {
  return {
    model,
    providerId: model.provider,
    providerHealthy: true,
    hasCredits: true,
    rateLimited: false,
    isLocal: isLocalProvider(model.provider),
    estimatedCostPerCallUsd:
      Math.max(0, model.inputCostPer1k ?? 0) + Math.max(0, model.outputCostPer1k ?? 0),
  };
}

/**
 * Resolves one vision-capable judge model id from the live catalog, or
 * `undefined` when none satisfies the resolver's judge-role filters
 * (capability, health, credits, context window, requireJsonOutput,
 * requireVision). Never fabricates a fallback model id.
 */
export async function resolveMediaJudgeModelId(
  deps: MediaJudgeModelResolutionDeps = {}
): Promise<string | undefined> {
  const resolver = deps.resolver ?? new ModelRoleResolver();
  const listCatalogModels = deps.listCatalogModels ?? getAllCatalogModels;

  const pools = await buildConsensusRoleSpecificCandidatePools({
    catalog: { listCatalogModels },
  });
  const candidatePool = (pools.judgePool ?? []).map(wrapJudgeCandidate);

  const result = await resolver.resolve({
    taskProfile: {},
    strategyName: 'media-consensus',
    role: 'judge',
    candidatePool,
    constraints: { requireJsonOutput: true, requireVision: true, count: 1 },
  });

  return result.selected[0]?.model.id;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/__tests__/media-judge-model-resolution.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/evaluation/media-judge-model-resolution.ts \
        api/src/core/orchestration/strategies/evaluation/__tests__/media-judge-model-resolution.test.ts
git commit -m "feat(media-judge): add resolveMediaJudgeModelId helper"
```

---

## Task 4: `buildMediaCritics()` factory

**Files:**
- Create: `api/src/core/orchestration/strategies/media-critics-factory.ts`
- Test: `api/src/core/orchestration/strategies/__tests__/media-critics-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `api/src/core/orchestration/strategies/__tests__/media-critics-factory.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildMediaCritics } from '../media-critics-factory';
import { MEDIA_CRITIC_ROLES } from '../evaluation/media-judge-evaluator.types';
import type { ProviderRegistry } from '@/providers/provider-registry';

function fakeRegistry(): ProviderRegistry {
  return {} as ProviderRegistry;
}

describe('buildMediaCritics', () => {
  it('returns 3 critics (one per MediaCriticRole) when a judge model resolves', async () => {
    const resolveMediaJudgeModelId = vi.fn().mockResolvedValue('vision-judge-model');
    const result = await buildMediaCritics({
      providerRegistry: fakeRegistry(),
      resolveMediaJudgeModelId,
    });

    expect(result.critics).toHaveLength(3);
    expect(result.critics.map((c) => c.role).sort()).toEqual([...MEDIA_CRITIC_ROLES].sort());
    expect(result.qualityJudgingUnavailableReason).toBeUndefined();
    for (const critic of result.critics) {
      expect(critic.evaluator.mode).toBe('llm_judge');
    }
  });

  it('returns empty critics + a labeled reason when no vision-capable judge model resolves', async () => {
    const resolveMediaJudgeModelId = vi.fn().mockResolvedValue(undefined);
    const result = await buildMediaCritics({
      providerRegistry: fakeRegistry(),
      resolveMediaJudgeModelId,
    });

    expect(result.critics).toEqual([]);
    expect(result.qualityJudgingUnavailableReason).toBe(
      'quality judging unavailable: no vision-capable judge model configured'
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-critics-factory.test.ts`
Expected: FAIL — `../media-critics-factory` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `api/src/core/orchestration/strategies/media-critics-factory.ts`:

```typescript
/**
 * buildMediaCritics — turns a resolved vision-capable judge model id into
 * 3 role-differentiated `MediaJudgeEvaluator` critics
 * (`spec_compliance` / `artifact_quality` / `tone`), ready to hand to
 * `MediaConsensusStrategy`'s `critics` constructor field. Section A of the
 * MediaPlanner completion design (2026-09-23) — this is the single piece
 * both production call sites (capabilities-routes.ts,
 * chat-request-processor.ts) import so the wiring logic exists in exactly
 * one place.
 *
 * Non-silent-degradation: when no vision-capable judge model resolves,
 * this returns an EMPTY critics array (MediaConsensusStrategy's existing,
 * tested degrade path) plus a labeled `qualityJudgingUnavailableReason` —
 * callers thread that reason into the persisted plan audit trail (see
 * media-planner-strategy.ts's `qualityJudgingUnavailableReason` handling)
 * instead of letting the degrade happen invisibly.
 */
import { config } from '@/config';
import type { ProviderRegistry } from '@/providers/provider-registry';
import { MediaJudgeEvaluator } from './evaluation/media-judge-evaluator';
import { ProviderMediaJudgeClient } from './evaluation/provider-media-judge-client';
import { MEDIA_CRITIC_ROLES } from './evaluation/media-judge-evaluator.types';
import {
  resolveMediaJudgeModelId as defaultResolveMediaJudgeModelId,
  type MediaJudgeModelResolutionDeps,
} from './evaluation/media-judge-model-resolution';
import type { MediaCriticConfig } from './media-consensus-strategy';

export const QUALITY_JUDGING_UNAVAILABLE_REASON =
  'quality judging unavailable: no vision-capable judge model configured';

export interface MediaCriticsFactoryDeps extends MediaJudgeModelResolutionDeps {
  readonly providerRegistry: ProviderRegistry;
  /** Injectable for tests; defaults to the real `resolveMediaJudgeModelId`. */
  readonly resolveMediaJudgeModelId?: (
    deps: MediaJudgeModelResolutionDeps
  ) => Promise<string | undefined>;
}

export interface MediaCriticsFactoryResult {
  readonly critics: readonly MediaCriticConfig[];
  readonly qualityJudgingUnavailableReason?: string;
}

export async function buildMediaCritics(
  deps: MediaCriticsFactoryDeps
): Promise<MediaCriticsFactoryResult> {
  const resolve = deps.resolveMediaJudgeModelId ?? defaultResolveMediaJudgeModelId;
  const judgeModelId = await resolve({
    resolver: deps.resolver,
    listCatalogModels: deps.listCatalogModels,
  });

  if (!judgeModelId) {
    return { critics: [], qualityJudgingUnavailableReason: QUALITY_JUDGING_UNAVAILABLE_REASON };
  }

  const mediaClient = new ProviderMediaJudgeClient({ registry: deps.providerRegistry });
  const critics: MediaCriticConfig[] = MEDIA_CRITIC_ROLES.map((role) => ({
    role,
    evaluator: new MediaJudgeEvaluator(
      {
        enabled: true,
        judgeModelId,
        maxCostUsd: config.mediaPlanner.judgeMaxCostUsd,
        timeoutMs: config.mediaPlanner.judgeTimeoutMs,
        rubricVersion: config.mediaPlanner.judgeRubricVersion,
        criticRole: role,
      },
      mediaClient
    ),
  }));

  return { critics };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-critics-factory.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/media-critics-factory.ts \
        api/src/core/orchestration/strategies/__tests__/media-critics-factory.test.ts
git commit -m "feat(media-critics): add buildMediaCritics factory"
```

---

## Task 5: `qualityJudgingUnavailableReason` on `MediaConsensusStrategy`

**Files:**
- Modify: `api/src/core/orchestration/strategies/media-consensus-strategy.ts:153-187, 248-256`
- Test: `api/src/core/orchestration/strategies/media-consensus-strategy.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `api/src/core/orchestration/strategies/media-consensus-strategy.test.ts`, in a new `describe` block appended at the end of the file (after the existing suites):

```typescript
describe('MediaConsensusStrategy — qualityJudgingUnavailableReason passthrough', () => {
  it('echoes the constructor-supplied reason on every result, even with critics: []', async () => {
    const images: ImageResult[] = [
      { images: [{ b64_json: 'aW1hZ2Utb25l' }], modelUsed: 'm', provider: 'p', durationMs: 5 },
    ];
    const imagesService = fakeImagesService(images);
    const strategy = new MediaConsensusStrategy({
      imagesService,
      candidateCount: 1,
      qualityJudgingUnavailableReason:
        'quality judging unavailable: no vision-capable judge model configured',
    });

    const result = await strategy.execute(baseRequest({ candidateCount: 1 }));

    expect(result.qualityJudgingUnavailableReason).toBe(
      'quality judging unavailable: no vision-capable judge model configured'
    );
  });

  it('is undefined when the constructor does not supply one (default, unchanged behavior)', async () => {
    const images: ImageResult[] = [
      { images: [{ b64_json: 'aW1hZ2Utb25l' }], modelUsed: 'm', provider: 'p', durationMs: 5 },
    ];
    const imagesService = fakeImagesService(images);
    const strategy = new MediaConsensusStrategy({ imagesService, candidateCount: 1 });

    const result = await strategy.execute(baseRequest({ candidateCount: 1 }));

    expect(result.qualityJudgingUnavailableReason).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/media-consensus-strategy.test.ts -t "qualityJudgingUnavailableReason"`
Expected: FAIL — `MediaConsensusStrategy`'s constructor has no `qualityJudgingUnavailableReason` dep, and `MediaConsensusResult` has no such field (TypeScript error on the test file itself, and/or `result.qualityJudgingUnavailableReason` is `undefined` in both cases).

- [ ] **Step 3: Add the field**

In `api/src/core/orchestration/strategies/media-consensus-strategy.ts`, update `MediaConsensusResult` (currently lines 153-171):

```typescript
export interface MediaConsensusResult {
  readonly bestCandidateIndex: number | undefined;
  readonly bestArtifact: AilinArtifact | undefined;
  /** Full audit trail — every candidate generated, gated, and judged. Feeds
   *  the persisted plan artifact described in the architecture's §3.3. */
  readonly candidates: readonly MediaCandidateRecord[];
  /** Billable judge-call cost across all critics and all candidates.
   *  Generation cost is not tracked here — every media-generation result in
   *  this codebase reports `cost_usd=0` uniformly today (see
   *  `AilinArtifact.cost_usd` doc comment); this is a pre-existing gap, not
   *  one introduced by this strategy. */
  readonly totalJudgeCostUsd: number;
  readonly totalDurationMs: number;
  /** True when every candidate was an outlier (gate failure, generation
   *  failure, or a `fail` verdict) and the "best" pick is a degraded
   *  fallback rather than a validated winner. */
  readonly degraded: boolean;
  readonly degradedReason?: string;
  /** Section A (2026-09-23) non-silent-degradation requirement: set by the
   *  caller (`buildMediaCritics`) when it could not resolve a
   *  vision-capable judge model to wire critics with. Independent of
   *  `degraded` — this can be set even when candidates pass gating and one
   *  is still picked (deterministically, without judge input); it exists so
   *  the persisted plan audit trail can say WHY quality judging didn't run,
   *  rather than a caller having to infer it from an empty `criticResults`
   *  array on every candidate. */
  readonly qualityJudgingUnavailableReason?: string;
}
```

Update the constructor (currently lines 173-187):

```typescript
export class MediaConsensusStrategy {
  private readonly critics: readonly MediaCriticConfig[];
  private readonly candidateCount: number;
  private readonly qualityJudgingUnavailableReason?: string;

  constructor(
    private readonly deps: {
      readonly videoService?: VideoOrchestrationService;
      readonly imagesService?: ImagesOrchestrationService;
      readonly critics?: readonly MediaCriticConfig[];
      readonly candidateCount?: number;
      readonly qualityJudgingUnavailableReason?: string;
    } = {}
  ) {
    this.critics = deps.critics ?? [];
    this.candidateCount = deps.candidateCount ?? MEDIA_CONSENSUS_DEFAULT_CANDIDATE_COUNT;
    this.qualityJudgingUnavailableReason = deps.qualityJudgingUnavailableReason;
  }
```

Update the `execute()` return (currently lines 248-256):

```typescript
    return {
      bestCandidateIndex: best?.index,
      bestArtifact: best?.artifact,
      candidates,
      totalJudgeCostUsd,
      totalDurationMs: Date.now() - startTime,
      degraded,
      degradedReason: degraded ? 'all_candidates_outliers' : undefined,
      qualityJudgingUnavailableReason: this.qualityJudgingUnavailableReason,
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/media-consensus-strategy.test.ts`
Expected: PASS — all tests in the file, including the 2 new ones (verifies no regression on the full suite, since this file is also where Task 10's integration tests will live).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/media-consensus-strategy.ts \
        api/src/core/orchestration/strategies/media-consensus-strategy.test.ts
git commit -m "feat(media-consensus): add qualityJudgingUnavailableReason passthrough"
```

---

## Task 6: Thread `qualityJudgingUnavailableReason` into the persisted plan audit trail

**Files:**
- Modify: `api/src/core/orchestration/strategies/media-planner-types.ts:67-75, 174-181`
- Modify: `api/src/core/orchestration/strategies/media-planner-strategy.ts:332-364`
- Test: `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`

Design note on "the eventual `unmetConstraints[]`-adjacent turn log" (spec's phrasing): reading `media-planner-repository.ts:65-94` shows the persisted `WorkflowExecution` row stores `variables.unmetConstraints` and `stepResults: input.state.turns` as sibling fields on the SAME row — `stepResults` (the turn-by-turn log) is what's "adjacent to" `unmetConstraints[]`. This task makes the reason show up in `state.turns` (via `PlannerTurnOutcome`), not inside the `unmetConstraints[]` array itself, since a missing judge does not mean the planner failed to address a stated constraint — it means quality *scoring* was unavailable for a turn that otherwise succeeded. Both a structured field (for programmatic consumers) and a human-readable summary suffix (for anyone scanning the log) are added, for defense in depth.

- [ ] **Step 1: Write the failing test**

Append to `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`, as a new `describe` block after the existing `'MediaPlannerStrategy — native joint-collapse (§3.3)'` block (end of file):

```typescript
describe('MediaPlannerStrategy — quality-judging-unavailable audit note', () => {
  it('surfaces qualityJudgingUnavailableReason in the persisted turn log, not silently', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(
        chatJson({
          kind: 'generate',
          capability: 'image_generation',
          prompt: 'a red bicycle leaning on a brick wall',
        })
      )
      .mockResolvedValueOnce(
        chatJson({ kind: 'final', content: 'Here is your image.', unmetConstraints: [] })
      );

    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const consensusResult: MediaConsensusResultLike = {
      bestCandidateIndex: 0,
      bestArtifact: {
        modality: 'image',
        stage_name: 'media-plan-turn-0',
        stage_index: 0,
        url: 'https://example.test/image.png',
      },
      candidates: [{}],
      totalJudgeCostUsd: 0,
      totalDurationMs: 10,
      degraded: false,
      qualityJudgingUnavailableReason:
        'quality judging unavailable: no vision-capable judge model configured',
    };
    const mediaConsensusExecutor: MediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue(consensusResult),
    };

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor });
    const result = await strategy.execute(
      makeRequest('a red bicycle leaning on a brick wall'),
      context
    );

    const plan = result.metadata.plan as Array<{
      outcome: { type: string; summary: string; qualityJudgingUnavailableReason?: string };
    }>;
    const generationTurn = plan.find((t) => t.outcome.type === 'generation_result');
    expect(generationTurn).toBeDefined();
    expect(generationTurn?.outcome.qualityJudgingUnavailableReason).toBe(
      'quality judging unavailable: no vision-capable judge model configured'
    );
    expect(generationTurn?.outcome.summary).toContain(
      'quality judging unavailable: no vision-capable judge model configured'
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts -t "quality-judging-unavailable"`
Expected: FAIL — `PlannerTurnOutcome`'s `generation_result` variant has no `qualityJudgingUnavailableReason` field, and the strategy never reads `consensusResult.qualityJudgingUnavailableReason`.

- [ ] **Step 3: Add the field to `MediaConsensusResultLike` and `PlannerTurnOutcome`**

In `api/src/core/orchestration/strategies/media-planner-types.ts`, update `MediaConsensusResultLike` (currently lines 67-75):

```typescript
export interface MediaConsensusResultLike {
  readonly bestCandidateIndex: number | undefined;
  readonly bestArtifact?: import('@/types').AilinArtifact;
  readonly candidates: readonly unknown[];
  readonly totalJudgeCostUsd: number;
  readonly totalDurationMs: number;
  readonly degraded: boolean;
  readonly degradedReason?: string;
  /** Structural mirror of Part 1's `MediaConsensusResult.qualityJudgingUnavailableReason`
   *  (Section A, 2026-09-23) — see that file's doc comment. */
  readonly qualityJudgingUnavailableReason?: string;
}
```

Update the `generation_result` variant of `PlannerTurnOutcome` (currently lines 174-181):

```typescript
  | {
      readonly type: 'generation_result';
      readonly capability: MediaGenerationCapability;
      readonly success: boolean;
      readonly summary: string;
      readonly degraded?: boolean;
      readonly hasArtifact: boolean;
      readonly qualityJudgingUnavailableReason?: string;
    }
```

- [ ] **Step 4: Read and update the generation-turn push in `MediaPlannerStrategy.execute()`**

In `api/src/core/orchestration/strategies/media-planner-strategy.ts`, replace the `state.turns.push(...)` call for the `generate` action (currently lines 349-364):

```typescript
        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'generation_result',
            capability: action.capability,
            success: !consensusResult.degraded,
            summary: [
              consensusResult.degraded
                ? `degraded: ${consensusResult.degradedReason ?? 'all candidates failed'}`
                : `best candidate #${consensusResult.bestCandidateIndex} selected from ${consensusResult.candidates.length} generated`,
              consensusResult.qualityJudgingUnavailableReason,
            ]
              .filter((part): part is string => Boolean(part))
              .join(' — '),
            degraded: consensusResult.degraded,
            hasArtifact: Boolean(consensusResult.bestArtifact),
            ...(consensusResult.qualityJudgingUnavailableReason
              ? { qualityJudgingUnavailableReason: consensusResult.qualityJudgingUnavailableReason }
              : {}),
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: consensusResult.totalJudgeCostUsd,
        });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`
Expected: PASS — all tests in the file, including the new one and the pre-existing "happy path" test (which asserts `summary` via `toHaveBeenCalledTimes`/`toMatchObject`, not an exact `summary` string, so appending an optional suffix does not break it — verify this by reading the diff of the "happy path" test's assertions before/after if in doubt).

- [ ] **Step 6: Commit**

```bash
git add api/src/core/orchestration/strategies/media-planner-types.ts \
        api/src/core/orchestration/strategies/media-planner-strategy.ts \
        api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts
git commit -m "feat(media-planner): surface qualityJudgingUnavailableReason in persisted turn log"
```

---

## Task 7: Cost-ceiling test (verification, not a fix)

**Files:**
- Test: `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`

Per the corrected citation above, the relevant code in `media-planner-strategy.ts` is:
- Line 344: `totalJudgeCostUsd += consensusResult.totalJudgeCostUsd;`
- Lines 345-347: `baselineCallCostUsd` is set to the first non-zero judge cost observed.
- Lines 373-375: the ceiling check — `if (baselineCallCostUsd > 0 && totalJudgeCostUsd > costCeilingMultiplier * baselineCallCostUsd) { stopReason = 'cost_ceiling_exhausted'; break; }`.

This is already correct, real logic (confirmed by reading `provider-media-judge-client.ts:137-152`, which computes `costUsd` via the real per-adapter `calculateCost`, not a stub — once Tasks 4/8/9 wire real critics, `consensusResult.totalJudgeCostUsd` will be genuinely non-zero in production). This task adds the missing regression test that forces the ceiling to trip, using the existing `MediaConsensusExecutor` test double pattern — no production code changes.

- [ ] **Step 1: Write the failing test**

Append to `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`, inside a new `describe` block:

```typescript
describe('MediaPlannerStrategy — cost ceiling', () => {
  it('stops with cost_ceiling_exhausted once judge cost exceeds costCeilingMultiplier × the first turn\'s cost', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(
        chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'image one' })
      )
      .mockResolvedValueOnce(
        chatJson({ kind: 'generate', capability: 'image_generation', prompt: 'image two' })
      )
      // A 3rd turn would only be reached if the ceiling failed to trip.
      .mockResolvedValueOnce(
        chatJson({ kind: 'final', content: 'done', unmetConstraints: [] })
      );

    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    // Turn 0: baseline judge cost = $0.01. Turn 1: $0.05 — with the default
    // costCeilingMultiplier of 3, total ($0.06) > 3 × $0.01 ($0.03), so the
    // ceiling must trip AFTER turn 1, before a 3rd planner call happens.
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        bestCandidateIndex: 0,
        bestArtifact: { modality: 'image', stage_name: 'media-plan-turn-0', stage_index: 0, url: 'https://example.test/1.png' },
        candidates: [{}],
        totalJudgeCostUsd: 0.01,
        totalDurationMs: 5,
        degraded: false,
      } satisfies MediaConsensusResultLike)
      .mockResolvedValueOnce({
        bestCandidateIndex: 0,
        bestArtifact: { modality: 'image', stage_name: 'media-plan-turn-1', stage_index: 1, url: 'https://example.test/2.png' },
        candidates: [{}],
        totalJudgeCostUsd: 0.05,
        totalDurationMs: 5,
        degraded: false,
      } satisfies MediaConsensusResultLike);
    const mediaConsensusExecutor: MediaConsensusExecutor = { execute };

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor, maxTurns: 5 });
    const result = await strategy.execute(makeRequest('two images please'), context);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(invokerChat).toHaveBeenCalledTimes(2);
    expect(result.metadata.stopReason).toBe('cost_ceiling_exhausted');
    expect(result.metadata.unmetConstraints).toContain(
      'planner stopped: cost ceiling exhausted before a final response was produced'
    );
    expect(result.totalCost).toBeCloseTo(0.06, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts -t "cost ceiling"`
Expected: this SHOULD already pass if the reading above is correct — run it first to confirm. If it fails, the failure diagnoses a real bug in the existing ceiling logic (not expected, but this is the point of writing the test: prove it, don't assume it).

- [ ] **Step 3: If it failed, diagnose before changing anything**

Per `superpowers:systematic-debugging` — if Step 2 surprises you with a failure, do not immediately patch `media-planner-strategy.ts`. Re-read lines 332-377 fresh, check whether `baselineCallCostUsd` is being set from the correct turn, and whether `costCeilingMultiplier` default (3, from `config.mediaPlanner.costCeilingMultiplier` / `MediaPlannerDeps.costCeilingMultiplier`) matches this test's arithmetic ($0.06 > 3 × $0.01). Fix only the actual root cause found, then re-run.

- [ ] **Step 4: Confirm it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`
Expected: PASS — full file, no regressions.

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts
git commit -m "test(media-planner): prove costCeilingMultiplier actually stops the loop"
```

---

## Task 8: Wire critics into `capabilities-routes.ts`

**Files:**
- Modify: `api/src/routes/capabilities/capabilities-routes.ts:2234-2266` (and add one import near the top of the file, alongside the existing `getProviderRegistry` import)
- Test: Create `api/src/routes/capabilities/__tests__/media-plan-execute-critics-wiring.test.ts`

This follows the existing Fastify route-test harness in `api/src/routes/capabilities/__tests__/agentic-sandbox-dispatch.test.ts` (auth-middleware mock + `Fastify()` + `registerCapabilitiesRoutes(server)` + `server.inject(...)`), combined with the `MediaConsensusStrategy` constructor-capture pattern from `api/src/services/__tests__/generate-media-tool-media-consensus.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `api/src/routes/capabilities/__tests__/media-plan-execute-critics-wiring.test.ts`:

```typescript
/**
 * Route-level wiring test: `POST /v1/capabilities/media-plan/execute` must
 * construct `MediaConsensusStrategy` with the critics `buildMediaCritics()`
 * returns, when `MEDIA_PLANNER_JUDGE_ENABLED` is on (Section A, 2026-09-23).
 *
 * IMPORTANT: `config` (`api/src/config/index.ts:630`) is
 * `deepFreeze`d at module load — `config.mediaPlanner.judgeEnabled = true`
 * in a test body would throw (or silently no-op) rather than take effect.
 * The env var MUST be set BEFORE `@/config` (and anything that imports it,
 * including `capabilities-routes.ts`) is first imported by this process.
 * This file therefore sets `process.env.MEDIA_PLANNER_JUDGE_ENABLED` and
 * `process.env.MEDIA_PLANNER_ENABLED` at the very top, before any import —
 * it only ever exercises the "enabled" path. The "disabled" (default)
 * path — `critics` staying `[]`, `buildMediaCritics` never called — is
 * exercised by the SAME code pattern at the sibling call site in Task 9's
 * regression test, which does not need this env-var trick because that
 * test suite never sets `MEDIA_PLANNER_JUDGE_ENABLED` at all (so it keeps
 * its real default, `false`).
 */
process.env.MEDIA_PLANNER_ENABLED = 'true';
process.env.MEDIA_PLANNER_JUDGE_ENABLED = 'true';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// IMPORTANT: `createOrchestrationContext` (utils/orchestration-context.ts),
// which this route calls directly (NOT the `getUserContext`/`.userContext`
// helper other routes use), reads `extendedRequest.user` — the exact field
// the REAL `authenticate` middleware sets (auth-middleware.ts:160,236) — not
// `.userContext`. Verified by reading both files; a `.userContext`-only mock
// (the pattern `agentic-sandbox-dispatch.test.ts` uses for a DIFFERENT
// route) would leave `organizationId`/`userId` empty here.
vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
    request.user = {
      userId: 'user-media-plan-test',
      organizationId: 'org-media-plan-test',
      roles: ['user'],
      email: 'test@example.test',
      name: 'Test User',
    };
  }),
}));
vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => vi.fn().mockResolvedValue(undefined),
}));
// The route calls the REAL getAllCatalogModels() (services/model-catalog-service.ts)
// at capabilities-routes.ts:2214 to build orchestrationContext.models, BEFORE
// the media-planner gate check — unrelated to critics wiring but must be
// mocked so this test never touches the DB/catalog cache.
vi.mock('@/services/model-catalog-service', () => ({
  getAllCatalogModels: vi.fn().mockResolvedValue([]),
}));

const mockConstructorCalls: unknown[] = [];
vi.mock('@/core/orchestration/strategies/media-consensus-strategy', () => {
  class MockMediaConsensusStrategy {
    constructor(deps: unknown) {
      mockConstructorCalls.push(deps);
    }
    execute() {
      return Promise.resolve({
        bestCandidateIndex: undefined,
        bestArtifact: undefined,
        candidates: [],
        totalJudgeCostUsd: 0,
        totalDurationMs: 1,
        degraded: true,
        degradedReason: 'no_candidates',
      });
    }
  }
  return { MediaConsensusStrategy: MockMediaConsensusStrategy };
});

const buildMediaCriticsMock = vi.fn();
vi.mock('@/core/orchestration/strategies/media-critics-factory', () => ({
  buildMediaCritics: (...args: unknown[]) => buildMediaCriticsMock(...args),
}));

describe('POST /v1/capabilities/media-plan/execute — critics wiring (MEDIA_PLANNER_JUDGE_ENABLED=true)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { registerCapabilitiesRoutes } = await import('../capabilities-routes');
    server = Fastify();
    await registerCapabilitiesRoutes(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    delete process.env.MEDIA_PLANNER_ENABLED;
    delete process.env.MEDIA_PLANNER_JUDGE_ENABLED;
  });

  beforeEach(() => {
    mockConstructorCalls.length = 0;
    buildMediaCriticsMock.mockReset();
  });

  it('wires the critics + reason returned by buildMediaCritics into MediaConsensusStrategy', async () => {
    const fakeCritics = [{ role: 'spec_compliance', evaluator: { mode: 'llm_judge', id: 'x', evaluate: vi.fn() } }];
    buildMediaCriticsMock.mockResolvedValue({ critics: fakeCritics, qualityJudgingUnavailableReason: undefined });

    await server.inject({
      method: 'POST',
      url: '/v1/capabilities/media-plan/execute',
      payload: { messages: [{ role: 'user', content: 'make a video and a picture of a cat' }] },
    });

    expect(buildMediaCriticsMock).toHaveBeenCalledTimes(1);
    expect(mockConstructorCalls).toHaveLength(1);
    expect((mockConstructorCalls[0] as { critics: unknown }).critics).toBe(fakeCritics);
  });
});
```

Notes on this test's correctness, verified against the actual route handler
(`capabilities-routes.ts:2178-2266`):
- Route path and method (`POST /v1/capabilities/media-plan/execute`) and the
  exported registration function name (`registerCapabilitiesRoutes`) are
  confirmed by grepping the real `server.post<...>('/v1/capabilities/media-plan/execute', ...)` registration — no adjustment needed.
- The request text is deliberately `'make a video and a picture of a cat'`
  (not a single-capability phrase like "make a picture of a cat") because
  `evaluateMediaPlannerGate` (`media-planner-gate.ts:118-173`) only routes
  (`route: true`) when it detects MULTIPLE media-generation capabilities in
  one request, OR a single capability PLUS an explicit numeric/attribute
  constraint (duration/resolution/aspect-ratio). A single bare "make a
  picture of X" request deliberately returns `route: false` ("single
  media-generation capability with no explicit attribute constraint") — this
  test would silently 422 before ever reaching the critics-wiring code with
  the original single-capability phrasing.
- This file must run in its own Vitest worker/module graph (the default —
  Vitest isolates modules per test FILE, not per `it()`), since it mutates
  `process.env` at module scope before `@/config` is first imported. Do not
  merge this into another test file that also imports `capabilities-routes.ts`
  or `@/config` without the same env vars pre-set, or module caching could
  leak the wrong `judgeEnabled` value across files depending on run order.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/capabilities/__tests__/media-plan-execute-critics-wiring.test.ts`
Expected: FAIL — `@/core/orchestration/strategies/media-critics-factory` isn't imported/called by `capabilities-routes.ts` yet, so `buildMediaCriticsMock` is never invoked and `mockConstructorCalls[0].critics` is `undefined` (today's code passes no `critics` field at all).

- [ ] **Step 3: Wire the call site**

In `api/src/routes/capabilities/capabilities-routes.ts`, add an import near the existing `getProviderRegistry` import:

```typescript
import { buildMediaCritics } from '@/core/orchestration/strategies/media-critics-factory';
```

Replace the `MediaPlannerStrategy` construction (currently lines 2234-2266):

```typescript
      const envelope = parseEnvelope(body as CapabilityRequestBody);

      let critics: Awaited<ReturnType<typeof buildMediaCritics>>['critics'] = [];
      let qualityJudgingUnavailableReason: string | undefined;
      if (config.mediaPlanner.judgeEnabled) {
        const built = await buildMediaCritics({ providerRegistry: getProviderRegistry() });
        critics = built.critics;
        qualityJudgingUnavailableReason = built.qualityJudgingUnavailableReason;
      }

      const strategy = new MediaPlannerStrategy({
        capabilityDispatcher: (plan, capabilityBody) =>
          executeCapabilityByPlan(plan, capabilityBody, envelope, request, requestId, {
            audio: audioService,
            music: musicService,
            image: imageService,
            video: videoService,
            videoUnderstanding: videoUnderstandingService,
            search: searchService,
            moderation: moderationService,
            code: codeExecutionService,
            vision: visionService,
            pdf: pdfService,
          }),
        // `mediaConsensusExecutor`: real critics are wired via
        // `buildMediaCritics()` behind `config.mediaPlanner.judgeEnabled`
        // (Section A, 2026-09-23). When the flag is off (default) or no
        // vision-capable judge model resolves, `critics` is `[]` and
        // `MediaConsensusStrategy` degrades exactly as it did before this
        // change — see that class's own documented degrade path — with
        // `qualityJudgingUnavailableReason` surfacing WHY in the persisted
        // plan audit trail instead of silently.
        mediaConsensusExecutor: new MediaConsensusStrategy({
          videoService,
          imagesService: imageService,
          critics,
          qualityJudgingUnavailableReason,
        }),
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/routes/capabilities/__tests__/media-plan-execute-critics-wiring.test.ts`
Expected: PASS. If the route path/payload shape needed correcting in Step 1, this is where that surfaces — fix the test's request shape to match the real route contract, not the production code.

- [ ] **Step 5: Run the broader capabilities-routes test suite (regression check)**

Run: `cd api && npx vitest run src/routes/capabilities/__tests__/`
Expected: PASS — no other route test's expectations about `MediaPlannerStrategy`/`MediaConsensusStrategy` construction break.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/capabilities/capabilities-routes.ts \
        api/src/routes/capabilities/__tests__/media-plan-execute-critics-wiring.test.ts
git commit -m "feat(capabilities-routes): wire real media-judge critics behind MEDIA_PLANNER_JUDGE_ENABLED"
```

---

## Task 9: Wire critics into `chat-request-processor.ts`'s `generate_media` tool

**Files:**
- Modify: `api/src/services/chat-request-processor.ts:2831-2845` (and add a `config` import near the top of the file)
- Modify: `api/src/services/__tests__/generate-media-tool-media-consensus.test.ts` (regression guard for the default/disabled path)
- Create: `api/src/services/__tests__/generate-media-tool-critics-enabled.test.ts` (the enabled path)

**Why two test files, not one:** as discovered and explained in Task 8, `config` (`api/src/config/index.ts:630`) is `deepFreeze`d at module load, so `config.mediaPlanner.judgeEnabled` cannot be toggled between `it()` blocks by assignment — the env var must be set before `@/config` is first imported by the process. The existing `generate-media-tool-media-consensus.test.ts` never sets `MEDIA_PLANNER_JUDGE_ENABLED`, so it already exercises the real default (`false`) — it only needs one added assertion, not an env-var trick. The "enabled" case needs its own file with the env var set before any import, exactly like Task 8's route test.

- [ ] **Step 1: Write the failing tests**

First, add a regression-guard assertion to the EXISTING `api/src/services/__tests__/generate-media-tool-media-consensus.test.ts`. Add this mock near the top of the file, alongside the existing `vi.mock('@/core/orchestration/strategies/media-consensus-strategy', ...)` block (it will never be called in this file, since this file never sets `MEDIA_PLANNER_JUDGE_ENABLED`, but must be present so `chat-request-processor.ts`'s new dynamic `import('@/core/orchestration/strategies/media-critics-factory')` resolves to a mock rather than the real module in this test run):

```typescript
const buildMediaCriticsMock = vi.fn();
vi.mock('@/core/orchestration/strategies/media-critics-factory', () => ({
  buildMediaCritics: (...args: unknown[]) => buildMediaCriticsMock(...args),
}));
```

Then extend the existing test `'routes image generation through MediaConsensusStrategy.execute(), not a raw orchestration service call'` with 2 extra assertions at its end (immediately before that `it`'s closing `});`):

```typescript
    // Regression guard (Section A, 2026-09-23): MEDIA_PLANNER_JUDGE_ENABLED
    // defaults false, and this test suite never sets it — critics must stay
    // empty and buildMediaCritics must never be called.
    expect(buildMediaCriticsMock).not.toHaveBeenCalled();
    expect((mockConstructorCalls[0] as { critics: unknown[] }).critics).toEqual([]);
```

Second, create the new file `api/src/services/__tests__/generate-media-tool-critics-enabled.test.ts` for the enabled path:

```typescript
/**
 * `generate_media` tool handler — critics wiring when
 * MEDIA_PLANNER_JUDGE_ENABLED=true (Section A, 2026-09-23).
 *
 * Kept in its OWN file (not added to generate-media-tool-media-consensus.test.ts)
 * because `config` is `deepFreeze`d at module load
 * (api/src/config/index.ts:630) — the env var below must be set before
 * `@/config` (and anything importing it, including chat-request-processor.ts)
 * is first imported in this process/module graph.
 */
process.env.MEDIA_PLANNER_JUDGE_ENABLED = 'true';

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Logger } from 'pino';

const mockExecute = vi.fn();
const mockConstructorCalls: unknown[] = [];
vi.mock('@/core/orchestration/strategies/media-consensus-strategy', () => {
  class MockMediaConsensusStrategy {
    constructor(deps: unknown) {
      mockConstructorCalls.push(deps);
    }
    execute(request: unknown) {
      return mockExecute(request);
    }
  }
  return { MediaConsensusStrategy: MockMediaConsensusStrategy };
});

const buildMediaCriticsMock = vi.fn();
vi.mock('@/core/orchestration/strategies/media-critics-factory', () => ({
  buildMediaCritics: (...args: unknown[]) => buildMediaCriticsMock(...args),
}));

import { registerToolsInRegistry } from '../chat-request-processor';
import { toolRegistry } from '@/core/tools/tool-registry';

function makeLog(): Logger {
  const noop = () => undefined;
  const log = {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: () => log,
    level: 'info',
  };
  return log as unknown as Logger;
}

async function ensureToolsRegistered(): Promise<void> {
  registerToolsInRegistry();
  await vi.waitFor(() => {
    if (!toolRegistry.isInitialized()) throw new Error('tool registry not yet initialized');
  });
}

describe('generate_media tool handler — critics wiring (MEDIA_PLANNER_JUDGE_ENABLED=true)', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockConstructorCalls.length = 0;
    buildMediaCriticsMock.mockReset();
  });

  afterAll(() => {
    delete process.env.MEDIA_PLANNER_JUDGE_ENABLED;
  });

  it('wires the critics returned by buildMediaCritics into MediaConsensusStrategy', async () => {
    const fakeCritics = [
      { role: 'spec_compliance', evaluator: { mode: 'llm_judge', id: 'c1', evaluate: vi.fn() } },
      { role: 'artifact_quality', evaluator: { mode: 'llm_judge', id: 'c2', evaluate: vi.fn() } },
      { role: 'tone', evaluator: { mode: 'llm_judge', id: 'c3', evaluate: vi.fn() } },
    ];
    buildMediaCriticsMock.mockResolvedValueOnce({ critics: fakeCritics, qualityJudgingUnavailableReason: undefined });

    await ensureToolsRegistered();
    mockExecute.mockResolvedValueOnce({
      bestCandidateIndex: 0,
      bestArtifact: {
        modality: 'image',
        stage_name: 'generate_media_tool',
        stage_index: 0,
        url: 'https://example.com/best-image.png',
        provider: 'test-provider',
        model: 'test-model',
      },
      candidates: [{}, {}],
      totalJudgeCostUsd: 0.03,
      totalDurationMs: 5,
      degraded: false,
    });

    await toolRegistry.execute(
      'generate_media',
      { type: 'image', prompt: 'a red bicycle' },
      'call_critics',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1', userId: 'user_1' }
    );

    expect(buildMediaCriticsMock).toHaveBeenCalledTimes(1);
    expect(mockConstructorCalls).toHaveLength(1);
    expect((mockConstructorCalls[0] as { critics: unknown }).critics).toBe(fakeCritics);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/services/__tests__/generate-media-tool-media-consensus.test.ts src/services/__tests__/generate-media-tool-critics-enabled.test.ts`
Expected: the new file FAILS (`buildMediaCriticsMock` never called — `chat-request-processor.ts` doesn't import/call `buildMediaCritics` yet); the extended existing test also FAILS if `mockConstructorCalls[0].critics` isn't `[]` today because the field doesn't exist at all yet (`toEqual([])` vs `undefined`).

- [ ] **Step 3: Wire the call site**

In `api/src/services/chat-request-processor.ts`, add near the top (alongside the other `@/config`-adjacent imports, or with the existing import block around line 87-91):

```typescript
import { config } from '@/config';
```

Replace the `MediaConsensusStrategy` construction inside the `generate_media` tool handler (currently lines 2831-2845):

```typescript
          try {
            const { MediaConsensusStrategy } = await import(
              '@/core/orchestration/strategies/media-consensus-strategy'
            );
            const { VideoOrchestrationService: VideoSvc } = await import(
              '@/services/video-orchestration-service'
            );
            const { ImagesOrchestrationService } = await import(
              '@/services/images-orchestration-service'
            );

            let critics: Awaited<
              ReturnType<
                typeof import('@/core/orchestration/strategies/media-critics-factory').buildMediaCritics
              >
            >['critics'] = [];
            let qualityJudgingUnavailableReason: string | undefined;
            if (config.mediaPlanner.judgeEnabled) {
              const { buildMediaCritics } = await import(
                '@/core/orchestration/strategies/media-critics-factory'
              );
              const { getProviderRegistry } = await import('@/providers/provider-registry');
              const built = await buildMediaCritics({ providerRegistry: getProviderRegistry() });
              critics = built.critics;
              qualityJudgingUnavailableReason = built.qualityJudgingUnavailableReason;
            }

            const executor = new MediaConsensusStrategy({
              videoService: mediaType === 'video' ? new VideoSvc() : undefined,
              imagesService: mediaType === 'image' ? new ImagesOrchestrationService() : undefined,
              critics,
              qualityJudgingUnavailableReason,
            });
```

Leave the remainder of the handler (the `executor.execute({...})` call and everything after it) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/services/__tests__/generate-media-tool-media-consensus.test.ts src/services/__tests__/generate-media-tool-critics-enabled.test.ts`
Expected: PASS — every pre-existing test in `generate-media-tool-media-consensus.test.ts` (they never set `MEDIA_PLANNER_JUDGE_ENABLED`, so they exercise the unchanged `critics: []` default path and must keep passing byte-for-byte, now with the 2 added assertions also green), and the new file's 1 test.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/chat-request-processor.ts \
        api/src/services/__tests__/generate-media-tool-media-consensus.test.ts \
        api/src/services/__tests__/generate-media-tool-critics-enabled.test.ts
git commit -m "feat(generate-media-tool): wire real media-judge critics behind MEDIA_PLANNER_JUDGE_ENABLED"
```

---

## Task 10: Mocked-provider integration test — real critics pick by score

**Files:**
- Create: `api/src/core/orchestration/strategies/__tests__/media-consensus-real-critics-integration.test.ts`

The spec's testing section calls for an "integration (mocked provider clients, real orchestration logic)" test proving `pickBestCandidate` picks by real scores. As noted at the top of this plan, the spec's suggested unit-test citation for the 3-critic case (`media-consensus-strategy.test.ts:143,203,240`) turned out to already exist using hand-rolled fake `StrategyOutputEvaluator`s — it does not exercise the real `MediaJudgeEvaluator`/`ProviderMediaJudgeClient` wiring at all. This task fills that actual gap: a full `MediaConsensusStrategy.execute()` run using the **real** `MediaJudgeEvaluator` class, wired to a **mocked** `MediaJudgeClient` (mocking only at the provider-adapter boundary, per Section 0's testing policy — zero real cost). This proves `pickBestCandidate` picks based on genuine per-critic scores flowing through `reconcileCriticResults`, not "first candidate that passes the gate."

- [ ] **Step 1: Write the failing test**

Create `api/src/core/orchestration/strategies/__tests__/media-consensus-real-critics-integration.test.ts`:

```typescript
/**
 * Integration test (Section A, Task 10): a full MediaConsensusStrategy run
 * wired with 3 REAL MediaJudgeEvaluator instances (spec_compliance,
 * artifact_quality, tone), mocked only at the MediaJudgeClient boundary —
 * never a real provider, zero cost. Proves the real wiring (not a fake
 * StrategyOutputEvaluator) reconciles independently-scored critics and
 * `pickBestCandidate` picks the genuinely highest-scored candidate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const probeMedia = vi.fn();
vi.mock('@/services/media/ffmpeg-media-toolkit', async () => {
  const actual = await vi.importActual<typeof import('@/services/media/ffmpeg-media-toolkit')>(
    '@/services/media/ffmpeg-media-toolkit'
  );
  return { ...actual, probeMedia: (...args: unknown[]) => probeMedia(...args) };
});

import { MediaConsensusStrategy, type MediaCriticConfig } from '../media-consensus-strategy';
import { MediaJudgeEvaluator } from '../evaluation/media-judge-evaluator';
import { MEDIA_CRITIC_ROLES, type MediaJudgeClient, type MediaJudgeInput } from '../evaluation/media-judge-evaluator.types';
import type { LLMJudgeRawResult } from '../evaluation/llm-judge-evaluator.types';
import type { ImagesOrchestrationService, ImageResult } from '@/services/images-orchestration-service';
import type { OrchestrationContext } from '@/types';

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeImagesService(results: ImageResult[]): ImagesOrchestrationService {
  let call = 0;
  return {
    generateImages: vi.fn(async () => {
      const r = results[call] ?? results[results.length - 1];
      call += 1;
      return r;
    }),
  } as unknown as ImagesOrchestrationService;
}

/** Scores candidate 0 low and candidate 1 high, on every critic axis,
 *  regardless of criticRole — proves the reconciler's weighted average
 *  (not any single critic) drives the final pick. */
function makeMockMediaJudgeClient(): MediaJudgeClient {
  let call = 0;
  const scoresByCall = [0.3, 0.3, 0.3, 0.9, 0.9, 0.9]; // 3 critics × 2 candidates
  return {
    judgeMedia: vi.fn(async (input: MediaJudgeInput): Promise<LLMJudgeRawResult> => {
      const score = scoresByCall[call] ?? 0.5;
      call += 1;
      return {
        score,
        verdict: 'pass',
        confidence: 0.9,
        shortRationale: `mock rationale for ${input.criticRole}`,
        costUsd: 0.001,
      };
    }),
  };
}

describe('MediaConsensusStrategy — real MediaJudgeEvaluator critics (mocked provider boundary)', () => {
  it('reconciles 3 real critics and picks the genuinely higher-scored candidate', async () => {
    probeMedia.mockResolvedValue(undefined); // images don't need ffprobe

    const images: ImageResult[] = [
      { images: [{ b64_json: 'bG93LXNjb3Jl' }], modelUsed: 'm', provider: 'p', durationMs: 5 },
      { images: [{ b64_json: 'aGlnaC1zY29yZQ==' }], modelUsed: 'm', provider: 'p', durationMs: 5 },
    ];
    const imagesService = fakeImagesService(images);
    const mediaClient = makeMockMediaJudgeClient();

    const critics: MediaCriticConfig[] = MEDIA_CRITIC_ROLES.map((role) => ({
      role,
      evaluator: new MediaJudgeEvaluator(
        {
          enabled: true,
          judgeModelId: 'mock-vision-judge',
          maxCostUsd: 0.05,
          timeoutMs: 5000,
          rubricVersion: 'media-judge-v1',
          criticRole: role,
        },
        mediaClient
      ),
    }));

    const strategy = new MediaConsensusStrategy({ imagesService, critics, candidateCount: 2 });
    const result = await strategy.execute({
      capability: 'image_generation',
      prompt: 'a red bicycle leaning on a brick wall',
      stageName: 'gen-image',
      stageIndex: 0,
      userContext: { requestId: 'r1', models: [] } as unknown as OrchestrationContext,
      requestId: 'req-real-critics',
      candidateCount: 2,
    });

    expect(mediaClient.judgeMedia).toHaveBeenCalledTimes(6); // 3 critics × 2 candidates
    expect(result.degraded).toBe(false);
    // Candidate 1 ("high-score") must win — NOT candidate 0, which is what
    // "first that passes the gate" would incorrectly pick.
    expect(result.bestCandidateIndex).toBe(1);
    expect(result.bestArtifact?.b64_json).toBe('aGlnaC1zY29yZQ==');
    expect(result.totalJudgeCostUsd).toBeCloseTo(0.006, 5); // 6 calls × $0.001
    const winningRecord = result.candidates[1];
    expect(winningRecord.criticResults).toHaveLength(3);
    expect(winningRecord.reconciledEvaluation.score).toBeCloseTo(0.9, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or passes for the right reasons**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-consensus-real-critics-integration.test.ts`
Expected: this exercises only EXISTING, already-shipped code (`MediaConsensusStrategy`, `MediaJudgeEvaluator` — neither is modified by this plan) plus the Task 5 `qualityJudgingUnavailableReason` field (which defaults to `undefined` and isn't asserted here). It should PASS on the first run once Task 5 has landed. If it fails, treat the failure as a genuine finding about the real wiring (per `superpowers:systematic-debugging`) — do not loosen the assertions to make it pass; diagnose why `sampleFramesForCandidate`, `buildMediaJudgeContent`, or `reconcileCriticResults` produced a different result than expected, since that would mean the "already correct" reading in this plan's opening section was wrong.

- [ ] **Step 3: If needed, fix the actual root cause; otherwise proceed**

No production code change is anticipated for this task. Only touch `media-consensus-strategy.ts` / `media-judge-evaluator.ts` if Step 2 reveals a genuine defect, and if so, treat that as a new, separately-committed fix with its own explanation of what was wrong.

- [ ] **Step 4: Run the full Section-A-touched test surface (regression check)**

Run:
```bash
cd api && npx vitest run \
  src/core/orchestration/model-selection/__tests__/ \
  src/core/orchestration/strategies/evaluation/__tests__/media-judge-model-resolution.test.ts \
  src/core/orchestration/strategies/__tests__/media-critics-factory.test.ts \
  src/core/orchestration/strategies/media-consensus-strategy.test.ts \
  src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts \
  src/core/orchestration/strategies/__tests__/media-consensus-real-critics-integration.test.ts \
  src/routes/capabilities/__tests__/media-plan-execute-critics-wiring.test.ts \
  src/services/__tests__/generate-media-tool-media-consensus.test.ts \
  src/services/__tests__/generate-media-tool-critics-enabled.test.ts
```
Expected: PASS, every file, zero regressions across all of Section A's changes.

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/__tests__/media-consensus-real-critics-integration.test.ts
git commit -m "test(media-consensus): integration test proves real critics pick by score, not gate order"
```

---

## Task 11 — SEPARATE FROM THE TASK LIST ABOVE: real-money validation batch (requires user go-ahead before running — real cost)

**Do not execute this task automatically as part of implementing Tasks 1-10.** Per Section 0's cross-cutting testing policy ("any test that calls a real paid provider or a real judge model is called out explicitly ... batched, and run only after an explicit go-ahead with a cost estimate — no fixed budget ceiling, but no real-money batch runs silently"), this requires the user to explicitly approve running it, after seeing a cost estimate, once Tasks 1-10 have merged.

**What it validates:** the full chain — generate → probe → judge → reconcile → select — against a REAL video/image provider and a REAL vision-capable judge model, outside all mocks. Nothing above this line exercises a real provider call; this is the only step in Section A that does.

**How to run it (once approved):**
1. Set `MEDIA_PLANNER_JUDGE_ENABLED=true` in a scratch/staging environment only (never production without the canary rollout described in Section E of the spec, which is out of scope for this plan).
2. Point `judgeModelId` resolution at a real, confirmed vision-capable model already present in the live catalog (verify via the `resolveMediaJudgeModelId()` helper against the real `getAllCatalogModels()` in that environment, or a one-off script that calls it directly and prints the result — do not hardcode a model id).
3. Trigger ONE `generate_media` tool call (or one `POST /v1/capabilities/media-plan/execute` request) with a real, low-resolution/short-duration image or video prompt, through a real video/image provider already configured in that environment's provider registry.
4. Cost estimate template to fill in and show the user BEFORE running, using the environment's real per-call pricing:
   - N candidates generated (default `MEDIA_CONSENSUS_CANDIDATE_COUNT=2`) × 1 real generation-provider call each = 2 provider calls.
   - 3 critics × N candidates = up to 6 real judge-model calls (fewer if a candidate fails the deterministic gate before reaching a critic).
   - Total ≈ (2 × cost-per-generation-call) + (up to 6 × cost-per-judge-call). Fill in the environment's actual per-call rates before asking for go-ahead — do not guess a number here.
5. After the run, inspect the persisted `WorkflowExecution` row (via `media-planner-repository.ts`'s write path) or the tool result directly to confirm: real judge scores appear in `criticResults` (not `unavailable`), `totalJudgeCostUsd` is non-zero and matches the real provider's billed usage, and `pickBestCandidate` selected the candidate with the higher reconciled score.
6. Report the actual observed cost and outcome back to the user — do not silently repeat this batch on a schedule.
