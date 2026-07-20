// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler.ts — MVP 6A
 *
 * Pure, heuristic, local task profiler.
 *
 * MVP 6A invariants:
 *   - Pure function. No I/O. No DB. No provider. No TEI. No HNSW.
 *   - Deterministic — no Date.now, no Math.random.
 *   - Does NOT mutate input.
 *   - NO model/provider names anywhere. Capability + risk heuristics
 *     are functional vocabulary only (`json`, `code`, `legal`, ...).
 *   - Does NOT select modelId / providerId / routeId.
 *   - Does NOT call LLM for triage.
 *   - Output `TaskProfile` is categorical; trace builder strips text.
 *
 * Heuristic order (each step contributes signals; categorisation
 * happens at the end):
 *   1. Compute total context tokens.
 *   2. Scan text for functional vocabulary.
 *   3. Classify attachments → modalities + capability bumps.
 *   4. Derive taskType from strongest signal cluster.
 *   5. Derive complexity from tokens + signal multiplicity.
 *   6. Derive riskLevel from domain vocabulary.
 *   7. Derive privacyMode (explicit wins, then vocabulary, else standard).
 *   8. Derive costSensitivity (explicit wins, default low).
 *   9. Build capability + strategyHint lists.
 *  10. Pack TaskProfile.
 */

import type {
  Complexity,
  PrivacyMode,
  RiskLevel,
  Sensitivity,
  StrategyHint,
  TaskProfile,
  TaskProfilerInput,
  TaskType,
  Modality,
  OutputFormat,
  ToolUseRequirement,
} from './task-profile-types';
import {
  AGENTIC_TERMS,
  ANALYSIS_TERMS,
  CODE_TERMS,
  CREATIVE_TERMS,
  FINANCE_TERMS,
  FRESHNESS_TERMS,
  JSON_OUTPUT_TERMS,
  LEGAL_TERMS,
  MATH_TERMS,
  MARKDOWN_OUTPUT_TERMS,
  MEDICAL_TERMS,
  MULTI_DOCUMENT_TERMS,
  PRIVACY_PREFERRED_TERMS,
  PRODUCTION_TERMS,
  REASONING_TERMS,
  SECURITY_TERMS,
  SUMMARIZATION_TERMS,
  TABLE_OUTPUT_TERMS,
  TOOL_USE_TERMS,
  resolveTaskProfilerPolicy,
  type TaskProfilerPolicy,
} from './task-profiler-policy';
import {
  containsAnyWord,
  estimateTotalInputTokens,
  sortedUnique,
} from './task-profile-normalizer';

// ─── Signal extraction ─────────────────────────────────────────────────

interface TextSignals {
  readonly hasJson: boolean;
  readonly hasTable: boolean;
  readonly hasMarkdown: boolean;
  readonly hasCode: boolean;
  readonly hasMath: boolean;
  readonly hasAnalysis: boolean;
  readonly hasSummary: boolean;
  readonly hasCreative: boolean;
  readonly hasReasoning: boolean;
  readonly hasAgentic: boolean;
  readonly hasMultiDocument: boolean;
  readonly hasToolUse: boolean;
  readonly hasFreshness: boolean;
  readonly hasLegal: boolean;
  readonly hasFinance: boolean;
  readonly hasMedical: boolean;
  readonly hasSecurity: boolean;
  readonly hasProduction: boolean;
  readonly hasPrivacyPreferred: boolean;
}

function extractTextSignals(text: string): TextSignals {
  if (!text || text.length === 0) {
    return {
      hasJson: false,
      hasTable: false,
      hasMarkdown: false,
      hasCode: false,
      hasMath: false,
      hasAnalysis: false,
      hasSummary: false,
      hasCreative: false,
      hasReasoning: false,
      hasAgentic: false,
      hasMultiDocument: false,
      hasToolUse: false,
      hasFreshness: false,
      hasLegal: false,
      hasFinance: false,
      hasMedical: false,
      hasSecurity: false,
      hasProduction: false,
      hasPrivacyPreferred: false,
    };
  }
  return {
    hasJson: containsAnyWord(text, JSON_OUTPUT_TERMS),
    hasTable: containsAnyWord(text, TABLE_OUTPUT_TERMS),
    hasMarkdown: containsAnyWord(text, MARKDOWN_OUTPUT_TERMS),
    hasCode: containsAnyWord(text, CODE_TERMS),
    hasMath: containsAnyWord(text, MATH_TERMS),
    hasAnalysis: containsAnyWord(text, ANALYSIS_TERMS),
    hasSummary: containsAnyWord(text, SUMMARIZATION_TERMS),
    hasCreative: containsAnyWord(text, CREATIVE_TERMS),
    hasReasoning: containsAnyWord(text, REASONING_TERMS),
    hasAgentic: containsAnyWord(text, AGENTIC_TERMS),
    hasMultiDocument: containsAnyWord(text, MULTI_DOCUMENT_TERMS),
    hasToolUse: containsAnyWord(text, TOOL_USE_TERMS),
    hasFreshness: containsAnyWord(text, FRESHNESS_TERMS),
    hasLegal: containsAnyWord(text, LEGAL_TERMS),
    hasFinance: containsAnyWord(text, FINANCE_TERMS),
    hasMedical: containsAnyWord(text, MEDICAL_TERMS),
    hasSecurity: containsAnyWord(text, SECURITY_TERMS),
    hasProduction: containsAnyWord(text, PRODUCTION_TERMS),
    hasPrivacyPreferred: containsAnyWord(text, PRIVACY_PREFERRED_TERMS),
  };
}

// ─── Modality + attachment classification ───────────────────────────────

interface AttachmentSignals {
  readonly hasImage: boolean;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly hasDocument: boolean;
  readonly hasSpreadsheet: boolean;
  readonly hasCodeAttachment: boolean;
  readonly count: number;
}

function extractAttachmentSignals(
  attachments: readonly { kind: string }[] | undefined,
): AttachmentSignals {
  if (!attachments) {
    return {
      hasImage: false,
      hasAudio: false,
      hasVideo: false,
      hasDocument: false,
      hasSpreadsheet: false,
      hasCodeAttachment: false,
      count: 0,
    };
  }
  let img = false;
  let aud = false;
  let vid = false;
  let doc = false;
  let sheet = false;
  let codeAtt = false;
  for (const a of attachments) {
    if (a.kind === 'image') img = true;
    else if (a.kind === 'audio') aud = true;
    else if (a.kind === 'video') vid = true;
    else if (a.kind === 'document') doc = true;
    else if (a.kind === 'spreadsheet') sheet = true;
    else if (a.kind === 'code') codeAtt = true;
  }
  return {
    hasImage: img,
    hasAudio: aud,
    hasVideo: vid,
    hasDocument: doc,
    hasSpreadsheet: sheet,
    hasCodeAttachment: codeAtt,
    count: attachments.length,
  };
}

// ─── TaskType derivation ────────────────────────────────────────────────

function deriveTaskType(
  text: TextSignals,
  att: AttachmentSignals,
  explicitOutput?: OutputFormat,
  explicitToolUse?: ToolUseRequirement,
): TaskType {
  // Modality-bound types win first.
  if (att.hasImage) return 'vision';
  if (att.hasAudio) return 'audio';
  // Strong text signals.
  if (text.hasAgentic || (explicitToolUse === 'required' && text.hasAgentic)) {
    return 'agentic';
  }
  if (explicitToolUse === 'required' || text.hasToolUse) {
    return 'tool_use';
  }
  if (
    explicitOutput === 'json' ||
    explicitOutput === 'table' ||
    text.hasJson ||
    text.hasTable
  ) {
    return 'structured_generation';
  }
  if (text.hasCode || att.hasCodeAttachment) return 'code';
  if (text.hasMath) return 'math';
  if (text.hasSummary) return 'summarization';
  if (text.hasAnalysis) return 'analysis';
  if (text.hasCreative) return 'creative';
  if (text.hasReasoning) return 'reasoning';
  // No specific signal — fall back to factual (when text present) or unknown.
  return 'factual';
}

// ─── Complexity derivation ──────────────────────────────────────────────

function deriveComplexity(
  totalTokens: number,
  text: TextSignals,
  att: AttachmentSignals,
  policy: TaskProfilerPolicy,
  taskType: TaskType,
): Complexity {
  const t = policy.tokenThresholds;

  // Extreme triggers (any one):
  //   - agentic + multi-document
  //   - multi-document text signal
  //   - tokens above `high` threshold
  //   - tokens above `medium` AND many attachments
  if (
    (text.hasAgentic && text.hasMultiDocument) ||
    text.hasMultiDocument ||
    totalTokens > t.high ||
    (totalTokens > t.medium && att.count >= policy.attachmentBumps.multiDocumentThreshold)
  ) {
    return 'extreme';
  }

  // High: large input, code, math, analysis of attachments, reasoning-heavy.
  if (
    totalTokens > t.medium ||
    taskType === 'code' ||
    taskType === 'math' ||
    taskType === 'agentic' ||
    taskType === 'analysis' ||
    (text.hasReasoning && totalTokens > t.low) ||
    att.count >= 2
  ) {
    return 'high';
  }

  // Medium: moderate text or single document/spreadsheet/codeAttachment.
  if (
    totalTokens > t.low ||
    att.hasDocument ||
    att.hasSpreadsheet ||
    att.hasCodeAttachment ||
    text.hasAnalysis ||
    text.hasReasoning
  ) {
    return 'medium';
  }

  return 'low';
}

// ─── RiskLevel derivation ──────────────────────────────────────────────

function deriveRiskLevel(text: TextSignals): RiskLevel {
  if (
    text.hasLegal ||
    text.hasFinance ||
    text.hasMedical ||
    text.hasSecurity ||
    text.hasProduction
  ) {
    return 'high';
  }
  if (
    text.hasAnalysis ||
    text.hasMath ||
    text.hasCode ||
    text.hasReasoning ||
    text.hasAgentic
  ) {
    return 'medium';
  }
  return 'low';
}

// ─── Privacy derivation ─────────────────────────────────────────────────

function derivePrivacyMode(
  input: TaskProfilerInput,
  text: TextSignals,
): PrivacyMode {
  if (input.explicitPrivacyMode) return input.explicitPrivacyMode;
  if (text.hasPrivacyPreferred) return 'local_preferred';
  return 'standard';
}

// ─── Cost / latency derivation ──────────────────────────────────────────

function deriveCostSensitivity(input: TaskProfilerInput): Sensitivity {
  if (input.explicitCostSensitivity) return input.explicitCostSensitivity;
  return 'low';
}

// ─── Capabilities derivation ────────────────────────────────────────────

function deriveCapabilities(
  text: TextSignals,
  att: AttachmentSignals,
  totalTokens: number,
  policy: TaskProfilerPolicy,
  explicitOutput?: OutputFormat,
  explicitToolUse?: ToolUseRequirement,
): { required: readonly string[]; desired: readonly string[] } {
  const required = new Set<string>();
  const desired = new Set<string>();

  // chat is the universal baseline.
  required.add('chat');

  if (explicitOutput === 'json' || text.hasJson) required.add('json_mode');
  if (explicitOutput === 'table' || text.hasTable) desired.add('json_mode');
  if (att.hasImage) required.add('vision');
  if (att.hasAudio) required.add('audio_generation');
  if (text.hasCode || att.hasCodeAttachment) required.add('code');
  if (text.hasMath) required.add('math');
  if (explicitToolUse === 'required' || text.hasToolUse) required.add('tools');
  if (explicitToolUse === 'optional') desired.add('tools');
  if (totalTokens >= policy.tokenThresholds.longContext) {
    required.add('long_context');
  }
  if (text.hasReasoning) desired.add('reasoning');
  if (text.hasAgentic) desired.add('tools');

  return {
    required: sortedUnique(Array.from(required)),
    desired: sortedUnique(Array.from(desired)),
  };
}

// ─── Modalities derivation ──────────────────────────────────────────────

function deriveModalities(att: AttachmentSignals): readonly Modality[] {
  const set = new Set<Modality>(['text']);
  if (att.hasImage) set.add('image');
  if (att.hasAudio) set.add('audio');
  if (att.hasVideo) set.add('video');
  return sortedUnique(Array.from(set));
}

// ─── Strategy hints derivation ──────────────────────────────────────────

function deriveStrategyHints(
  taskType: TaskType,
  complexity: Complexity,
  riskLevel: RiskLevel,
  privacyMode: PrivacyMode,
  costSensitivity: Sensitivity,
): readonly StrategyHint[] {
  const set = new Set<StrategyHint>();

  if (privacyMode !== 'standard') set.add('local_first');
  if (costSensitivity === 'high') set.add('cost_cascade');

  if (complexity === 'low' && riskLevel === 'low') {
    set.add('single_best');
  }
  if (complexity === 'medium') {
    set.add('single_best');
  }
  if (complexity === 'high') {
    set.add('quality_cascade');
    set.add('critique_repair');
  }
  if (complexity === 'extreme') {
    set.add('critique_repair');
    set.add('expert_panel');
    set.add('parallel_diverse');
  }
  if (riskLevel === 'high') {
    set.add('consensus');
    set.add('expert_panel');
  }
  if (taskType === 'structured_generation') {
    set.add('single_best');
    set.add('quality_cascade');
  }

  if (set.size === 0) set.add('single_best');

  // Deterministic order: hints are typed strings, sort alphabetically.
  return sortedUnique(Array.from(set));
}

// ─── Output / freshness / toolUse derivation ───────────────────────────

function deriveOutputFormat(
  text: TextSignals,
  explicit?: OutputFormat,
): readonly OutputFormat[] | undefined {
  if (explicit) return Object.freeze([explicit]);
  const out: OutputFormat[] = [];
  if (text.hasJson) out.push('json');
  if (text.hasMarkdown) out.push('markdown');
  if (text.hasTable) out.push('table');
  if (out.length === 0) return undefined;
  return Object.freeze([...new Set(out)].sort());
}

function deriveFreshness(text: TextSignals): TaskProfile['freshnessRequirement'] {
  if (text.hasFreshness) return 'recent';
  return undefined;
}

function deriveToolUseRequirement(
  text: TextSignals,
  explicit?: ToolUseRequirement,
): ToolUseRequirement | undefined {
  if (explicit) return explicit;
  if (text.hasToolUse) return 'optional';
  return undefined;
}

// ─── Confidence derivation ──────────────────────────────────────────────

function deriveConfidenceNeeded(
  riskLevel: RiskLevel,
  complexity: Complexity,
): number {
  // Higher risk → higher confidence required.
  if (riskLevel === 'high') return 0.95;
  if (riskLevel === 'medium' && complexity === 'high') return 0.85;
  if (riskLevel === 'medium') return 0.75;
  if (complexity === 'extreme') return 0.9;
  return 0.6;
}

// ─── Result wrapper ─────────────────────────────────────────────────────

export interface TaskProfilerResult {
  readonly profile: TaskProfile;
  readonly reasons: readonly string[];
}

// ─── Main entry ─────────────────────────────────────────────────────────

export function profileTask(
  input: TaskProfilerInput,
  policyOverride?: Partial<TaskProfilerPolicy>,
): TaskProfilerResult {
  const policy = resolveTaskProfilerPolicy(policyOverride);
  const text = input.text ?? '';
  const reasons: string[] = [];

  // 1. Extract signals.
  const textSignals = extractTextSignals(text);
  const attSignals = extractAttachmentSignals(input.attachments);

  // 2. Tokens.
  const totalTokens = estimateTotalInputTokens(input);
  if (totalTokens > 0) reasons.push(`total_tokens:${totalTokens}`);

  // 3. TaskType.
  const taskType = deriveTaskType(
    textSignals,
    attSignals,
    input.explicitOutputFormat,
    input.explicitToolUse,
  );
  reasons.push(`task_type:${taskType}`);

  // 4. Complexity.
  const complexity = deriveComplexity(totalTokens, textSignals, attSignals, policy, taskType);
  reasons.push(`complexity:${complexity}`);

  // 5. Risk.
  const riskLevel = deriveRiskLevel(textSignals);
  reasons.push(`risk:${riskLevel}`);

  // 6. Privacy.
  const privacyMode = derivePrivacyMode(input, textSignals);
  if (input.explicitPrivacyMode) {
    reasons.push(`privacy_explicit:${privacyMode}`);
  } else if (textSignals.hasPrivacyPreferred) {
    reasons.push('privacy_inferred_local_preferred');
  }

  // 7. Cost / latency.
  const costSensitivity = deriveCostSensitivity(input);
  const latencyBudgetMs = input.explicitLatencyBudgetMs;

  // 8. Capabilities + modalities.
  const { required, desired } = deriveCapabilities(
    textSignals,
    attSignals,
    totalTokens,
    policy,
    input.explicitOutputFormat,
    input.explicitToolUse,
  );
  const modalities = deriveModalities(attSignals);

  // 9. Strategy hints.
  const strategyHints = deriveStrategyHints(
    taskType,
    complexity,
    riskLevel,
    privacyMode,
    costSensitivity,
  );

  // 10. Outputs.
  const outputFormatRequirements = deriveOutputFormat(textSignals, input.explicitOutputFormat);
  const freshnessRequirement = deriveFreshness(textSignals);
  const toolUseRequirement = deriveToolUseRequirement(textSignals, input.explicitToolUse);
  const confidenceNeeded = deriveConfidenceNeeded(riskLevel, complexity);

  const profile: TaskProfile = {
    taskType,
    complexity,
    requiredCapabilities: required,
    desiredCapabilities: desired,
    modalities,
    contextRequirementTokens: totalTokens > 0 ? totalTokens : undefined,
    riskLevel,
    latencyBudgetMs,
    costSensitivity,
    privacyMode,
    confidenceNeeded,
    strategyHints,
    outputFormatRequirements,
    toolUseRequirement,
    freshnessRequirement,
  };

  return {
    profile,
    reasons: Object.freeze(reasons),
  };
}
