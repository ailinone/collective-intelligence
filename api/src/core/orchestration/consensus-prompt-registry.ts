// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §7.5 — Consensus Prompt Registry.
 *
 * Maps each consensus role to its CANONICAL prompt template metadata so
 * `buildMultiRolePromptTrace` can compute the runtime trace + fingerprint
 * without invoking any adapter or strategy executor.
 *
 * Source-of-truth bindings:
 *   - participant   → PROMPTS.consensusVoter      (sota-system-prompts.ts)
 *   - synthesizer   → PROMPTS.consensusSynthesizer (sota-system-prompts.ts)
 *   - judge         → llmJudgeEvaluatorInternal    (built internally by
 *                       LLMJudgeEvaluator — surfaced here as opaque id +
 *                       rubric version fingerprint)
 *   - fallback /    → AILIN_FALLBACK_PROMPT       (fallback-prompt.ts)
 *     fallbackSingle
 *
 * Versions are pinned per template. ANY meaningful edit to the canonical
 * wording in `sota-system-prompts.ts` MUST bump the corresponding `version`
 * here — that bump propagates to `promptFingerprint`, which propagates to
 * `planFingerprint`, which invalidates any approved-but-not-yet-executed
 * plan. This is the imutabilidade contract.
 */
import { PROMPTS } from './prompts/sota-system-prompts';
import { AILIN_FALLBACK_PROMPT } from './prompts/fallback-prompt';
import type {
  PromptRuntimeTraceRole,
  PromptTemplateRegistry,
  PromptTemplateRegistryEntry,
} from './prompt-runtime-trace';

/**
 * Pin a version per role. Bump when the wording in the source file
 * changes meaningfully (slot system, depth directive, etc.).
 */
const ROLE_VERSIONS: Readonly<Record<Exclude<PromptRuntimeTraceRole, 'unknown'>, string>> = {
  participant: 'consensusVoter@2026-05-12',
  synthesizer: 'consensusSynthesizer@2026-05-12',
  judge: 'llmJudgeEvaluatorInternal@2026-05-12',
  fallback: 'ailinFallback@2026-05-12',
  fallbackSingle: 'ailinFallback@2026-05-12',
};

const PARTICIPANT_ENTRY: PromptTemplateRegistryEntry = {
  id: 'consensusVoter',
  path: 'src/core/orchestration/prompts/sota-system-prompts.ts',
  version: ROLE_VERSIONS.participant,
  variablesRequired: ['promptSlots'],
  adapterPayloadFormat: 'openai_chat_messages',
  getBody: (vars) => {
    // 01C.1B-G4 — PROMPTS.consensusVoter is a function that takes optional
    // slots. We treat `promptSlots` as the only variable; when absent, the
    // template still renders (slots are optional).
    const slots = vars.promptSlots as Parameters<typeof PROMPTS.consensusVoter>[0] | undefined;
    return PROMPTS.consensusVoter(slots);
  },
};

const SYNTHESIZER_ENTRY: PromptTemplateRegistryEntry = {
  id: 'consensusSynthesizer',
  path: 'src/core/orchestration/prompts/sota-system-prompts.ts',
  version: ROLE_VERSIONS.synthesizer,
  variablesRequired: [],
  adapterPayloadFormat: 'openai_chat_messages',
  getBody: () => PROMPTS.consensusSynthesizer,
};

/**
 * 01C.1B-G4 — Judge prompt is built INSIDE LLMJudgeEvaluator (not exposed
 * as a static string). For trace purposes we surface a stable identifier
 * + rubric version so:
 *   1. operators can prove the judge has a defined prompt-template
 *      identity in the plan;
 *   2. changing the rubric version changes the fingerprint.
 *
 * The `getBody` returns a deterministic header that encodes the rubric
 * version and the judge's evaluator id — NOT the user's task content,
 * NOT the model output. The actual judge prompt is built per-call by the
 * LLMJudgeClient and is bounded by `maxCostUsd` + `timeoutMs`.
 */
function buildJudgeBody(vars: Readonly<Record<string, unknown>>): string {
  const rubricVersion = String(vars.rubricVersion ?? 'unset');
  const judgeModelId = String(vars.judgeModelId ?? 'unset');
  return `[llm-judge-evaluator]\nrubricVersion=${rubricVersion}\njudgeModelId=${judgeModelId}\nadapter=structured_json_response`;
}

const JUDGE_ENTRY: PromptTemplateRegistryEntry = {
  id: 'llmJudgeEvaluatorInternal',
  path: 'src/core/orchestration/strategies/evaluation/llm-judge-evaluator.ts',
  version: ROLE_VERSIONS.judge,
  variablesRequired: ['rubricVersion', 'judgeModelId'],
  adapterPayloadFormat: 'structured_json_judge_response',
  getBody: buildJudgeBody,
};

const FALLBACK_ENTRY: PromptTemplateRegistryEntry = {
  id: 'fallbackPrompt',
  path: 'src/core/orchestration/prompts/fallback-prompt.ts',
  version: ROLE_VERSIONS.fallback,
  variablesRequired: ['where'],
  adapterPayloadFormat: 'openai_chat_messages',
  getBody: () => AILIN_FALLBACK_PROMPT,
};

/**
 * The production registry used by the consensus dry-run service.
 *
 * `unknown` is intentionally omitted — the trace builder yields a
 * `template_not_found` issue if a plan ever associates a role with the
 * `unknown` tag.
 */
export const CONSENSUS_PROMPT_REGISTRY: PromptTemplateRegistry = new Map<
  PromptRuntimeTraceRole,
  PromptTemplateRegistryEntry
>([
  ['participant', PARTICIPANT_ENTRY],
  ['synthesizer', SYNTHESIZER_ENTRY],
  ['judge', JUDGE_ENTRY],
  ['fallback', FALLBACK_ENTRY],
  ['fallbackSingle', FALLBACK_ENTRY],
]);
