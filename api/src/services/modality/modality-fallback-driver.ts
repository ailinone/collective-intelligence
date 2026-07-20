// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared modality execution driver (DUP #2 phase 2, 2026-06-11).
 *
 * Owns the `executeWithFallback` call + the unified cost accounting
 * (`computeModalityCost` → llmCostUSD) + the completion log + the error
 * classification (NoFallbackCandidateError → ValidationError; FallbackExhausted
 * → re-thrown 503). Extracted from the byte-identical try/catch in
 * images-orchestration (`runImageOperation`) and moderations-orchestration —
 * verified identical by an adversarial comparison.
 *
 * Callers supply the modality-specific candidate set, capability, and `execute`
 * hook, then map the returned `response` to their OWN result envelope (which
 * differs per modality: images/audio/video/results/...). The driver does NOT
 * build the envelope, so it composes cleanly without inheritance.
 */

import type { Logger } from 'pino';
import type { Model, ModelCapability } from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ProviderRegistry } from '@/providers/provider-registry';
import {
  executeWithFallback,
  FallbackExhaustedError,
  NoFallbackCandidateError,
  type CandidateAttempt,
} from '@/core/orchestration/execute-with-fallback';
import { ValidationError } from '@/utils/custom-errors';
import { computeModalityCost } from '@/services/modality-cost';
import type { CostRecord } from '@/services/cost-normalization-service';

export interface ModalityFallbackArgs<TRaw> {
  capability: ModelCapability | ModelCapability[];
  capabilityLabel: string;
  explicit?: string | null;
  catalog: Model[];
  /** Absolute safety backstop only — see executeWithFallback's doc. Omit to
   *  offer the full catalog; the real search-depth governor is `deadlineMs`. */
  maxCandidates?: number;
  /** Wall-clock search budget (ms) — see executeWithFallback's `deadlineMs`
   *  doc. Callers should pass `resolveFallbackDeadlineMs(strategy, allowFallback)`
   *  instead of a candidate count. */
  deadlineMs?: number;
  registry: ProviderRegistry;
  supportsCapability?: (adapter: ProviderAdapter) => boolean;
  execute: (model: Model, adapter: ProviderAdapter) => Promise<TRaw>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  requestId: string;
  startTime: number;
  /** Race the top-N candidates (cold-start latency amortization). Passed
   *  through to executeWithFallback; omit for the default sequential behavior. */
  parallelDegree?: number;
  /** Override the default FallbackExhausted handling (which logs + re-throws the
   *  503). Audio uses this to re-package as a deliberate 422 so the gateway does
   *  not retry slow inference. MUST throw (returns `never`); when provided, the
   *  driver does NOT also log/re-throw its default 503. */
  onFallbackExhausted?: (error: FallbackExhaustedError, durationMs: number) => never;
}

export interface ModalityFallbackResult<TRaw> {
  response: TRaw;
  selectedModel: Model;
  selectedAdapter: ProviderAdapter;
  attempts: CandidateAttempt[];
  durationMs: number;
  /** True when the chosen model was not the first (highest-ranked) candidate. */
  fallbackUsed: boolean;
  cost: CostRecord;
}

export async function runModalityFallback<TRaw>(
  args: ModalityFallbackArgs<TRaw>,
): Promise<ModalityFallbackResult<TRaw>> {
  const firstCatalogId = args.catalog[0]?.id;
  try {
    const result = await executeWithFallback<TRaw>({
      capability: args.capability,
      capabilityLabel: args.capabilityLabel,
      explicit: args.explicit ?? null,
      maxCandidates: args.maxCandidates,
      deadlineMs: args.deadlineMs,
      registry: args.registry,
      catalog: args.catalog,
      supportsCapability: args.supportsCapability,
      parallelDegree: args.parallelDegree,
      log: args.log,
      execute: args.execute,
    });

    const durationMs = Date.now() - args.startTime;
    // COST #6: feed modality cost into the unified accounting (llmCostUSD).
    const cost = computeModalityCost({
      response: result.response,
      model: result.selectedModel,
      provider: result.selectedAdapter.getName().toLowerCase(),
    });
    const fallbackUsed = result.selectedModel.id !== firstCatalogId;
    args.log.info(
      {
        requestId: args.requestId,
        selectedModel: result.selectedModel.name,
        durationMs,
        fallbackUsed,
        attempts: result.attempts.length,
        costUsd: cost.normalizedCostUsd,
        costSource: cost.costSource,
      },
      `${args.capabilityLabel} completed`,
    );

    return {
      response: result.response,
      selectedModel: result.selectedModel,
      selectedAdapter: result.selectedAdapter,
      attempts: result.attempts,
      durationMs,
      fallbackUsed,
      cost,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - args.startTime;
    if (error instanceof NoFallbackCandidateError) {
      args.log.warn(
        { requestId: args.requestId, model: args.explicit, message: error.message, durationMs },
        `${args.capabilityLabel} candidate not found`,
      );
      // Preserve the route's ValidationError shape for explicit-name miss.
      throw new ValidationError(error.message, error.details);
    }
    if (error instanceof FallbackExhaustedError) {
      // Caller-supplied contract override (e.g. audio's deliberate 422). It must
      // throw, so nothing below runs when provided.
      if (args.onFallbackExhausted) {
        args.onFallbackExhausted(error, durationMs);
      }
      args.log.error(
        { requestId: args.requestId, attempts: error.attempts, durationMs },
        `All ${args.capabilityLabel} providers failed`,
      );
      // Re-throw as-is — ApplicationError carries statusCode 503 + attempts.
      throw error;
    }
    args.log.error(
      { requestId: args.requestId, error, durationMs },
      `${args.capabilityLabel} orchestration failed`,
    );
    throw error;
  }
}
