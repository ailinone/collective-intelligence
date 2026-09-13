// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier-1 Diagnostic Probe (Tiered Capability Fingerprint, "TCF").
 *
 * ONE real chat call per model that reveals up to eight capabilities in a
 * single response — see `capability/assertions/tier1-diagnostic-classifier.ts`
 * for the prompt and the structural (regex/JSON-parse) classification this
 * probe grades responses with FIRST, before ever considering a judge call.
 *
 * Shape deliberately mirrors `function-calling-probe.ts` (GAP-A13, the
 * established pattern for empirical capability probes in this codebase):
 *   - a per-process probe budget guard so a runaway sweep cannot mint
 *     unbounded provider calls even if the caller's own pacing has a bug;
 *   - `probe-liveness-classifier.ts` distinguishes "provider unreachable"
 *     (billing/auth/timeout/network — NOT a capability verdict) from a real
 *     structural result;
 *   - confirmed capabilities are persisted via the SAME append-only
 *     assertion log everything else uses (`recordProbeAssertions`,
 *     `source: 'runtime-probe'`), never a parallel cache.
 *
 * Differences from the FC probe, both intentional:
 *   - No Redis/memory result cache here. The FC probe is reached from the
 *     request-execution hot path and must answer instantly on a repeat
 *     lookup; this probe is reached only from the batch sweep job
 *     (`jobs/capability-fingerprint-job.ts`), which already decides ONCE
 *     per run which models are due and never asks twice in the same run.
 *   - Streaming is graded from TRANSPORT behavior (chunk count), not from
 *     response text — see `runTier1DiagnosticProbe`'s use of
 *     `chatCompletionStream`.
 *   - Ambiguous structural verdicts (currently only `translation`, whose
 *     correctness a regex cannot judge) go through an OPTIONAL judge
 *     fallback. Disabled by default — see `Tier1JudgeConfig` — matching
 *     this codebase's own established default for every LLM-judge call site
 *     (`evaluator-factory.ts`: "The factory NEVER constructs a real provider
 *     client"). Without an injected judge client, ambiguous capabilities are
 *     simply not asserted — never guessed.
 */

import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ChatRequest, ChatResponse } from '@/types';
import { logger } from '@/utils/logger';
import { incrementCounter, observeHistogram, METRIC_NAMES } from '@/core/operability/metrics';
import { isProviderLivenessError } from './probe-liveness-classifier';
import {
  buildTier1DiagnosticPrompt,
  classifyTier1StructuralSignals,
  type Tier1Capability,
  type Tier1StructuralVerdict,
} from '@/capability/assertions/tier1-diagnostic-classifier';

const log = logger.child({ component: 'tier1-diagnostic-probe' });

export const TIER1_ORIGIN = 'tier1-diagnostic-probe@v1';

const PROBE_TIMEOUT_MS = Number(process.env.TIER1_PROBE_TIMEOUT_MS ?? 20_000);
/** Same defense-in-depth role as `FC_PROBE_MAX_PROBES` — bounds a single
 *  process's real provider calls regardless of what the caller's own
 *  pacing intends. The sweep job's own bounded-concurrency + daily budget
 *  (see `jobs/capability-fingerprint-job.ts`) is the primary control; this
 *  is the last line of defense against a bug in that pacing. */
const MAX_PROBES_PER_PROCESS = Number(process.env.TIER1_PROBE_MAX_PROBES ?? 20_000);

let probesStarted = 0;

/** Test helper — reset the per-process counter between test cases. */
export function resetTier1ProbeForTesting(): void {
  probesStarted = 0;
}

/** Test/metrics helper. */
export function getTier1ProbeStats(): { started: number } {
  return { started: probesStarted };
}

export type Tier1JudgeVerdict = 'confirmed' | 'rejected';

/**
 * Minimal judge contract for resolving an AMBIGUOUS structural verdict.
 * Intentionally narrower than `LLMJudgeClient` (llm-judge-evaluator.types.ts)
 * — this only ever needs a yes/no on one already-extracted claim, not a
 * rubric score. No production implementation is wired by this change (see
 * module doc); tests inject a mock.
 */
export interface Tier1JudgeClient {
  judgeAmbiguousCapability(input: {
    capability: Tier1Capability;
    responseExcerpt: string;
  }): Promise<Tier1JudgeVerdict>;
}

export interface Tier1JudgeConfig {
  readonly enabled: boolean;
  readonly client?: Tier1JudgeClient;
}

function defaultJudgeConfig(): Tier1JudgeConfig {
  return { enabled: process.env.TIER1_JUDGE_ENABLED === 'true' };
}

export interface Tier1ProbeOutcome {
  readonly status: 'confirmed' | 'provider-dead' | 'inconclusive' | 'budget-exhausted';
  /** Capabilities confirmed (structurally or via judge) and persisted. Always
   *  empty when status !== 'confirmed'. Can ALSO be empty when status ===
   *  'confirmed' if the model responded but demonstrated none of the eight
   *  capabilities — that is a real, valid outcome, not an error. */
  readonly capabilitiesConfirmed: readonly Tier1Capability[];
  readonly capabilitiesAmbiguousUnresolved: readonly Tier1Capability[];
  readonly streamingChunkCount?: number;
}

async function collectStreamedResponse(
  adapter: ProviderAdapter,
  request: ChatRequest,
  timeoutMs: number
): Promise<{ text: string; chunkCount: number }> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  let chunkCount = 0;

  const iterator = adapter.chatCompletionStream(request)[Symbol.asyncIterator]();
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const step = await Promise.race<IteratorResult<ChatResponse, void>>([
      iterator.next(),
      new Promise((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining)
      ),
    ]);
    if (step.done) break;

    const chunk: ChatResponse = step.value;
    chunkCount++;
    const delta = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message;
    if (typeof delta?.content === 'string') {
      text += delta.content;
    }
  }

  return { text, chunkCount };
}

/**
 * Run the Tier-1 diagnostic probe against one (provider, model). Never
 * throws. `null`-shaped outcomes are folded into `status` rather than a
 * thrown error so a batch sweep can keep going after any single failure.
 */
export async function runTier1DiagnosticProbe(
  adapter: ProviderAdapter,
  provider: string,
  modelId: string,
  judgeConfig: Tier1JudgeConfig = defaultJudgeConfig()
): Promise<Tier1ProbeOutcome> {
  if (probesStarted >= MAX_PROBES_PER_PROCESS) {
    log.warn({ probesStarted }, 'Tier-1 probe budget exhausted — skipping');
    incrementCounter(METRIC_NAMES.CAPABILITY_PROBE_TOTAL, {
      capability: 'tier1-diagnostic',
      providerId: provider,
      outcome: 'budget-exhausted',
    });
    return { status: 'budget-exhausted', capabilitiesConfirmed: [], capabilitiesAmbiguousUnresolved: [] };
  }
  probesStarted++;

  const probeStartedAt = Date.now();
  const request: ChatRequest = {
    model: modelId,
    messages: [{ role: 'user', content: buildTier1DiagnosticPrompt() }],
    max_tokens: 900,
    stream: true,
  };

  let text: string;
  let chunkCount: number;
  try {
    const collected = await collectStreamedResponse(adapter, request, PROBE_TIMEOUT_MS);
    text = collected.text;
    chunkCount = collected.chunkCount;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = isProviderLivenessError(message) ? 'provider-dead' : 'inconclusive';
    log.debug({ provider, modelId, error: message, outcome }, 'Tier-1 probe call failed');
    incrementCounter(METRIC_NAMES.CAPABILITY_PROBE_TOTAL, {
      capability: 'tier1-diagnostic',
      providerId: provider,
      outcome,
    });
    return { status: outcome, capabilitiesConfirmed: [], capabilitiesAmbiguousUnresolved: [] };
  }

  const { verdicts } = classifyTier1StructuralSignals(text);
  // Streaming is graded from transport behavior, not response text — 2+
  // chunks is real incremental delivery (a single-chunk generator is this
  // codebase's own documented pattern for adapters that buffer internally
  // and are NOT evidence of token-level streaming).
  const streamingVerdict: Tier1StructuralVerdict = chunkCount >= 2 ? 'confirmed' : 'rejected';
  const finalVerdicts: Record<Tier1Capability, Tier1StructuralVerdict> = {
    ...verdicts,
    streaming: streamingVerdict,
  };

  const confirmed: Tier1Capability[] = [];
  const ambiguousUnresolved: Tier1Capability[] = [];

  for (const [capability, verdict] of Object.entries(finalVerdicts) as Array<
    [Tier1Capability, Tier1StructuralVerdict]
  >) {
    if (verdict === 'confirmed') {
      confirmed.push(capability);
      continue;
    }
    if (verdict === 'ambiguous') {
      if (judgeConfig.enabled && judgeConfig.client) {
        try {
          const judgeVerdict = await judgeConfig.client.judgeAmbiguousCapability({
            capability,
            responseExcerpt: text.slice(0, 2000),
          });
          if (judgeVerdict === 'confirmed') {
            confirmed.push(capability);
            continue;
          }
        } catch (err) {
          log.debug(
            { provider, modelId, capability, error: err instanceof Error ? err.message : String(err) },
            'Tier-1 judge fallback failed — leaving capability unresolved'
          );
        }
      }
      ambiguousUnresolved.push(capability);
    }
    // 'rejected' → no assertion, nothing to record.
  }

  if (confirmed.length > 0) {
    try {
      const { recordProbeAssertions } = await import('@/capability/assertions/probe-emitter');
      await recordProbeAssertions({
        providerId: provider,
        modelId,
        origin: TIER1_ORIGIN,
        signals: confirmed.map((capability) => ({ capability })),
      });
    } catch {
      /* best-effort — recordProbeAssertions already logs and never throws */
    }
  }

  log.info(
    { provider, modelId, confirmed, ambiguousUnresolved, chunkCount, probesStarted },
    'Tier-1 diagnostic probe completed'
  );
  incrementCounter(METRIC_NAMES.CAPABILITY_PROBE_TOTAL, {
    capability: 'tier1-diagnostic',
    providerId: provider,
    outcome: 'confirmed',
  });
  observeHistogram(METRIC_NAMES.CAPABILITY_PROBE_LATENCY_MS, Date.now() - probeStartedAt, {
    capability: 'tier1-diagnostic',
    outcome: 'confirmed',
  });

  return {
    status: 'confirmed',
    capabilitiesConfirmed: confirmed,
    capabilitiesAmbiguousUnresolved: ambiguousUnresolved,
    streamingChunkCount: chunkCount,
  };
}
