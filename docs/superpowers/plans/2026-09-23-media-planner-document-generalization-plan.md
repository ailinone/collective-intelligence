<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# MediaPlanner — Document/PDF Generalization (Section C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `pdf_understanding` a real, role-differentiated document review instead of a single holistic analysis call: three text-only critics (`factual_accuracy`, `required_clause_presence`, `tone`) independently flag page-anchored issues in the extracted PDF text, a synthesis call reconciles them into one report grouped by page, and `MediaPlannerStrategy` routes `pdf_understanding` `capability_call` actions through this fan-out instead of returning the raw extraction untouched.

**Architecture:** Mirrors `MediaConsensusStrategy`'s independent-critic-evaluation shape (asymmetric visibility, no live debate, reconcile after the fact) but for text instead of video/image frames, and widens `EvaluationResult` with one new additive field (`issues`) so document critics can report *where* a problem is, not just an overall score. A new `DocumentReviewStrategy` fans the three critics out in parallel, then makes exactly one more LLM call — a synthesis, not a critic — to group/de-duplicate their findings by page, falling back to a deterministic (LLM-free) grouping if that call fails or returns unparseable JSON. `MediaPlannerStrategy` gets one new optional dependency (`documentReviewExecutor`) and intercepts the existing `capability_call` dispatch path for `pdf_understanding` only; every other capability's dispatch is untouched, and the interception itself degrades safely (falls through to today's raw-extraction behavior) whenever the new dependency isn't wired or the extraction result doesn't look like a PDF result.

**Tech Stack:** TypeScript, Vitest, Zod (unchanged — no schema changes to `PlannerActionSchema`), pdfkit (test fixtures only), the existing `getOrchestrationEngine()` chat-dispatch path (no new provider-call abstraction for the synthesis step).

---

## Investigation findings (done as part of writing this plan, not deferred to execution)

Every file:line citation below was re-verified against the current worktree. Two of the spec's citations do not hold and required a real design decision, documented here so the "why" isn't lost during execution.

**1. The judge schema has no `location` field. This is the spec's one factual error, not a moved line.**
The spec says (§C.2): *"Each critic returns issues with the judge schema's existing `location` field populated as a page number."* There is no such field anywhere in the judge machinery:
- `EvaluationResult` (`api/src/core/orchestration/strategies/evaluation/strategy-output-evaluator.ts:134-180`) has `score`, `verdict`, `structural`, `subScores`, `notes`, `validationStatus`, `subResults`, `confidence`, `judgeCostUsd` — no `issues`, no `location`.
- `LLMJudgeRawResult` (`llm-judge-evaluator.types.ts:22-45`) and `MediaJudgeInput`/`MediaJudgeEvaluatorConfig` (`media-judge-evaluator.types.ts`) — same, no `issues`/`location`.
- The actual judge rubric prompts (`provider-llm-judge-client.ts:60-69`, `provider-media-judge-client.ts:44-53`) ask the model for `score`/`verdict`/`confidence`/`rationale`/`subScores` only.
- The only `location` field in the whole `strategies/` tree lives in `critique-repair-strategy.ts:48` (`issues: Array<{ severity, location, description, suggested_fix }>`) — a **different, sequential-repair strategy** the spec itself says NOT to reuse ("not the single-generator/single-critic `CritiqueRepairStrategy` loop — wrong shape").

So there is nothing to "confirm" here — this plan adds a genuinely new, additive field. Task 1 below adds `DocumentCriticIssue { location: number; severity; description }` and an optional `EvaluationResult.issues?: readonly DocumentCriticIssue[]`, following the exact precedent already set by `judgeCostUsd` and `candidate` (both added additively to the same interface, per that file's own doc comments, with every existing evaluator required to ignore fields it doesn't know about).

**2. Page markers already exist — no `pdf-service.ts` extraction change is needed.**
`PDFService.assembleText()` (`api/src/services/pdf-service.ts:606-611`) already stamps `[page ${page.pageNumber}]` before every page's text and joins pages with `\n\n`. The spec's §C.2 instruction to "confirm/extend `pdf-service.ts`'s extraction to guarantee page markers are present" resolves to **confirm, not extend**: no production code change to `pdf-service.ts` is needed. Task 4 below adds one regression test that locks this contract in (asserting the text handed to `DocumentReviewStrategy` still contains real `[page N]` markers), since the new critics' entire "location = page number" contract depends on it silently continuing to hold.

**3. `MediaCriticRole`/`MediaJudgeEvaluator` is the wrong model to literally copy — `LLMJudgeEvaluator` is the right one.**
The spec says (§C.1) the new critics get "the same `MediaJudgeEvaluator`-shaped independent-evaluation contract." Reading `media-judge-evaluator.ts:1-27` (its own module doc): `MediaJudgeEvaluator` exists specifically to add vision-frame dispatch on top of `LLMJudgeEvaluator`, and for a **text** candidate it just delegates to an internal `LLMJudgeEvaluator` unchanged. Since document critics are explicitly "text-only input... no vision requirement" (spec's own words), building them on `MediaJudgeEvaluator` would mean carrying vision-dispatch machinery (`evaluateVisualMedia`, `buildMediaJudgeContent`, frame-sampling types) that would always be dead code. This plan instead mirrors `LLMJudgeEvaluator` (`llm-judge-evaluator.ts`) directly — same safety-gate order, same timeout contract, same `EvaluatorInput.output: string` input shape — widened with the one new concept (`criticRole`, `issues`) document critics need. This is the same "independent-role-per-instance" contract shape the spec asks for; it is just modeled on the sibling that actually matches text input, not the one that doesn't.

**4. `reconcileCriticResults` is a pure weighted-average function; the spec's synthesis step is a real LLM call. These are not the same kind of "reconcile."**
`reconcileCriticResults` (`media-consensus-strategy.ts:410-458`) is pure arithmetic (weighted score average + conservative verdict). The spec's §C.3 synthesis step is explicitly "one LLM call, not a critic" — grouping/de-duplicating free-text, page-anchored issues across three critics is not a numeric reduction a pure function can do faithfully. What this plan actually reuses from `reconcileCriticResults`/`MediaConsensusStrategy` is the **pattern** — run critics independently (asymmetric visibility, `Promise.all`, never live debate), then do exactly one more step to produce a single composite result — not the literal function body. `DocumentReviewStrategy.synthesize()` (Task 5) reuses `PDFService.analyzeText`'s own `getOrchestrationEngine().execute()` dispatch pattern for that one extra call, not a new judge-client abstraction, and falls back to a deterministic (non-LLM) page-grouping if the synthesis call fails or returns unparseable JSON — so a single bad LLM response can never crash the report or silently drop a critic's finding.

**5. Exact `capability_call` dispatch point and canonical-id gotcha, confirmed against a live test.**
`MediaPlannerStrategy.execute()`'s `capability_call` handling is at `media-planner-strategy.ts:380-446`. The successful-dispatch branch is `media-planner-strategy.ts:414-432`, which calls `this.deps.capabilityDispatcher(plan, body)` and receives `{ result: CapabilityModeResult, fallbackUsed }`. `pdf_understanding` has two aliases (`ocr`, `document_understanding` — `capability-registry.ts:277-281`), so the planner-model's `action.capability` string is **not** guaranteed to be the canonical id — `plan.id` (resolved by `getCapabilityExecutionPlan`) is. This is confirmed by an existing test at `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts:218`, which asserts `capabilityDispatcher.mock.calls[0][0]` (the `plan` argument) matches `{ id: 'pdf_understanding' }`. Task 6 below checks `plan.id === 'pdf_understanding'`, never `action.capability`.

**6. `pdf_understanding`'s `CapabilityModeResult.data` shape, confirmed at the route layer.**
`capabilities-routes.ts:1341-1348` builds `data: { text, summary?, extracted_data?, metadata: PDFDocumentMetadata, extraction: PDFExtractionReport }` for `pdf_understanding`. `CapabilityModeResult.data` is typed `unknown` (`capabilities-routes.ts:85`), so `MediaPlannerStrategy` needs a runtime type guard, not a cast, before trusting `result.data.text`/`result.data.metadata.pageCount` — Task 6 adds one (`extractPdfCapabilityData`), and it fails closed (falls through to today's unchanged `capability_result` outcome) on anything that doesn't look like a PDF result.

**7. Production call site for `MediaPlannerStrategy`, confirmed (matches the spec's Section A citation exactly).**
The only place `new MediaPlannerStrategy(...)` is constructed in production is `capabilities-routes.ts:2235-2266`, inside the `POST /v1/capabilities/media-plan/execute` handler. `mediaConsensusExecutor` is wired there today with an **empty `critics: []`** array (lines 2262-2265, with a comment explaining critics are "intentionally NOT wired yet" pending Section A). Task 8 below wires `documentReviewExecutor` at the exact same call site, with the exact same safe-by-default `critics: []` posture — real document-critic instances (real judge model ids, likely via `ModelRoleResolver` the way Section A wires media critics) are a natural follow-up once a model-selection story exists for this role, and are explicitly out of this plan's TDD scope (no real cost is possible with `critics: []` — `DocumentReviewStrategy` degrades explicitly, see Task 4).

**8. No new npm dependency needed.** `pdfkit` (used to build a real multi-page PDF fixture for Task 7's integration test) is already a dev/test dependency of `api/src/services/__tests__/pdf-service.test.ts:23` — no `package.json` change required.

---

## Task 1: Additive `issues` field on `EvaluationResult` + document critic types

**Files:**
- Modify: `api/src/core/orchestration/strategies/evaluation/strategy-output-evaluator.ts`
- Create: `api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.types.ts`

This task only adds types (no runtime behavior), so there is no red/green cycle in the usual sense — the "test" is that the full existing evaluation suite still passes unmodified after a purely additive change (proving no existing evaluator/consumer is broken by the new optional field), and Task 2 immediately exercises the new field for real.

- [ ] **Step 1: Add `DocumentCriticIssue`/`DocumentIssueSeverity` and the `issues` field to `EvaluationResult`**

In `api/src/core/orchestration/strategies/evaluation/strategy-output-evaluator.ts`, insert immediately after the `SubScores` interface (after line 132, before `export interface EvaluationResult {`):

```typescript
/** Severity of a document-critic-flagged issue. */
export type DocumentIssueSeverity = 'critical' | 'major' | 'minor';

/**
 * One page-anchored issue raised by a document critic (MediaPlanner
 * completion, Section C — document/PDF generalization). `location` is a
 * page number, taken from the `[page N]` marker `PDFService.assembleText`
 * already stamps into extracted text (see `pdf-service.ts`) — never a
 * synthetic/estimated position. Additive: every existing evaluator
 * (structural, task-specific, llm_judge, composite, mock, heuristic, media)
 * leaves `EvaluationResult.issues` undefined and is unaffected by its
 * presence, exactly like `judgeCostUsd`/`candidate` before it (see this
 * file's LOTE AT / LOTE AZ doc comments above).
 */
export interface DocumentCriticIssue {
  readonly location: number;
  readonly severity: DocumentIssueSeverity;
  readonly description: string;
}
```

Then add one field to `EvaluationResult`, immediately after the existing `judgeCostUsd` field (inside the interface, after its doc comment block):

```typescript
  /**
   * Page-anchored issues raised by a document critic (Section C). Undefined
   * for every evaluator except `DocumentJudgeEvaluator` — see
   * `DocumentCriticIssue`.
   */
  readonly issues?: readonly DocumentCriticIssue[];
```

- [ ] **Step 2: Create the document critic role + judge contract types**

Create `api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.types.ts`:

```typescript
/**
 * DocumentJudgeEvaluator types — kept in their own file, same layout as
 * `media-judge-evaluator.types.ts` / `llm-judge-evaluator.types.ts`, so
 * consumers (tests, factory, future real client) can import the contracts
 * without pulling in the implementation.
 *
 * Document critics are TEXT-ONLY: they judge the PDF text `pdf-service.ts`
 * already extracts (with `[page N]` markers — see `PDFService.assembleText`),
 * never frames/images, so — unlike `MediaJudgeEvaluator` — there is no
 * vision dispatch here. Structurally this is closer to `LLMJudgeEvaluator`
 * (plain text judging) widened with one additive concept text/media judging
 * don't have: a per-critic list of page-anchored `issues` (see
 * `strategy-output-evaluator.ts`'s `DocumentCriticIssue`), since a document
 * critic is expected to point at WHERE in the document a problem lives, not
 * just emit an overall score.
 */
import type { LLMJudgeRawResult } from './llm-judge-evaluator.types';
import type { DocumentCriticIssue } from './strategy-output-evaluator';

/**
 * Role-differentiated document critics. Mirrors `MediaCriticRole`'s
 * asymmetric-visibility pattern (each critic gets its own rubric and never
 * sees the other critics' verdicts) for the document/PDF domain.
 */
export type DocumentCriticRole = 'factual_accuracy' | 'required_clause_presence' | 'tone';

export const DOCUMENT_CRITIC_ROLES: readonly DocumentCriticRole[] = [
  'factual_accuracy',
  'required_clause_presence',
  'tone',
];

export interface DocumentJudgeEvaluatorConfig {
  /** Master switch. When false, the evaluator returns `unavailable`
   *  WITHOUT calling any provider — even with a mock client. */
  readonly enabled: boolean;
  /** Concrete model id used as the judge. Text-only — no vision requirement. */
  readonly judgeModelId?: string;
  /** Hard budget gate. When 0 (default), no real provider call. */
  readonly maxCostUsd: number;
  /** Wall-clock timeout for the judge call. */
  readonly timeoutMs: number;
  /** Identifies the rubric version embedded in the result. */
  readonly rubricVersion: string;
  /** Which critic rubric this evaluator instance embodies. */
  readonly criticRole: DocumentCriticRole;
}

export interface DocumentJudgeInput {
  readonly judgeModelId: string;
  readonly rubricVersion: string;
  readonly criticRole: DocumentCriticRole;
  readonly task: {
    readonly taskType?: string;
    readonly userMessageExcerpt?: string;
    readonly expectedFormat?: 'json' | 'code' | 'reasoning' | 'free_text';
  };
  /** The assembled document text, WITH `[page N]` markers — the critic is
   *  instructed to cite the nearest marker as `location` on every issue. */
  readonly documentText: string;
  readonly role?: 'voter' | 'synthesis';
  readonly maxCostUsd: number;
  readonly timeoutMs: number;
}

/**
 * Same base fields as `LLMJudgeRawResult` (score/verdict/confidence/
 * shortRationale/costUsd/subScores) plus the one additive concept document
 * critics need: a list of page-anchored issues.
 */
export interface DocumentJudgeRawResult extends LLMJudgeRawResult {
  readonly issues: readonly DocumentCriticIssue[];
}

/**
 * Pluggable document judge client. The default implementation is
 * `undefined` — tests inject a mock; production wiring must inject a
 * concrete client (`ProviderDocumentJudgeClient`) that respects
 * `maxCostUsd` + `timeoutMs` and NEVER falls back to unbounded calls.
 */
export interface DocumentJudgeClient {
  judgeDocument(input: DocumentJudgeInput): Promise<DocumentJudgeRawResult>;
}
```

- [ ] **Step 3: Run the full evaluation test suite to confirm the additive change breaks nothing**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation`
Expected: PASS — every existing test file in that directory (structural, task-specific, llm-judge, media-judge, composite, evaluator-factory, provider-llm-judge-client, provider-media-judge-client, candidate-widening) is green, unmodified.

- [ ] **Step 4: Commit**

```bash
git add api/src/core/orchestration/strategies/evaluation/strategy-output-evaluator.ts \
        api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.types.ts
git commit -m "$(cat <<'EOF'
feat(media-planner): add document critic types + additive EvaluationResult.issues

Document critics need to report WHERE a problem is (a page number), not
just an overall score — no such field exists in the judge schema today
(EvaluationResult/LLMJudgeRawResult have score/verdict/subScores only).
Adds it the same additive way judgeCostUsd/candidate were added before:
every existing evaluator ignores the new optional field unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `DocumentJudgeEvaluator` — the text-only, page-anchored judge

**Files:**
- Create: `api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.ts`
- Test: `api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.test.ts`:

```typescript
/**
 * DocumentJudgeEvaluator — safety + contract tests.
 *
 * Mirrors llm-judge-evaluator.test.ts's structure: the judge MUST NOT call
 * any client unless every gate passes (enabled, judgeModelId, maxCostUsd>0,
 * client injected). The one addition over LLMJudgeEvaluator: a valid result
 * carries `issues` through onto `EvaluationResult.issues` unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { DocumentJudgeEvaluator } from './document-judge-evaluator';
import type { DocumentJudgeClient, DocumentJudgeEvaluatorConfig } from './document-judge-evaluator.types';

const baseConfig: DocumentJudgeEvaluatorConfig = {
  enabled: true,
  judgeModelId: 'judge-model-x',
  maxCostUsd: 0.01,
  timeoutMs: 1000,
  rubricVersion: 'document-critic-v1',
  criticRole: 'factual_accuracy',
};

const baseInput = {
  task: { taskType: 'document_review' },
  output: '[page 1]\nRevenue was $10M.\n\n[page 2]\nThe total above was $12M.',
  strategyName: 'document-review',
  role: 'voter' as const,
};

function clientThatShouldNotBeCalled(): DocumentJudgeClient {
  return {
    judgeDocument: vi.fn(async () => {
      throw new Error('client was called when it should not have been');
    }),
  };
}

describe('DocumentJudgeEvaluator — safety gates', () => {
  it('enabled=false → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator({ ...baseConfig, enabled: false }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBeUndefined();
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('document_judge_disabled');
    expect(r.issues).toEqual([]);
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });

  it('missing judgeModelId → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator({ ...baseConfig, judgeModelId: undefined }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('judge_model_id_missing');
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });

  it('maxCostUsd=0 → unavailable, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator({ ...baseConfig, maxCostUsd: 0 }, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('budget_zero_or_invalid');
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });

  it('no client injected → unavailable', async () => {
    const ev = new DocumentJudgeEvaluator(baseConfig); // no client
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.notes).toContain('document_judge_client_unavailable');
  });

  it('empty document text → fail, client NEVER called', async () => {
    const client = clientThatShouldNotBeCalled();
    const ev = new DocumentJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate({ ...baseInput, output: '   ' });
    expect(r.verdict).toBe('fail');
    expect(r.issues).toEqual([]);
    expect(client.judgeDocument).not.toHaveBeenCalled();
  });
});

describe('DocumentJudgeEvaluator — happy path with mock client', () => {
  it('returns fully_validated with issues carried through unchanged', async () => {
    const client: DocumentJudgeClient = {
      judgeDocument: async () => ({
        score: 0.4,
        verdict: 'fail',
        confidence: 0.75,
        shortRationale: 'numbers do not reconcile',
        issues: [{ location: 2, severity: 'critical', description: 'total contradicts page 1' }],
      }),
    };
    const ev = new DocumentJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.score).toBe(0.4);
    expect(r.verdict).toBe('fail');
    expect(r.validationStatus).toBe('fully_validated');
    expect(r.issues).toEqual([{ location: 2, severity: 'critical', description: 'total contradicts page 1' }]);
    expect(r.notes).toContain('critic=factual_accuracy');
  });

  it('malformed raw result (issues not an array) → unavailable, never fabricated', async () => {
    const client: DocumentJudgeClient = {
      // @ts-expect-error deliberately malformed for the test
      judgeDocument: async () => ({ score: 0.5, verdict: 'pass', issues: 'not-an-array' }),
    };
    const ev = new DocumentJudgeEvaluator(baseConfig, client);
    const r = await ev.evaluate(baseInput);
    expect(r.validationStatus).toBe('unavailable');
    expect(r.issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/document-judge-evaluator.test.ts`
Expected: FAIL — `./document-judge-evaluator` cannot be resolved (module does not exist yet).

- [ ] **Step 3: Implement `DocumentJudgeEvaluator`**

Create `api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.ts`:

```typescript
/**
 * DocumentJudgeEvaluator
 *
 * The document-critic sibling of `LLMJudgeEvaluator`. Text-only — no vision
 * dispatch, unlike `MediaJudgeEvaluator` — because a document critic judges
 * the PDF's extracted TEXT (with `[page N]` markers), never frames/images.
 * Same safety-gate order and timeout contract as `LLMJudgeEvaluator`; the
 * one addition is `issues`, a page-anchored list the judge is asked to
 * return alongside its score/verdict.
 *
 * If any gate fails, the evaluator returns `mode='llm_judge'`,
 * `validationStatus='unavailable'`, `score=undefined`, `issues=[]` — never
 * fabricated.
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';
import type {
  DocumentCriticRole,
  DocumentJudgeClient,
  DocumentJudgeEvaluatorConfig,
  DocumentJudgeInput,
  DocumentJudgeRawResult,
} from './document-judge-evaluator.types';

export class DocumentJudgeEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'llm_judge' as const;
  readonly id: string;
  private readonly criticRole: DocumentCriticRole;

  constructor(
    private readonly config: DocumentJudgeEvaluatorConfig,
    private readonly client?: DocumentJudgeClient
  ) {
    this.criticRole = config.criticRole;
    this.id = `document-judge-${this.criticRole}-${config.rubricVersion}`;
  }

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    // ─── Safety gates (same order as LLMJudgeEvaluator) ──────────────────
    if (!this.config.enabled) {
      return this.unavailable('document_judge_disabled');
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
    if (!this.client) {
      return this.unavailable('document_judge_client_unavailable');
    }

    const text = (input.output ?? '').trim();
    if (!text) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: 0,
        verdict: 'fail',
        structural: { nonEmpty: false, meetsMinLength: false, executionError: false },
        issues: [],
        notes: 'empty document text',
        validationStatus: 'fully_validated',
      };
    }

    const judgeInput: DocumentJudgeInput = {
      judgeModelId: effectiveJudgeModelId,
      rubricVersion: this.config.rubricVersion,
      criticRole: this.criticRole,
      task: {
        taskType: input.task.taskType,
        userMessageExcerpt: input.task.userMessageExcerpt,
        expectedFormat: input.task.expectedFormat,
      },
      documentText: text,
      role: input.role,
      maxCostUsd: this.config.maxCostUsd,
      timeoutMs: this.config.timeoutMs,
    };

    let raw: DocumentJudgeRawResult;
    try {
      raw = await withTimeout(this.client.judgeDocument(judgeInput), this.config.timeoutMs);
    } catch (err) {
      return {
        scoringMode: this.mode,
        evaluatorId: this.id,
        score: undefined,
        verdict: 'uncertain',
        structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
        issues: [],
        notes: `document judge call failed: ${errorMessage(err)}`,
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
        issues: [],
        notes: 'document judge returned malformed result',
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
      issues: raw.issues,
      notes:
        `${raw.shortRationale ?? ''} (critic=${this.criticRole}, rubric=${this.config.rubricVersion}, judgeModel=${effectiveJudgeModelId})`.trim(),
      validationStatus: 'fully_validated',
      subScores: raw.subScores
        ? {
            taskCorrectness: raw.subScores.correctness,
            rubricJudge: raw.subScores.reasoningQuality,
            safetyFormat: raw.subScores.safety,
          }
        : undefined,
    };
  }

  private unavailable(reason: string): EvaluationResult {
    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: undefined,
      verdict: 'uncertain',
      structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
      issues: [],
      notes: `Document judge unavailable: ${reason}`,
      validationStatus: 'unavailable',
    };
  }
}

function isValidRaw(r: unknown): r is DocumentJudgeRawResult {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as { score?: unknown; verdict?: unknown; issues?: unknown };
  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) return false;
  if (o.score < 0 || o.score > 1) return false;
  if (o.verdict !== 'pass' && o.verdict !== 'fail' && o.verdict !== 'uncertain') return false;
  if (!Array.isArray(o.issues)) return false;
  return true;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`document_judge_timeout_after_${ms}ms`)), ms);
  });
  return Promise.race([
    p.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeout,
  ]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/document-judge-evaluator.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.ts \
        api/src/core/orchestration/strategies/evaluation/document-judge-evaluator.test.ts
git commit -m "$(cat <<'EOF'
feat(media-planner): add DocumentJudgeEvaluator (text-only, page-anchored)

Mirrors LLMJudgeEvaluator's safety-gate order and timeout contract —
not MediaJudgeEvaluator's, which exists only to add vision-frame
dispatch that a text-only document critic never needs. Carries the new
issues[] field through to EvaluationResult unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `ProviderDocumentJudgeClient` — real provider dispatch + tolerant issue parsing

**Files:**
- Modify: `api/src/core/orchestration/strategies/evaluation/provider-llm-judge-client.ts:302` (export `asObject`)
- Create: `api/src/core/orchestration/strategies/evaluation/provider-document-judge-client.ts`
- Test: `api/src/core/orchestration/strategies/evaluation/provider-document-judge-client.test.ts`

- [ ] **Step 1: Export `asObject` from `provider-llm-judge-client.ts`**

In `api/src/core/orchestration/strategies/evaluation/provider-llm-judge-client.ts`, change line 302 from:

```typescript
function asObject(raw: unknown): Record<string, unknown> | undefined {
```

to:

```typescript
export function asObject(raw: unknown): Record<string, unknown> | undefined {
```

This is the only change to this file — everything else (`coerceRawResult`, `extractJsonContent`) is already exported and reused as-is.

- [ ] **Step 2: Write the failing tests**

Create `api/src/core/orchestration/strategies/evaluation/provider-document-judge-client.test.ts`:

```typescript
/**
 * ProviderDocumentJudgeClient — contract tests.
 *
 * Pure / mocked. NEVER touches a real provider — same fake-registry pattern
 * as provider-media-judge-client.test.ts. The property this file most needs
 * to prove: `issues` is extracted tolerantly (malformed entries dropped,
 * never fabricated) on top of the same score/verdict salvage
 * `coerceRawResult` already provides.
 */
import { describe, it, expect, vi } from 'vitest';
import { ProviderDocumentJudgeClient, coerceDocumentRawResult } from './provider-document-judge-client';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatResponse, Model } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

function fakeChatResponse(content: string): ChatResponse {
  return {
    id: 'document-judge-1',
    object: 'chat.completion',
    created: 0,
    model: 'doc-judge-model',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
  };
}

function fakeRegistry(adapter: Partial<ProviderAdapter>): ProviderRegistry {
  const model: Model = {
    id: 'doc-judge-model',
    providerId: 'mockprov',
    provider: 'mockprov',
    name: 'doc-judge-model',
    displayName: 'document judge',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: ['chat'],
    performance: { latencyMs: 1, throughput: 100, quality: 0.9, reliability: 0.95 },
    status: 'active',
  };
  return {
    findModel: async () => ({ model, adapter: adapter as ProviderAdapter }),
  } as unknown as ProviderRegistry;
}

describe('coerceDocumentRawResult', () => {
  it('extracts a well-formed issues array alongside score/verdict', () => {
    const result = coerceDocumentRawResult(
      JSON.stringify({
        score: 0.3,
        verdict: 'fail',
        rationale: 'missing clause',
        issues: [{ location: 4, severity: 'major', description: 'no governing law clause' }],
      })
    );
    expect(result.score).toBe(0.3);
    expect(result.issues).toEqual([{ location: 4, severity: 'major', description: 'no governing law clause' }]);
  });

  it('drops a malformed issue (no location) instead of fabricating one', () => {
    const result = coerceDocumentRawResult(
      JSON.stringify({ score: 0.5, verdict: 'uncertain', issues: [{ severity: 'minor', description: 'x' }] })
    );
    expect(result.issues).toEqual([]);
  });

  it('defaults an unrecognised severity to "minor"', () => {
    const result = coerceDocumentRawResult(
      JSON.stringify({ score: 0.5, verdict: 'pass', issues: [{ location: 1, severity: 'huge', description: 'x' }] })
    );
    expect(result.issues).toEqual([{ location: 1, severity: 'minor', description: 'x' }]);
  });

  it('returns an empty issues array (not a throw) when issues is missing entirely', () => {
    const result = coerceDocumentRawResult(JSON.stringify({ score: 0.9, verdict: 'pass' }));
    expect(result.issues).toEqual([]);
  });
});

describe('ProviderDocumentJudgeClient', () => {
  it('sends plain text content (no image parts) and attaches billable cost', async () => {
    const chatCompletion = vi.fn().mockResolvedValue({
      ...fakeChatResponse(
        JSON.stringify({
          score: 0.2,
          verdict: 'fail',
          issues: [{ location: 2, severity: 'critical', description: 'total does not sum' }],
        })
      ),
      usage: { prompt_tokens: 500, completion_tokens: 50 },
    });
    const calculateCost = vi.fn().mockReturnValue(0.004);
    const client = new ProviderDocumentJudgeClient({ registry: fakeRegistry({ chatCompletion, calculateCost }) });

    const result = await client.judgeDocument({
      judgeModelId: 'doc-judge-model',
      rubricVersion: 'document-critic-v1',
      criticRole: 'factual_accuracy',
      task: {},
      documentText: '[page 1]\nRevenue was $10M.\n\n[page 2]\nThe total above was $12M.',
      maxCostUsd: 0.05,
      timeoutMs: 5000,
    });

    expect(result.issues).toEqual([{ location: 2, severity: 'critical', description: 'total does not sum' }]);
    expect(result.costUsd).toBe(0.004);
    const sentRequest = chatCompletion.mock.calls[0][0];
    expect(JSON.stringify(sentRequest)).not.toContain('image_url');
    expect(sentRequest.messages[1].content).toContain('[page 1]');
  });

  it('throws when the judge model does not resolve', async () => {
    const registry = { findModel: async () => undefined } as unknown as ProviderRegistry;
    const client = new ProviderDocumentJudgeClient({ registry });
    await expect(
      client.judgeDocument({
        judgeModelId: 'missing-model',
        rubricVersion: 'v1',
        criticRole: 'tone',
        task: {},
        documentText: 'text',
        maxCostUsd: 0.05,
        timeoutMs: 5000,
      })
    ).rejects.toThrow('document_judge_model_not_found:missing-model');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/provider-document-judge-client.test.ts`
Expected: FAIL — `./provider-document-judge-client` cannot be resolved.

- [ ] **Step 4: Implement `ProviderDocumentJudgeClient`**

Create `api/src/core/orchestration/strategies/evaluation/provider-document-judge-client.ts`:

```typescript
/**
 * ProviderDocumentJudgeClient
 *
 * Concrete `DocumentJudgeClient` that runs a text-only rubric prompt (no
 * image/frame parts — this is the document/PDF critic, always text) through
 * one of the project's existing provider adapters. Same single
 * responsibility as `ProviderMediaJudgeClient`/`ProviderLLMJudgeClient`: it
 * does NOT decide whether to call the judge — that gate lives in
 * `DocumentJudgeEvaluator` (enabled, budget, model id, client present).
 *
 * Parsing contract: reuses `coerceRawResult`/`extractJsonContent`/`asObject`
 * from `./provider-llm-judge-client` for the score/verdict/confidence/
 * subScores fields, and separately, tolerantly extracts `issues` on top —
 * dropping any malformed entry rather than fabricating a page number or
 * description for it.
 *
 * Hard safety properties (same as the other provider judge clients):
 *   - No prompt text is logged. Only rubric version, critic role, judge
 *     model id, latency, and parsed numeric outputs.
 *   - No DB writes.
 *   - Temperature pinned to 0 for determinism.
 */
import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ChatRequest, ChatResponse } from '@/types';
import type { DocumentCriticIssue, DocumentIssueSeverity } from './strategy-output-evaluator';
import { asObject, coerceRawResult, extractJsonContent } from './provider-llm-judge-client';
import type {
  DocumentCriticRole,
  DocumentJudgeClient,
  DocumentJudgeInput,
  DocumentJudgeRawResult,
} from './document-judge-evaluator.types';

const log = logger.child({ component: 'provider-document-judge-client' });

const RUBRIC_HEADER =
  'You are an impartial document-review judge. Score the candidate document (its full text, with ' +
  '"[page N]" markers) on a strict rubric. Return ONLY a single JSON object with these fields, no ' +
  'markdown, no commentary:\n' +
  '  score: number in [0, 1] — overall document quality on THIS critic axis\n' +
  '  verdict: "pass" | "fail" | "uncertain"\n' +
  '  confidence: number in [0, 1]\n' +
  '  rationale: short string (under 200 chars)\n' +
  '  issues: array of { location: number, severity: "critical"|"major"|"minor", description: string } — ' +
  'one entry per problem found on THIS critic axis. location is the page number from the "[page N]" ' +
  'marker nearest the problem (for an issue about something MISSING, cite the page where it should ' +
  'have appeared, e.g. the last page). Return an empty array when nothing is wrong.\n' +
  '  subScores: { correctness, completeness, instructionAdherence, formatAdherence, grounding, safety, reasoningQuality } — each in [0, 1]\n' +
  'Use "uncertain" only when the document genuinely does not let you tell.';

/** Per-critic rubric focus, appended to the shared header. Asymmetric
 *  visibility: each critic only ever sees this one framing, never the
 *  other critics' verdicts. */
const CRITIC_RUBRIC_FOCUS: Record<DocumentCriticRole, string> = {
  factual_accuracy:
    'Focus axis: FACTUAL ACCURACY. Flag claims, numbers, or dates that are internally inconsistent ' +
    '(e.g. a total that does not sum, a date that contradicts another date in the document) or that ' +
    'contradict well-established facts. Ignore tone and missing boilerplate clauses.',
  required_clause_presence:
    'Focus axis: REQUIRED CLAUSE PRESENCE. Flag standard clauses a document of this kind should ' +
    'contain but does not (e.g. termination, governing law, confidentiality, indemnification, a ' +
    'signature block for a contract-like document). Ignore factual correctness and tone.',
  tone:
    'Focus axis: TONE. Flag passages whose tone/register is inconsistent with the rest of the ' +
    'document or inappropriate for its apparent purpose (e.g. a formal contract that suddenly reads ' +
    'casually). Ignore factual correctness and missing clauses.',
};

export interface ProviderDocumentJudgeClientOptions {
  readonly registry: ProviderRegistry;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export class ProviderDocumentJudgeClient implements DocumentJudgeClient {
  constructor(private readonly opts: ProviderDocumentJudgeClientOptions) {}

  async judgeDocument(input: DocumentJudgeInput): Promise<DocumentJudgeRawResult> {
    const resolved = await this.opts.registry.findModel(input.judgeModelId);
    if (!resolved) {
      throw new Error(`document_judge_model_not_found:${input.judgeModelId}`);
    }

    const systemPrompt =
      `${RUBRIC_HEADER}\n${CRITIC_RUBRIC_FOCUS[input.criticRole]}\nrubric_version=${input.rubricVersion}`;
    const userContent = [
      input.task.taskType ? `task_type=${input.task.taskType}` : '',
      input.task.userMessageExcerpt ? `user_request_excerpt:\n${input.task.userMessageExcerpt}` : '',
      'document_text:',
      input.documentText,
    ]
      .filter(Boolean)
      .join('\n\n');

    const judgeRequest: ChatRequest = {
      model: resolved.model.id,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: this.opts.temperature ?? 0,
      max_tokens: this.opts.maxTokens ?? 900,
      stream: false,
    };

    const t0 = Date.now();
    let response: ChatResponse;
    try {
      response = await resolved.adapter.chatCompletion(judgeRequest);
    } catch (err) {
      log.warn(
        {
          judgeModelId: input.judgeModelId,
          rubricVersion: input.rubricVersion,
          criticRole: input.criticRole,
          latencyMs: Date.now() - t0,
          error: errorMessage(err),
        },
        'document judge provider call failed'
      );
      throw err;
    }
    const latencyMs = Date.now() - t0;

    const rawContent = extractJsonContent(response);
    if (!rawContent) {
      log.warn(
        {
          judgeModelId: input.judgeModelId,
          rubricVersion: input.rubricVersion,
          criticRole: input.criticRole,
          latencyMs,
        },
        'document judge returned no parseable content'
      );
      throw new Error('document_judge_response_empty');
    }

    const result = coerceDocumentRawResult(rawContent);

    let costUsd = 0;
    try {
      const usage = response.usage;
      costUsd =
        Math.max(
          0,
          resolved.adapter.calculateCost(
            resolved.model,
            usage?.prompt_tokens || 0,
            usage?.completion_tokens || 0
          )
        ) || 0;
    } catch {
      costUsd = 0;
    }
    const resultWithCost: DocumentJudgeRawResult = { ...result, costUsd };

    log.info(
      {
        judgeModelId: input.judgeModelId,
        rubricVersion: input.rubricVersion,
        criticRole: input.criticRole,
        latencyMs,
        verdict: result.verdict,
        score: result.score,
        issueCount: result.issues.length,
        costUsd,
      },
      'document judge completed'
    );
    return resultWithCost;
  }
}

// ─── pure helpers (exported for tests) ──────────────────────────────────

/**
 * Turn a raw judge payload (parsed object OR raw string) into a
 * `DocumentJudgeRawResult`. Reuses `coerceRawResult` for the
 * score/verdict/confidence/subScores fields it already tolerantly extracts,
 * and separately extracts `issues` — dropping any malformed entry rather
 * than fabricating a page number or description for it. Throws only when
 * `coerceRawResult` throws (no score salvageable at all).
 */
export function coerceDocumentRawResult(parsed: unknown): DocumentJudgeRawResult {
  const base = coerceRawResult(parsed);
  const obj = asObject(parsed);
  const issues = obj ? extractIssues(obj) : [];
  return { ...base, issues };
}

function extractIssues(o: Record<string, unknown>): DocumentCriticIssue[] {
  const raw = o.issues;
  if (!Array.isArray(raw)) return [];
  const out: DocumentCriticIssue[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const location = toPositiveInt(rec.location ?? rec.page);
    const description = typeof rec.description === 'string' ? rec.description.trim() : '';
    if (location === undefined || description.length === 0) continue;
    const severity: DocumentIssueSeverity =
      rec.severity === 'critical' || rec.severity === 'major' || rec.severity === 'minor'
        ? rec.severity
        : 'minor';
    out.push({ location, severity, description });
  }
  return out;
}

function toPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation/provider-document-judge-client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full evaluation suite to confirm exporting `asObject` broke nothing**

Run: `cd api && npx vitest run src/core/orchestration/strategies/evaluation`
Expected: PASS — `provider-llm-judge-client.test.ts` and everything else in the directory still green.

- [ ] **Step 7: Commit**

```bash
git add api/src/core/orchestration/strategies/evaluation/provider-llm-judge-client.ts \
        api/src/core/orchestration/strategies/evaluation/provider-document-judge-client.ts \
        api/src/core/orchestration/strategies/evaluation/provider-document-judge-client.test.ts
git commit -m "$(cat <<'EOF'
feat(media-planner): add ProviderDocumentJudgeClient (text-only rubric dispatch)

Reuses coerceRawResult/extractJsonContent from provider-llm-judge-client
for score/verdict/subScores, adding tolerant issues[] extraction on top
(malformed entries dropped, never fabricated). Exports asObject from
provider-llm-judge-client.ts so this new client can reuse it instead of
duplicating object/string coercion.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `DocumentReviewStrategy` — critic fan-out (zero-critics and no-issues paths)

**Files:**
- Create: `api/src/core/orchestration/strategies/document-review-strategy.ts`
- Test: `api/src/core/orchestration/strategies/document-review-strategy.test.ts`

This task builds the class and its two "nothing to reconcile" paths (no critics configured; critics ran but found nothing) — both skip the synthesis call entirely, so no orchestration-engine mock is needed yet (Task 5 adds it). Placed alongside `media-consensus-strategy.ts` (not in `__tests__/`), matching that file's location.

- [ ] **Step 1: Write the failing tests (zero-critics + no-issues paths only)**

Create `api/src/core/orchestration/strategies/document-review-strategy.test.ts`:

```typescript
/**
 * DocumentReviewStrategy — critic fan-out + synthesis tests.
 *
 * Critics are mocked `StrategyOutputEvaluator`s (no real client, no real
 * cost) — this file proves the fan-out/reconciliation SHAPE, not any real
 * judge behavior (that's document-judge-evaluator.test.ts /
 * provider-document-judge-client.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrchestrationContext } from '@/types';
import type { EvaluationResult, StrategyOutputEvaluator } from './evaluation/strategy-output-evaluator';

const engineExecute = vi.fn();
vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ execute: engineExecute }),
}));

const { DocumentReviewStrategy } = await import('./document-review-strategy');
import type { DocumentReviewRequest } from './document-review-strategy';

const USER_CONTEXT = { organizationId: 'org-test', userId: 'user-test' } as unknown as OrchestrationContext;

function makeEvaluator(result: EvaluationResult): StrategyOutputEvaluator {
  return { mode: result.scoringMode, id: `mock-${result.evaluatorId}`, evaluate: vi.fn().mockResolvedValue(result) };
}

function baseResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    scoringMode: 'llm_judge',
    evaluatorId: 'mock',
    score: 0.8,
    verdict: 'pass',
    structural: { nonEmpty: true, meetsMinLength: true, executionError: false },
    validationStatus: 'fully_validated',
    issues: [],
    judgeCostUsd: 0.001,
    ...overrides,
  };
}

function baseRequest(overrides: Partial<DocumentReviewRequest> = {}): DocumentReviewRequest {
  return {
    documentText: '[page 1]\nSome text.\n\n[page 2]\nMore text.',
    pageCount: 2,
    filename: 'doc.pdf',
    userContext: USER_CONTEXT,
    requestId: 'req-1',
    ...overrides,
  };
}

describe('DocumentReviewStrategy — zero critics', () => {
  it('degrades explicitly instead of silently returning nothing', async () => {
    const strategy = new DocumentReviewStrategy({ critics: [] });
    const result = await strategy.execute(baseRequest());
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('no_document_critics_configured');
    expect(result.reportByPage).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
    expect(engineExecute).not.toHaveBeenCalled();
  });
});

describe('DocumentReviewStrategy — no issues found', () => {
  it('skips the synthesis call entirely when every critic returns zero issues', async () => {
    const critics = [
      { role: 'factual_accuracy' as const, evaluator: makeEvaluator(baseResult()) },
      { role: 'required_clause_presence' as const, evaluator: makeEvaluator(baseResult()) },
      { role: 'tone' as const, evaluator: makeEvaluator(baseResult()) },
    ];
    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());
    expect(result.totalIssueCount).toBe(0);
    expect(result.reportByPage).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(engineExecute).not.toHaveBeenCalled();
    expect(result.totalCostUsd).toBeCloseTo(0.003, 5);
    for (const c of critics) {
      expect(c.evaluator.evaluate).toHaveBeenCalledTimes(1);
      const calledWith = (c.evaluator.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledWith.output).toBe(baseRequest().documentText);
    }
  });
});
```

Neither test above calls the synthesis path, so `engineExecute` needs no `beforeEach` reset yet — Task 5 adds one when synthesis tests are introduced.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/strategies/document-review-strategy.test.ts`
Expected: FAIL — `./document-review-strategy` cannot be resolved.

- [ ] **Step 3: Implement `DocumentReviewStrategy` (fan-out + zero-critics/no-issues paths only)**

Create `api/src/core/orchestration/strategies/document-review-strategy.ts`:

```typescript
/**
 * DocumentReviewStrategy — the document/PDF sibling of `MediaConsensusStrategy`
 * (media-consensus-strategy.ts), for the MediaPlanner completion design's
 * Section C ("Document/PDF generalization").
 *
 * Reuses the SAME independent-critic-evaluation SHAPE `MediaConsensusStrategy`
 * established (role-differentiated critics run independently — asymmetric
 * visibility, no live debate — then reconciled after the fact), applied to
 * extracted PDF text instead of video/image frames:
 *   - Three text-only critics (`factual_accuracy`, `required_clause_presence`,
 *     `tone`) each judge the SAME assembled document text independently via
 *     `DocumentJudgeEvaluator`, returning page-anchored `issues`
 *     (`EvaluationResult.issues`, see `evaluation/strategy-output-evaluator.ts`).
 *   - UNLIKE `reconcileCriticResults` (a pure weighted-average function —
 *     right for a single numeric quality score), grouping free-text issues
 *     by page and de-duplicating overlapping citations across three critics
 *     is not a numeric reduction. `synthesize()` is therefore a real
 *     SYNTHESIS LLM CALL (one call, not a critic — it never scores anything,
 *     it only reorganizes what the critics already found), reusing the same
 *     `getOrchestrationEngine().execute()` path `PDFService.analyzeText`
 *     already uses, not a new judge-client abstraction.
 *   - When synthesis is skipped (no issues) or its JSON is unparseable, a
 *     deterministic fallback groups the critics' raw issues by page in
 *     code — the report is NEVER empty or crashed just because one LLM call
 *     returned malformed JSON.
 *
 * Zero critics configured (the safe default until real critics are wired,
 * mirroring `MediaConsensusStrategy`'s `critics: []` production default) is
 * a supported, explicit degrade — never a crash, never a fabricated report.
 */
import { getOrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ChatRequest, OrchestrationContext } from '@/types';
import { logger } from '@/utils/logger';
import type {
  DocumentCriticIssue,
  EvaluationResult,
  StrategyOutputEvaluator,
} from './evaluation/strategy-output-evaluator';
import type { DocumentCriticRole } from './evaluation/document-judge-evaluator.types';

const log = logger.child({ component: 'document-review-strategy' });

export interface DocumentCriticConfig {
  readonly role: DocumentCriticRole;
  readonly evaluator: StrategyOutputEvaluator;
}

export interface DocumentReviewRequest {
  readonly documentText: string;
  readonly pageCount: number;
  readonly filename: string;
  readonly userMessageExcerpt?: string;
  readonly userContext: OrchestrationContext;
  readonly requestId: string;
}

export interface DocumentReviewPageIssue {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly description: string;
  readonly sourceCritics: readonly DocumentCriticRole[];
}

export interface DocumentReviewReportPage {
  readonly page: number;
  readonly issues: readonly DocumentReviewPageIssue[];
}

export interface DocumentReviewResult {
  readonly criticResults: ReadonlyArray<{ readonly role: DocumentCriticRole; readonly result: EvaluationResult }>;
  readonly reportByPage: readonly DocumentReviewReportPage[];
  readonly totalIssueCount: number;
  /** Plain-text rendering of `reportByPage`, ALWAYS well-formed even when
   *  synthesis fails — this is what feeds the planner's transcript. */
  readonly reportText: string;
  /** Critic judge calls + the one synthesis call, combined. */
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
  readonly degraded: boolean;
  readonly degradedReason?: string;
}

/** Structural mirror of what the planner needs — see `media-planner-types.ts`. */
export interface DocumentReviewExecutor {
  execute(request: DocumentReviewRequest): Promise<DocumentReviewResult>;
}

export class DocumentReviewStrategy implements DocumentReviewExecutor {
  private readonly critics: readonly DocumentCriticConfig[];
  private readonly synthesisModelId: string | undefined;

  constructor(
    deps: { readonly critics?: readonly DocumentCriticConfig[]; readonly synthesisModelId?: string } = {}
  ) {
    this.critics = deps.critics ?? [];
    this.synthesisModelId = deps.synthesisModelId;
  }

  async execute(request: DocumentReviewRequest): Promise<DocumentReviewResult> {
    const startTime = Date.now();

    if (this.critics.length === 0) {
      return {
        criticResults: [],
        reportByPage: [],
        totalIssueCount: 0,
        reportText: 'Document critics not configured — extraction only, no review performed.',
        totalCostUsd: 0,
        totalDurationMs: Date.now() - startTime,
        degraded: true,
        degradedReason: 'no_document_critics_configured',
      };
    }

    const evalTask = { userMessageExcerpt: request.userMessageExcerpt ?? request.documentText.slice(0, 200) };

    const criticResults = await Promise.all(
      this.critics.map(async (critic) => ({
        role: critic.role,
        result: await critic.evaluator.evaluate({
          task: evalTask,
          output: request.documentText,
          strategyName: 'document-review',
          role: 'voter' as const,
        }),
      }))
    );

    const criticCostUsd = criticResults.reduce((sum, c) => sum + (c.result.judgeCostUsd ?? 0), 0);

    const flatIssues: Array<{ role: DocumentCriticRole; issue: DocumentCriticIssue }> = [];
    for (const { role, result } of criticResults) {
      for (const issue of result.issues ?? []) {
        flatIssues.push({ role, issue });
      }
    }

    if (flatIssues.length === 0) {
      return {
        criticResults,
        reportByPage: [],
        totalIssueCount: 0,
        reportText: 'No issues found by any critic.',
        totalCostUsd: criticCostUsd,
        totalDurationMs: Date.now() - startTime,
        degraded: false,
      };
    }

    const synthesis = await this.synthesize(flatIssues, request);

    return {
      criticResults,
      reportByPage: synthesis.reportByPage,
      totalIssueCount: flatIssues.length,
      reportText: renderReportText(synthesis.reportByPage),
      totalCostUsd: criticCostUsd + synthesis.costUsd,
      totalDurationMs: Date.now() - startTime,
      degraded: false,
    };
  }

  /**
   * ONE synthesis LLM call (not a critic) that groups/de-duplicates the
   * critics' raw issues by page. Reuses `getOrchestrationEngine().execute()`
   * exactly like `PDFService.analyzeText` — plain chat dispatch, no
   * judge-client abstraction, because this step never scores anything.
   *
   * Implemented fully in Task 5 — this task leaves it unreachable (every
   * test here has `flatIssues.length === 0`), so a stub that throws if ever
   * called is intentional and will be replaced in the next task.
   */
  private async synthesize(
    _flatIssues: ReadonlyArray<{ role: DocumentCriticRole; issue: DocumentCriticIssue }>,
    _request: DocumentReviewRequest
  ): Promise<{ reportByPage: readonly DocumentReviewReportPage[]; costUsd: number }> {
    throw new Error('DocumentReviewStrategy.synthesize: not implemented yet (see Task 5)');
  }
}

function renderReportText(reportByPage: readonly DocumentReviewReportPage[]): string {
  if (reportByPage.length === 0) return 'No issues found by any critic.';
  return reportByPage
    .map((p) => {
      const issuesText = p.issues
        .map((i) => `[${i.severity}] ${i.description} (flagged by: ${i.sourceCritics.join(', ') || 'unknown'})`)
        .join('; ');
      return `Page ${p.page}: ${issuesText}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/strategies/document-review-strategy.test.ts`
Expected: PASS (2 tests). `synthesize()` is never reached by either test.

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/document-review-strategy.ts \
        api/src/core/orchestration/strategies/document-review-strategy.test.ts
git commit -m "$(cat <<'EOF'
feat(media-planner): add DocumentReviewStrategy critic fan-out (zero-critics + no-issues paths)

Independent 3-critic fan-out over extracted PDF text, mirroring
MediaConsensusStrategy's asymmetric-visibility pattern. Zero critics
configured degrades explicitly (never silent) with the exact posture
MediaConsensusStrategy uses in production today. Synthesis call lands
in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `DocumentReviewStrategy` — synthesis call + deterministic fallback grouping

**Files:**
- Modify: `api/src/core/orchestration/strategies/document-review-strategy.ts`
- Modify: `api/src/core/orchestration/strategies/document-review-strategy.test.ts`

- [ ] **Step 1: Write the failing tests (issues-found path: synthesis success, synthesis malformed JSON, deterministic grouping)**

Edit `api/src/core/orchestration/strategies/document-review-strategy.test.ts` in two places:

1. Change the top `import { describe, it, expect, vi } from 'vitest';` line to:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
```

2. Change the `const { DocumentReviewStrategy } = await import('./document-review-strategy');` line to also destructure the two new pure helpers:

```typescript
const { DocumentReviewStrategy, groupIssuesDeterministically, parseSynthesisReport } = await import(
  './document-review-strategy'
);
```

Then append the following at the end of the file (after the existing `describe('DocumentReviewStrategy — no issues found', ...)` block from Task 4):

```typescript
beforeEach(() => {
  engineExecute.mockReset();
});

describe('DocumentReviewStrategy — issues found, synthesis succeeds', () => {
  it('runs all 3 critics independently, then one synthesis call grouping issues by page', async () => {
    const critics = [
      {
        role: 'factual_accuracy' as const,
        evaluator: makeEvaluator(
          baseResult({ issues: [{ location: 2, severity: 'critical', description: 'total does not sum' }] })
        ),
      },
      {
        role: 'required_clause_presence' as const,
        evaluator: makeEvaluator(
          baseResult({ issues: [{ location: 2, severity: 'major', description: 'missing governing law clause' }] })
        ),
      },
      { role: 'tone' as const, evaluator: makeEvaluator(baseResult()) },
    ];
    engineExecute.mockResolvedValue({
      finalResponse: {
        model: 'synth-model',
        choices: [
          {
            message: {
              content: JSON.stringify({
                pages: [
                  {
                    page: 2,
                    issues: [
                      { severity: 'critical', description: 'total does not sum', sourceCritics: ['factual_accuracy'] },
                      {
                        severity: 'major',
                        description: 'missing governing law clause',
                        sourceCritics: ['required_clause_presence'],
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
      totalCost: 0.002,
    });

    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());

    expect(engineExecute).toHaveBeenCalledTimes(1);
    expect(result.reportByPage).toEqual([
      {
        page: 2,
        issues: [
          { severity: 'critical', description: 'total does not sum', sourceCritics: ['factual_accuracy'] },
          { severity: 'major', description: 'missing governing law clause', sourceCritics: ['required_clause_presence'] },
        ],
      },
    ]);
    expect(result.totalIssueCount).toBe(2);
    expect(result.reportText).toContain('Page 2:');
    expect(result.totalCostUsd).toBeCloseTo(0.002 + 0.001 + 0.001 + 0.001, 5);
  });
});

describe('DocumentReviewStrategy — synthesis returns unparseable JSON', () => {
  it('falls back to a deterministic page-grouping of the raw critic issues', async () => {
    const critics = [
      {
        role: 'factual_accuracy' as const,
        evaluator: makeEvaluator(baseResult({ issues: [{ location: 1, severity: 'minor', description: 'odd phrasing' }] })),
      },
    ];
    engineExecute.mockResolvedValue({
      finalResponse: { model: 'synth-model', choices: [{ message: { content: 'not json at all' } }] },
      totalCost: 0,
    });

    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());

    expect(result.reportByPage).toEqual([
      { page: 1, issues: [{ severity: 'minor', description: 'odd phrasing', sourceCritics: ['factual_accuracy'] }] },
    ]);
  });
});

describe('DocumentReviewStrategy — synthesis call throws', () => {
  it('falls back to deterministic grouping instead of propagating the error', async () => {
    const critics = [
      {
        role: 'tone' as const,
        evaluator: makeEvaluator(baseResult({ issues: [{ location: 3, severity: 'minor', description: 'casual aside' }] })),
      },
    ];
    engineExecute.mockRejectedValue(new Error('synthesis model unavailable'));

    const strategy = new DocumentReviewStrategy({ critics });
    const result = await strategy.execute(baseRequest());

    expect(result.reportByPage).toEqual([
      { page: 3, issues: [{ severity: 'minor', description: 'casual aside', sourceCritics: ['tone'] }] },
    ]);
  });
});

describe('groupIssuesDeterministically', () => {
  it('groups by page ascending, preserving every issue', () => {
    const grouped = groupIssuesDeterministically([
      { role: 'tone', issue: { location: 3, severity: 'minor', description: 'a' } },
      { role: 'factual_accuracy', issue: { location: 1, severity: 'critical', description: 'b' } },
    ]);
    expect(grouped.map((p) => p.page)).toEqual([1, 3]);
  });
});

describe('parseSynthesisReport', () => {
  it('returns undefined for non-JSON text', () => {
    expect(parseSynthesisReport('no json here')).toBeUndefined();
  });

  it('drops a page entry with no valid issues', () => {
    const out = parseSynthesisReport(JSON.stringify({ pages: [{ page: 1, issues: [] }] }));
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd api && npx vitest run src/core/orchestration/strategies/document-review-strategy.test.ts`
Expected: FAIL — `synthesize()` throws `not implemented yet`, and `groupIssuesDeterministically`/`parseSynthesisReport` are not exported.

- [ ] **Step 3: Implement the synthesis call + deterministic fallback**

In `api/src/core/orchestration/strategies/document-review-strategy.ts`, replace the stub `synthesize` method body and add the two new exported helpers:

```typescript
  private async synthesize(
    flatIssues: ReadonlyArray<{ role: DocumentCriticRole; issue: DocumentCriticIssue }>,
    request: DocumentReviewRequest
  ): Promise<{ reportByPage: readonly DocumentReviewReportPage[]; costUsd: number }> {
    const engine = getOrchestrationEngine();
    if (!engine) {
      log.warn(
        { requestId: request.requestId },
        'orchestration engine unavailable — using deterministic fallback grouping'
      );
      return { reportByPage: groupIssuesDeterministically(flatIssues), costUsd: 0 };
    }

    const issuesJson = JSON.stringify(
      flatIssues.map(({ role, issue }) => ({
        sourceCritic: role,
        page: issue.location,
        severity: issue.severity,
        description: issue.description,
      }))
    );

    const chatRequest: ChatRequest = {
      model: this.synthesisModelId && this.synthesisModelId !== 'auto' ? this.synthesisModelId : 'auto',
      messages: [
        {
          role: 'system',
          content:
            'You reconcile independent document-review findings into one report. You do NOT judge or ' +
            'score anything new — only group and de-duplicate what is given. Return ONLY a single JSON ' +
            'object: { "pages": [ { "page": number, "issues": [ { "severity": "critical"|"major"|"minor", ' +
            '"description": string, "sourceCritics": string[] } ] } ] }, sorted by page ascending. Merge ' +
            'issues that describe the same underlying problem on the same page into one entry, listing ' +
            'every critic that raised it in "sourceCritics". Never invent an issue not present in the input.',
        },
        {
          role: 'user',
          content: `filename="${request.filename}" pages=${request.pageCount}\n\nfindings:\n${issuesJson}`,
        },
      ],
      temperature: 0,
      max_tokens: 2000,
    };

    try {
      const response = await engine.execute(chatRequest, request.userContext.organizationId, request.userContext.userId);
      const content = response.finalResponse.choices[0]?.message?.content;
      const text = typeof content === 'string' ? content : '';
      const parsed = parseSynthesisReport(text);
      if (!parsed) {
        log.warn(
          { requestId: request.requestId },
          'synthesis returned unparseable JSON — using deterministic fallback grouping'
        );
        return { reportByPage: groupIssuesDeterministically(flatIssues), costUsd: response.totalCost ?? 0 };
      }
      return { reportByPage: parsed, costUsd: response.totalCost ?? 0 };
    } catch (err) {
      log.warn(
        { requestId: request.requestId, error: err instanceof Error ? err.message : String(err) },
        'synthesis call failed — using deterministic fallback grouping'
      );
      return { reportByPage: groupIssuesDeterministically(flatIssues), costUsd: 0 };
    }
  }
}

// ─── pure helpers (exported for tests) ─────────────────────────────────

/** Deterministic, LLM-free grouping — the fallback when synthesis is
 *  skipped or its output can't be trusted. Never drops an issue. */
export function groupIssuesDeterministically(
  flatIssues: ReadonlyArray<{ role: DocumentCriticRole; issue: DocumentCriticIssue }>
): DocumentReviewReportPage[] {
  const byPage = new Map<number, DocumentReviewPageIssue[]>();
  for (const { role, issue } of flatIssues) {
    const list = byPage.get(issue.location) ?? [];
    list.push({ severity: issue.severity, description: issue.description, sourceCritics: [role] });
    byPage.set(issue.location, list);
  }
  return Array.from(byPage.entries())
    .sort(([a], [b]) => a - b)
    .map(([page, issues]) => ({ page, issues }));
}

/** Tolerantly parses the synthesis model's JSON report. Returns `undefined`
 *  (never throws) on anything unparseable — the caller falls back to
 *  `groupIssuesDeterministically`. */
export function parseSynthesisReport(text: string): DocumentReviewReportPage[] | undefined {
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart < 0 || braceEnd <= braceStart) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { pages?: unknown }).pages)) {
    return undefined;
  }
  const pages = (parsed as { pages: unknown[] }).pages;
  const out: DocumentReviewReportPage[] = [];
  for (const p of pages) {
    if (typeof p !== 'object' || p === null) continue;
    const rec = p as Record<string, unknown>;
    const page = typeof rec.page === 'number' && Number.isFinite(rec.page) ? Math.round(rec.page) : undefined;
    if (page === undefined || !Array.isArray(rec.issues)) continue;
    const issues: DocumentReviewPageIssue[] = [];
    for (const i of rec.issues) {
      if (typeof i !== 'object' || i === null) continue;
      const irec = i as Record<string, unknown>;
      const description = typeof irec.description === 'string' ? irec.description.trim() : '';
      if (!description) continue;
      const severity =
        irec.severity === 'critical' || irec.severity === 'major' || irec.severity === 'minor'
          ? irec.severity
          : 'minor';
      const sourceCritics = Array.isArray(irec.sourceCritics)
        ? irec.sourceCritics.filter(
            (c): c is DocumentCriticRole => c === 'factual_accuracy' || c === 'required_clause_presence' || c === 'tone'
          )
        : [];
      issues.push({ severity, description, sourceCritics });
    }
    if (issues.length > 0) out.push({ page, issues });
  }
  return out.sort((a, b) => a.page - b.page);
}
```

Note: the closing brace after the new `synthesize` body replaces the class's original closing brace — `groupIssuesDeterministically`/`parseSynthesisReport`/`renderReportText` all live at module scope, below the class, same as before.

- [ ] **Step 4: Run the tests to verify they all pass**

Run: `cd api && npx vitest run src/core/orchestration/strategies/document-review-strategy.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add api/src/core/orchestration/strategies/document-review-strategy.ts \
        api/src/core/orchestration/strategies/document-review-strategy.test.ts
git commit -m "$(cat <<'EOF'
feat(media-planner): add DocumentReviewStrategy synthesis call + deterministic fallback

One extra LLM call (not a critic) groups the 3 critics' page-anchored
issues into a single report, reusing PDFService.analyzeText's own
getOrchestrationEngine().execute() dispatch — no new judge-client
abstraction. A malformed/failed synthesis call never crashes or drops
a finding: it falls back to a deterministic, LLM-free page-grouping.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `pdf-service.ts` page-marker contract — regression lock

**Files:**
- Test: `api/src/services/__tests__/pdf-service.test.ts`

No production code changes (see Investigation Finding 2 — `assembleText()` already emits `[page N]` markers). This task only adds a test that pins the contract `DocumentReviewStrategy`'s whole "location = page number" design depends on.

- [ ] **Step 1: Write the test**

Add to `api/src/services/__tests__/pdf-service.test.ts`, inside the existing `describe('native text layer', ...)` block (after the `'extracts real per-page text and document metadata'` test):

```typescript
    it('stamps a "[page N]" marker before every page — the contract DocumentReviewStrategy relies on', async () => {
      const pdf = await buildPdf([{ text: LONG_TEXT_A }, { text: LONG_TEXT_B }]);
      const service = makeService();
      const result = await service.analyzePDF({
        pdfBuffer: pdf,
        filename: 'two-page.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req-page-markers',
      });
      expect(result.text).toContain('[page 1]');
      expect(result.text).toContain('[page 2]');
      // Page 1's marker must precede page 2's — critics rely on reading
      // markers in document order to anchor an issue to the right page.
      expect(result.text.indexOf('[page 1]')).toBeLessThan(result.text.indexOf('[page 2]'));
    });
```

- [ ] **Step 2: Run the test to verify it passes immediately (no production code change — this locks existing behavior)**

Run: `cd api && npx vitest run src/services/__tests__/pdf-service.test.ts`
Expected: PASS (this and every pre-existing test in the file).

- [ ] **Step 3: Commit**

```bash
git add api/src/services/__tests__/pdf-service.test.ts
git commit -m "$(cat <<'EOF'
test(pdf-service): lock the "[page N]" marker contract DocumentReviewStrategy depends on

assembleText() already stamps [page N] markers (confirmed reading the
current source — no extraction change needed for the document-critic
fan-out to work). This test pins that contract so a future refactor of
pdf-service.ts's assembly can't silently drop it without a red test.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Planner dispatch — route `pdf_understanding` through the critic fan-out

**Files:**
- Modify: `api/src/core/orchestration/strategies/media-planner-types.ts`
- Modify: `api/src/core/orchestration/strategies/media-planner-strategy.ts`
- Modify: `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`

- [ ] **Step 1: Add the new `PlannerTurnOutcome` variant**

In `api/src/core/orchestration/strategies/media-planner-types.ts`, add one member to the `PlannerTurnOutcome` union (after the existing `'capability_result'` member, before `'generation_result'`, at line 173):

```typescript
  | {
      readonly type: 'document_review_result';
      readonly capability: string;
      readonly success: boolean;
      readonly summary: string;
      readonly pageCount: number;
      readonly issueCount: number;
      readonly degraded?: boolean;
    }
```

- [ ] **Step 2: Write the failing tests**

Add to `api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`. First, add the import near the top (with the other type-only imports around line 14):

```typescript
import type { DocumentReviewExecutor, DocumentReviewResult } from '../document-review-strategy';
```

Then add a new `describe` block (e.g. after the existing `'MediaPlannerStrategy — turn-cap / budget exhaustion'` block):

```typescript
describe('MediaPlannerStrategy — pdf_understanding routes through DocumentReviewStrategy', () => {
  function makeReviewResult(overrides: Partial<DocumentReviewResult> = {}): DocumentReviewResult {
    return {
      criticResults: [],
      reportByPage: [{ page: 2, issues: [{ severity: 'critical', description: 'total does not sum', sourceCritics: ['factual_accuracy'] }] }],
      totalIssueCount: 1,
      reportText: 'Page 2: [critical] total does not sum (flagged by: factual_accuracy)',
      totalCostUsd: 0.01,
      totalDurationMs: 5,
      degraded: false,
      ...overrides,
    };
  }

  it('intercepts a pdf_understanding capability_call and reports the page-grouped review', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'capability_call', capability: 'pdf_understanding', body: {} }))
      .mockResolvedValueOnce(
        chatJson({ kind: 'final', content: 'Found 1 issue on page 2.', unmetConstraints: [] })
      );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: {
        data: { text: '[page 1]\nfoo\n\n[page 2]\nbar', metadata: { pageCount: 2 }, extraction: {} },
        executionPath: 'tool_pipeline',
      },
      fallbackUsed: false,
    });
    const documentReviewExecutor: DocumentReviewExecutor = { execute: vi.fn().mockResolvedValue(makeReviewResult()) };

    const strategy = new MediaPlannerStrategy({ capabilityDispatcher, documentReviewExecutor, maxTurns: 2 });
    const result = await strategy.execute(makeRequest('review this contract'), context);

    expect(documentReviewExecutor.execute).toHaveBeenCalledTimes(1);
    const calledWith = (documentReviewExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith.documentText).toBe('[page 1]\nfoo\n\n[page 2]\nbar');
    expect(calledWith.pageCount).toBe(2);

    const plan = result.metadata.plan as Array<{ outcome: { type: string } }>;
    expect(plan[0].outcome.type).toBe('document_review_result');
    expect(result.metadata.stopReason).toBe('final');
  });

  it('falls back to the plain capability_result outcome when documentReviewExecutor is not wired (no regression)', async () => {
    const invokerChat = vi.fn().mockResolvedValue(
      chatJson({ kind: 'capability_call', capability: 'pdf_understanding', body: {} })
    );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: { data: { text: '[page 1]\nfoo', metadata: { pageCount: 1 }, extraction: {} }, executionPath: 'tool_pipeline' },
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({ maxTurns: 1, capabilityDispatcher });
    const result = await strategy.execute(makeRequest('summarize this pdf'), context);

    const plan = result.metadata.plan as Array<{ outcome: { type: string } }>;
    expect(plan[0].outcome.type).toBe('capability_result');
  });

  it('folds document review cost into totalCost / cost-ceiling accounting', async () => {
    const invokerChat = vi.fn().mockResolvedValue(
      chatJson({ kind: 'capability_call', capability: 'pdf_understanding', body: {} })
    );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);
    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: { data: { text: '[page 1]\nfoo', metadata: { pageCount: 1 }, extraction: {} }, executionPath: 'tool_pipeline' },
      fallbackUsed: false,
    });
    const documentReviewExecutor: DocumentReviewExecutor = {
      execute: vi.fn().mockResolvedValue(makeReviewResult({ totalCostUsd: 0.05 })),
    };

    const strategy = new MediaPlannerStrategy({ maxTurns: 1, capabilityDispatcher, documentReviewExecutor });
    const result = await strategy.execute(makeRequest('review this contract'), context);

    expect(result.totalCost).toBeGreaterThanOrEqual(0.05);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`
Expected: FAIL — `documentReviewExecutor` is not a recognised `MediaPlannerDeps` field yet (TypeScript error) and the interception doesn't exist, so the first two new tests assert `document_review_result`/executor-call behavior that never happens.

- [ ] **Step 4: Add the `documentReviewExecutor` dependency and the transcript-summarizer case**

In `api/src/core/orchestration/strategies/media-planner-strategy.ts`:

Add an import (with the other relative imports near the top, after the `media-planner-types` import block):

```typescript
import type { DocumentReviewExecutor, DocumentReviewRequest } from './document-review-strategy';
```

Add one field to `MediaPlannerDeps` (after `mediaConsensusExecutor`, ~line 92):

```typescript
  /** Optional — when absent, `pdf_understanding` capability_call actions
   *  dispatch exactly as before (raw extraction, no critic review). See
   *  document-review-strategy.ts. */
  readonly documentReviewExecutor?: DocumentReviewExecutor;
```

Add a case to `summarizeTurnForTranscript`'s switch (after the existing `'capability_result'` case, ~line 156):

```typescript
    case 'document_review_result':
      return `Turn ${turn.turnIndex}: document review via "${outcome.capability}" — ${outcome.success ? 'succeeded' : 'failed'}${outcome.degraded ? ' (degraded)' : ''} (${outcome.pageCount} pages, ${outcome.issueCount} issue(s)): ${outcome.summary}`;
```

Add a local type guard near the other small local helpers (after `stripJsonCodeFence`, ~line 129):

```typescript
interface PdfCapabilityResultData {
  readonly text: string;
  readonly metadata: { readonly pageCount: number };
}

/** Narrow, defensive guard — `CapabilityModeResult.data` is typed `unknown`.
 *  Returns `undefined` (never throws) on anything that doesn't look like a
 *  pdf_understanding result, so the caller falls through to the unchanged
 *  plain `capability_result` outcome. */
function extractPdfCapabilityData(data: unknown): PdfCapabilityResultData | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  if (typeof rec.text !== 'string' || rec.text.trim().length === 0) return undefined;
  const metadata = rec.metadata;
  const pageCount =
    typeof metadata === 'object' &&
    metadata !== null &&
    typeof (metadata as Record<string, unknown>).pageCount === 'number'
      ? ((metadata as Record<string, unknown>).pageCount as number)
      : 0;
  return { text: rec.text, metadata: { pageCount } };
}
```

- [ ] **Step 5: Intercept the `pdf_understanding` dispatch**

In `api/src/core/orchestration/strategies/media-planner-strategy.ts`, replace the successful-dispatch branch of the `capability_call` handling (currently lines 414-432):

Before:
```typescript
      try {
        const { result, fallbackUsed } = await this.deps.capabilityDispatcher(
          plan,
          (action.body ?? {}) as CapabilityRequestBody
        );
        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'capability_result',
            capability: plan.id,
            success: true,
            summary: `dispatched via ${result.executionPath}`,
            executionPath: result.executionPath,
            fallbackUsed,
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
      } catch (err) {
```

After:
```typescript
      try {
        const { result, fallbackUsed } = await this.deps.capabilityDispatcher(
          plan,
          (action.body ?? {}) as CapabilityRequestBody
        );

        // pdf_understanding gets routed through the critic fan-out instead
        // of the raw extraction — document review becomes a first-class
        // planner path, not a separate strategy class (Section C). Every
        // other capability's dispatch is byte-for-byte unchanged below.
        // Fails open (falls through to the plain outcome) when the
        // dependency isn't wired or the result doesn't look like a PDF
        // result — never throws, never silently drops the extraction.
        if (plan.id === 'pdf_understanding' && this.deps.documentReviewExecutor) {
          const pdfData = extractPdfCapabilityData(result.data);
          if (pdfData) {
            const bodyFilename = action.body?.filename;
            const reviewRequest: DocumentReviewRequest = {
              documentText: pdfData.text,
              pageCount: pdfData.metadata.pageCount,
              filename: typeof bodyFilename === 'string' && bodyFilename.trim().length > 0 ? bodyFilename : 'document.pdf',
              userMessageExcerpt: state.originalRequest.slice(0, 200),
              userContext: context,
              requestId: `${requestId}-turn-${turnIndex}-doc-review`,
            };
            const review = await this.deps.documentReviewExecutor.execute(reviewRequest);

            totalJudgeCostUsd += review.totalCostUsd;
            if (baselineCallCostUsd === 0 && review.totalCostUsd > 0) {
              baselineCallCostUsd = review.totalCostUsd;
            }

            state.turns.push({
              turnIndex,
              action,
              outcome: {
                type: 'document_review_result',
                capability: plan.id,
                success: true,
                summary: review.reportText,
                pageCount: pdfData.metadata.pageCount,
                issueCount: review.totalIssueCount,
                degraded: review.degraded,
              },
              durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
              costUsd: review.totalCostUsd,
            });

            if (baselineCallCostUsd > 0 && totalJudgeCostUsd > costCeilingMultiplier * baselineCallCostUsd) {
              stopReason = 'cost_ceiling_exhausted';
              break;
            }
            continue;
          }
        }

        state.turns.push({
          turnIndex,
          action,
          outcome: {
            type: 'capability_result',
            capability: plan.id,
            success: true,
            summary: `dispatched via ${result.executionPath}`,
            executionPath: result.executionPath,
            fallbackUsed,
          },
          durationMs: (this.deps.now?.() ?? Date.now()) - turnStartedAt,
          costUsd: 0,
        });
      } catch (err) {
```

(The `catch (err) { ... }` block and everything after it is unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts`
Expected: PASS — including the 3 new tests and every pre-existing test in the file (in particular the turn-cap test at line 200, which does NOT wire `documentReviewExecutor` and must keep behaving exactly as before).

- [ ] **Step 7: Run the broader strategy test suite as a regression check**

Run: `cd api && npx vitest run src/core/orchestration/strategies`
Expected: PASS — no other strategy depends on `PlannerTurnOutcome`'s exhaustiveness besides `summarizeTurnForTranscript` (already updated).

- [ ] **Step 8: Commit**

```bash
git add api/src/core/orchestration/strategies/media-planner-types.ts \
        api/src/core/orchestration/strategies/media-planner-strategy.ts \
        api/src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts
git commit -m "$(cat <<'EOF'
feat(media-planner): route pdf_understanding capability_call through DocumentReviewStrategy

MediaPlannerStrategy gets one new optional dependency
(documentReviewExecutor). When wired and the capability plan's
canonical id (plan.id, not the possibly-aliased action.capability) is
pdf_understanding, the raw extraction is routed through the 3-critic
fan-out + synthesis instead of being returned untouched. Fails open
(identical to today's behavior) when the dependency isn't wired or the
capability result doesn't look like a PDF result — every other
capability's dispatch, and every existing test that doesn't wire the
new dependency, is unaffected.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Integration test — real multi-page PDF fixture, end to end, mocked critics only

**Files:**
- Create: `api/src/core/orchestration/strategies/__tests__/media-planner-document-review-integration.test.ts`

Proves the whole chain with a REAL PDF (built with `pdfkit`, same helper pattern as `pdf-service.test.ts`) run through the REAL `PDFService` extraction and the REAL `DocumentReviewStrategy`, with only the critic *judge clients* mocked (no real provider/cost) — so a real page-count/marker mismatch between `pdf-service.ts` and `DocumentReviewStrategy` would show up here even though neither component mocks the other.

- [ ] **Step 1: Write the test**

Create `api/src/core/orchestration/strategies/__tests__/media-planner-document-review-integration.test.ts`:

```typescript
/**
 * Integration: MediaPlannerStrategy → DocumentReviewStrategy → 3 real
 * DocumentJudgeEvaluator instances, over a REAL multi-page PDF built with
 * pdfkit and extracted by the REAL PDFService (real pdf-parse/pdfjs). Only
 * the judge CLIENTS are mocked (no real provider call, no real cost) — this
 * is the local-fixture integration test called for in the design spec's
 * Section C testing policy; the real-money batch (real critic-model calls)
 * is a separate, explicitly flagged step, never run automatically.
 */
import { describe, it, expect, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import type { ChatRequest, OrchestrationContext } from '@/types';
import type { CapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { CapabilityModeResult } from '@/routes/capabilities/capabilities-routes';

const engineExecute = vi.fn();
vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ execute: engineExecute }),
}));

const persistMediaPlanRunMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../media-planner-repository', () => ({
  persistMediaPlanRun: (...args: unknown[]) => persistMediaPlanRunMock(...args),
}));

const { MediaPlannerStrategy } = await import('../media-planner-strategy');
const { DocumentReviewStrategy } = await import('../document-review-strategy');
const { DocumentJudgeEvaluator } = await import('../evaluation/document-judge-evaluator');
const { PDFService } = await import('@/services/pdf-service');
import type { DocumentJudgeClient } from '../evaluation/document-judge-evaluator.types';

const USER_CONTEXT = { organizationId: 'org-test', userId: 'user-test' } as unknown as OrchestrationContext;

async function buildThreePagePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Each page's text must clear PDFService's MIN_PAGE_TEXT_CHARS (96) so
    // every page takes the native-text path — never the vision-OCR
    // fallback, which would need a real (or separately mocked) vision
    // provider this test deliberately has none of. See
    // api/src/services/__tests__/pdf-service.test.ts's own LONG_TEXT_A/B
    // fixtures for the same constraint.
    doc.fontSize(14).text(
      'This master service agreement is effective January 1 and governs the relationship ' +
        'between the parties. The total contract value stated in this agreement is $100,000.',
      72,
      100
    );
    doc.addPage();
    doc.fontSize(14).text(
      'Payment schedule: the total contract value referenced above is actually $120,000, ' +
        'payable in four equal installments over the twelve month term of this agreement.',
      72,
      100
    );
    doc.addPage();
    doc.fontSize(14).text(
      'Both parties agree to be bound by the terms and conditions described above, and each ' +
        'representative signing below confirms authority to execute this agreement.',
      72,
      100
    );
    doc.end();
  });
}

function makeInvoker(chat: ReturnType<typeof vi.fn>): CapabilityInvoker {
  return {
    chat,
    transcribe: vi.fn().mockRejectedValue(new Error('not implemented')),
    synthesize: vi.fn().mockRejectedValue(new Error('not implemented')),
    translate: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateVideo: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateImage: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateFile: vi.fn().mockRejectedValue(new Error('not implemented')),
  };
}

function chatJson(value: unknown) {
  return {
    id: 'r',
    object: 'chat.completion' as const,
    created: 0,
    model: 'planner-model',
    choices: [
      { index: 0, message: { role: 'assistant' as const, content: JSON.stringify(value) }, finish_reason: 'stop' as const, logprobs: null },
    ],
  };
}

describe('MediaPlannerStrategy + DocumentReviewStrategy — real PDF, real extraction, mocked critics', () => {
  it('cites the REAL page number of a real inconsistency planted in the fixture', async () => {
    const pdfBuffer = await buildThreePagePdf();
    const pdfService = new PDFService();

    // The factual_accuracy critic "finds" the $100,000 vs $120,000
    // contradiction planted on page 2 above — mocked client, but the
    // page number it cites must survive real extraction untouched.
    const factualClient: DocumentJudgeClient = {
      judgeDocument: vi.fn().mockResolvedValue({
        score: 0.2,
        verdict: 'fail',
        issues: [{ location: 2, severity: 'critical', description: 'contract value contradicts page 1 ($100,000 vs $120,000)' }],
      }),
    };
    const silentClient: DocumentJudgeClient = {
      judgeDocument: vi.fn().mockResolvedValue({ score: 0.9, verdict: 'pass', issues: [] }),
    };

    const baseConfig = { enabled: true, judgeModelId: 'judge-model', maxCostUsd: 0.01, timeoutMs: 5000, rubricVersion: 'v1' };
    const documentReviewExecutor = new DocumentReviewStrategy({
      critics: [
        { role: 'factual_accuracy', evaluator: new DocumentJudgeEvaluator({ ...baseConfig, criticRole: 'factual_accuracy' }, factualClient) },
        { role: 'required_clause_presence', evaluator: new DocumentJudgeEvaluator({ ...baseConfig, criticRole: 'required_clause_presence' }, silentClient) },
        { role: 'tone', evaluator: new DocumentJudgeEvaluator({ ...baseConfig, criticRole: 'tone' }, silentClient) },
      ],
    });

    // Synthesis call (getOrchestrationEngine().execute) — echo the single
    // finding back verbatim, grouped by its real page.
    engineExecute.mockResolvedValue({
      finalResponse: {
        model: 'synth-model',
        choices: [
          {
            message: {
              content: JSON.stringify({
                pages: [
                  {
                    page: 2,
                    issues: [
                      {
                        severity: 'critical',
                        description: 'contract value contradicts page 1 ($100,000 vs $120,000)',
                        sourceCritics: ['factual_accuracy'],
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
      totalCost: 0.001,
    });

    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(chatJson({ kind: 'capability_call', capability: 'pdf_understanding', body: {} }))
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'Found a contract value mismatch on page 2.', unmetConstraints: [] }));

    const context: OrchestrationContext = {
      organizationId: 'org-test',
      userId: 'user-test',
      requestId: 'req-integration',
      models: [],
      taskType: 'analysis',
      contextSize: 1000,
      invoker: makeInvoker(invokerChat),
    };

    const capabilityDispatcher = vi.fn().mockImplementation(async (plan) => {
      const analysis = await pdfService.analyzePDF({
        pdfBuffer,
        filename: 'contract.pdf',
        userContext: USER_CONTEXT,
        requestId: 'req-integration-pdf',
      });
      const result: CapabilityModeResult = {
        data: { text: analysis.text, metadata: analysis.metadata, extraction: analysis.extraction },
        executionPath: 'tool_pipeline',
      };
      expect(plan.id).toBe('pdf_understanding');
      return { result, fallbackUsed: false };
    });

    const strategy = new MediaPlannerStrategy({ capabilityDispatcher, documentReviewExecutor, maxTurns: 2 });
    const chatRequest: ChatRequest = { model: 'auto', messages: [{ role: 'user', content: 'review this contract' }] };
    const result = await strategy.execute(chatRequest, context);

    expect(factualClient.judgeDocument).toHaveBeenCalledTimes(1);
    const factualCall = (factualClient.judgeDocument as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The REAL extracted text (not a fixture string) must contain both real
    // page markers before it ever reaches the critic.
    expect(factualCall.documentText).toContain('[page 1]');
    expect(factualCall.documentText).toContain('[page 2]');
    expect(factualCall.documentText).toContain('[page 3]');
    expect(factualCall.documentText).toContain('$100,000');
    expect(factualCall.documentText).toContain('$120,000');

    const plan = result.metadata.plan as Array<{ outcome: Record<string, unknown> }>;
    const reviewOutcome = plan[0].outcome;
    expect(reviewOutcome.type).toBe('document_review_result');
    expect(reviewOutcome.pageCount).toBe(3);
    expect(reviewOutcome.issueCount).toBe(1);
    expect(reviewOutcome.summary).toContain('Page 2:');
    expect(result.metadata.stopReason).toBe('final');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-document-review-integration.test.ts`
Expected: PASS. If it fails on `factualCall.documentText` missing a page marker, that means something between `pdf-service.ts` and the dispatch guard broke the contract locked in Task 6 — do not weaken the assertion; find and fix the break.

- [ ] **Step 3: Commit**

```bash
git add api/src/core/orchestration/strategies/__tests__/media-planner-document-review-integration.test.ts
git commit -m "$(cat <<'EOF'
test(media-planner): add real-PDF, real-extraction integration test for document review

Runs MediaPlannerStrategy -> DocumentReviewStrategy -> DocumentJudgeEvaluator
over a real pdfkit-built 3-page PDF through the real PDFService
extraction (only the judge CLIENTS are mocked, zero real cost),
proving a planted factual inconsistency's real page number survives
extraction, fan-out, and synthesis end to end.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Production wiring — construct `DocumentReviewStrategy` at the media-plan route

**Files:**
- Modify: `api/src/routes/capabilities/capabilities-routes.ts`

Safe-by-default: `critics: []` (see Investigation Finding 7) — `DocumentReviewStrategy` degrades explicitly (Task 4) rather than doing anything with real cost. Real critic instances (real judge model ids) are a follow-up once a model-selection story for this role exists, out of this plan's scope.

- [ ] **Step 1: Add the import**

In `api/src/routes/capabilities/capabilities-routes.ts`, add near the existing `MediaConsensusStrategy`/`MediaPlannerStrategy` imports:

```typescript
import { DocumentReviewStrategy } from '@/core/orchestration/strategies/document-review-strategy';
```

- [ ] **Step 2: Wire `documentReviewExecutor` at the `/v1/capabilities/media-plan/execute` construction site**

In the same file, extend the `new MediaPlannerStrategy({...})` call (currently `capabilities-routes.ts:2235-2266`) by adding one field after `mediaConsensusExecutor`:

```typescript
        mediaConsensusExecutor: new MediaConsensusStrategy({
          videoService,
          imagesService: imageService,
        }),
        // Document/PDF generalization (Section C). Same safe-by-default
        // posture as mediaConsensusExecutor above: critics intentionally
        // NOT wired yet (empty array) — DocumentJudgeEvaluator needs a real
        // judge-model id per critic role, a separate piece of work. With
        // zero critics, DocumentReviewStrategy degrades explicitly
        // (degradedReason: 'no_document_critics_configured') instead of
        // silently doing nothing — pdf_understanding still returns its raw
        // extraction via the unchanged capability_result fallback path.
        documentReviewExecutor: new DocumentReviewStrategy({ critics: [] }),
      });
```

- [ ] **Step 3: Typecheck**

Run: `cd api && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Run the media-planner and document-review test suites as a full regression pass**

Run: `cd api && npx vitest run src/core/orchestration/strategies/__tests__/media-planner-strategy.test.ts src/core/orchestration/strategies/__tests__/media-planner-document-review-integration.test.ts src/core/orchestration/strategies/document-review-strategy.test.ts src/core/orchestration/strategies/evaluation`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/capabilities/capabilities-routes.ts
git commit -m "$(cat <<'EOF'
feat(media-planner): wire DocumentReviewStrategy into the media-plan route

Same safe-by-default posture as mediaConsensusExecutor's existing
empty-critics wiring: DocumentReviewStrategy is constructed with
critics: [], so pdf_understanding keeps returning raw extraction
(via the explicit degrade path) until real document-critic instances
are wired in a follow-up. Zero behavior change for any existing
non-PDF capability_call.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Real-money batch — DO NOT RUN WITHOUT EXPLICIT USER GO-AHEAD

**This section is intentionally separate from the TDD task list above and is never executed automatically as part of implementing this plan.** Every task above uses only mocked provider/judge clients and costs nothing to run.

Per the design spec's §C testing policy and cross-cutting rollout policy (spec §0): *"one run with real critic-model calls against a real multi-page document, to sanity-check citation accuracy isn't a mocked artifact."* This also needs Section A's real-critic-wiring infrastructure to be live per the spec's "Dependencies between sections" note (Section C's fan-out machinery can be built and unit-tested independently — done above — but real-provider validation needs a real judge model resolvable and callable, which is what Section A's production wiring establishes).

Before running any of this:
1. Confirm Section A's real judge/critic wiring has landed and a real, vision-*not*-required (text-only) judge model id is available and budgeted.
2. Construct three real `DocumentJudgeEvaluator` instances backed by a real `ProviderDocumentJudgeClient` (registry-backed, real `judgeModelId`, non-zero `maxCostUsd`) for `factual_accuracy`/`required_clause_presence`/`tone`, and pass them into a `DocumentReviewStrategy({ critics: [...] })` — this is a one-off script/harness, NOT the `critics: []` production wiring from Task 9 (which stays empty until this validation is done and a decision is made to wire real critics permanently).
3. Pick one real multi-page document (a real contract, report, or similar — ideally with at least one deliberately planted, known inconsistency so citation accuracy can be checked against ground truth) and run it through `PDFService.analyzePDF()` → `DocumentReviewStrategy.execute()` directly (bypassing the planner loop is fine for this sanity check — the planner-loop wiring is already proven by Task 8's mocked-client integration test).
4. **Cost estimate before running:** 3 critic calls (1 judge-model call each) + 1 synthesis call = 4 real LLM calls total for one document. Estimate actual USD cost using the chosen judge model's published per-token pricing and the document's approximate token count (`documentText.length / 4` as a rough token estimate) before running.
5. Manually verify: every page number the final report cites matches a real `[page N]` marker's actual position in the source document, and no issue is reported on a page that doesn't exist (`page <= pageCount`).
6. Report the outcome (cost actually incurred, citation accuracy found) back before considering Section C's real-provider validation complete.

- [ ] **(Flagged, not part of the main task list) Real critic-model + real document validation run — requires explicit go-ahead and a cost estimate confirmed by the user before executing.**
