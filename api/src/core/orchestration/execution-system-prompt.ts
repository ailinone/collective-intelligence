// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Execution System Prompt
 *
 * Builds a SOTA-level system prompt for execution models that explains:
 * - What the platform is and what it can do
 * - The model's role in the current strategy
 * - Available capabilities (tools, image gen, web search, etc.)
 * - How to leverage the system's collective intelligence
 *
 * This is injected into the request messages BEFORE execution, only when
 * the user hasn't already provided a system message. The triage LLM may
 * also provide a task-specific system prompt for multi-stage plans — when
 * that exists, it takes precedence.
 *
 * Design: The prompt is concise (<500 tokens) to avoid wasting context window.
 * It adapts based on the detected task type and required capabilities.
 */

import type { ChatRequest, OrchestrationContext, ModelCapability } from '@/types';
import { renderSlotAugmentation, hashSlotValues, validatePromptSlots } from './prompts/prompt-slots';
import { incrementPromptMetric } from './prompts/prompt-metrics';
import { LANGUAGE_MIRROR_DIRECTIVE } from './prompts/language-directive';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'execution-system-prompt' });

/**
 * Build an execution system prompt based on context.
 * Returns null if a system message already exists in the request.
 */
export function buildExecutionSystemPrompt(
  request: ChatRequest,
  context: OrchestrationContext,
): string | null {
  // Don't override existing system messages
  const hasSystemMessage = request.messages.some(m => m.role === 'system');
  if (hasSystemMessage) return null;

  const taskType = context.taskType || 'general';
  const capabilities = context.requiredCapabilities ?? [];

  const sections: string[] = [];

  // Core identity — what the platform is
  sections.push(
    'You are an AI assistant powered by a collective intelligence orchestration platform. ' +
    'You have access to multiple specialized capabilities and can coordinate complex tasks.'
  );

  // Capability awareness — what the model can do within the system
  const capabilityDescriptions = buildCapabilitySection(capabilities);
  if (capabilityDescriptions) {
    sections.push(capabilityDescriptions);
  }

  // Task-specific guidance
  const taskGuidance = buildTaskGuidance(taskType);
  if (taskGuidance) {
    sections.push(taskGuidance);
  }

  // R11: strategy-awareness framing uses the authoritative collective flag set
  // by orchestration-engine from the resolved strategy's own metadata. This
  // replaces a previously hardcoded allowlist that missed debate, consensus,
  // blind-debate, expert-panel, war-room and other real collective strategies.
  if (context.isCollectiveStrategy) {
    sections.push(
      'You are participating in a collective intelligence strategy where multiple AI models ' +
      'collaborate to produce the best possible answer. Focus on your specific strengths ' +
      'and provide your most rigorous, well-reasoned contribution.'
    );
  }

  // R1: task-specific context fabricated by triage. Short augmentation (<=400 chars),
  // NOT a replacement for the strategy prompt. Appears as the last section so it is
  // read as the most task-specific signal in the prompt. We read from the canonical
  // `context.executionPlan` field first, falling back to the triage decision's plan.
  const taskContext = resolveTaskContext(context);
  if (taskContext) {
    sections.push(`Task context: ${taskContext}`);
  }

  // R7: the prior quality footer ("Provide thorough, accurate, and well-structured
  // responses...") was removed. Every collective strategy prompt in the catalog
  // already states the quality bar with role-specific language, and the single-stage
  // task guidance section above already covers task-specific rigor. The footer was
  // adding ~40 tokens of generic framing with no differential signal for the model.

  // Universal language policy — mirror the user's language across the whole answer
  // (ANY language, no hardcoded list). Placed LAST so it is the strongest signal.
  sections.push(LANGUAGE_MIRROR_DIRECTIVE);

  return sections.join('\n\n');
}

/**
 * Resolve the task-specific context string emitted by triage for the current stage.
 * Prefers `context.executionPlan` (the engine-resolved plan) and falls back to the
 * raw triage decision's plan. Returns the first stage's context since the
 * single-stage builder path only ever executes stage[0].
 *
 * Precedence (first non-empty wins):
 *   1. Typed prompt slots (structured, Zod-validated, hashed)
 *   2. Augmentation sandbox (free-form, deny-pattern validated)
 *   3. Legacy taskContext blob (<=400 chars)
 */
function resolveTaskContext(context: OrchestrationContext): string | undefined {
  const plan = context.executionPlan ?? context.triage?.executionPlan;
  const firstStage = plan?.stages?.[0];
  if (!firstStage) return undefined;

  // 1. Structured slots (preferred)
  if (firstStage.promptSlots) {
    const slots = validatePromptSlots(firstStage.promptSlots, 'execution-system-prompt.resolve');
    if (slots) {
      const rendered = renderSlotAugmentation(slots);
      if (rendered) {
        log.debug(
          { requestId: context.requestId, slotHash: hashSlotValues(slots) },
          'Task context resolved from typed prompt slots',
        );
        return rendered;
      }
    }
  }

  // 2. Augmentation sandbox (free-form, for novel tasks).
  // F3-AUG: augmentation is only consumed when ALL of:
  //   (a) ENABLE_PROMPT_AUGMENTATION_SANDBOX flag is ON
  //   (b) triage confidence is below threshold (default 0.6)
  //   (c) the content passed the deny-pattern schema validation
  // This prevents augmentation from being used on routine tasks where the
  // canonical prompt already covers the need, limiting it to genuinely
  // novel/uncertain tasks where the triage LLM explicitly signals low
  // confidence.
  if (firstStage.augmentation) {
    const augFlag = process.env.ENABLE_PROMPT_AUGMENTATION_SANDBOX === 'true';
    if (!augFlag) {
      incrementPromptMetric('ailin_prompt_augmentation_rejected_total', {
        reason: 'flag-off',
      });
      log.debug('Augmentation present but ENABLE_PROMPT_AUGMENTATION_SANDBOX is off — ignoring');
    } else {
      const triageConfidence = context.triage?.confidence ?? 1.0;
      const threshold = parseFloat(process.env.PROMPT_AUGMENTATION_CONFIDENCE_THRESHOLD || '0.6');
      if (triageConfidence < threshold) {
        incrementPromptMetric('ailin_prompt_augmentation_accepted_total', {
          requestId: context.requestId ?? 'unknown',
          confidence: String(triageConfidence),
        });
        return `Task-specific guidance: ${firstStage.augmentation}`;
      } else {
        incrementPromptMetric('ailin_prompt_augmentation_rejected_total', {
          reason: 'confidence-above-threshold',
          confidence: String(triageConfidence),
          threshold: String(threshold),
        });
        log.debug(
          { triageConfidence, threshold },
          'Augmentation present but triage confidence above threshold — ignoring',
        );
      }
    }
  }

  // 3. Legacy blob fallback
  return firstStage.taskContext;
}

/**
 * Capability-awareness section (R6).
 *
 * The prior implementation emitted a bulleted list of verbose capability
 * descriptions ("Generate images from text descriptions", "Analyze and
 * understand images provided in the conversation", ...). For modern SOTA
 * models these descriptions carry zero differential signal — the model knows
 * what `web_search` means without a sentence explaining it.
 *
 * R6 replaces the bulleted descriptions with a single-line tag list that
 * preserves the only information the model actually needs: WHICH capabilities
 * are available for this request. The list is only emitted when there are
 * capabilities known to the catalog; empty or unknown lists skip the section.
 */
const KNOWN_CAPABILITY_TAGS: ReadonlySet<string> = new Set([
  'image_generation', 'vision', 'multimodal', 'tool_use', 'function_calling',
  'web_search', 'deep_research', 'code_generation', 'code_execution', 'reasoning',
  'audio_generation', 'text_to_speech', 'video_generation', 'computer_use',
  'mcp', 'pdf_understanding',
]);

function buildCapabilitySection(capabilities: (string | ModelCapability)[]): string | null {
  if (capabilities.length === 0) return null;

  const relevant = capabilities
    .map((cap) => String(cap))
    .filter((cap) => KNOWN_CAPABILITY_TAGS.has(cap));

  if (relevant.length === 0) return null;

  return `Available capabilities: ${relevant.join(', ')}`;
}

function buildTaskGuidance(taskType: string): string | null {
  const guidance: Record<string, string> = {
    'code-generation': 'Focus on producing correct, well-typed, production-quality code with proper error handling.',
    'code-review': 'Analyze code for bugs, security issues, performance problems, and suggest concrete improvements.',
    'analysis': 'Provide structured, evidence-based analysis with clear reasoning and actionable conclusions.',
    'debugging': 'Identify root causes systematically. Explain the mechanism of the bug and provide tested fixes.',
    'creative': 'Be creative, original, and engaging while staying true to the request constraints.',
    'documentation': 'Write clear, comprehensive documentation suitable for the target audience.',
    'refactoring': 'Improve code structure while preserving behavior. Explain each refactoring decision.',
    'reasoning': 'Think step-by-step. Show your reasoning process explicitly.',
  };

  return guidance[taskType] ?? null;
}

// Strategy-awareness framing has moved inline into buildExecutionSystemPrompt (R11):
// it now keys off context.isCollectiveStrategy, which is the authoritative flag set
// by orchestration-engine from the resolved strategy's metadata. The previous
// hardcoded allowlist of collective strategy names has been removed — it drifted
// from the strategy registry and missed several real collective strategies.

/**
 * Inject the execution system prompt into the request messages.
 * Modifies the request in-place (adds system message at index 0).
 * Returns true if a prompt was injected, false if skipped.
 */
export function injectExecutionSystemPrompt(
  request: ChatRequest,
  context: OrchestrationContext,
): boolean {
  const prompt = buildExecutionSystemPrompt(request, context);
  if (!prompt) return false;

  request.messages = [
    { role: 'system', content: prompt },
    ...request.messages,
  ];

  return true;
}
