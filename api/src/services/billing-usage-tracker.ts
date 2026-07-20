// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ChatRequest, OrchestrationResult } from '@/types';
import { recordUsageEvents } from '@/services/usage-analytics-service';
import { recordQuotaUsage } from '@/services/quota-service';
import { debitChatRequest } from '@/services/prepaid-wallet-gate';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'billing-usage-tracker' });

interface ModelUsageSummary {
  modelId: string;
  modelName: string;
  costUsd?: number;
  durationMs?: number;
  success?: boolean;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface TrackChatUsageOptions {
  organizationId: string;
  userId?: string;
  requestId: string;
  request: ChatRequest;
  result?: OrchestrationResult;
  cacheHit: boolean;
  strategyOverride?: string;
  totalTokensOverride?: number;
  totalCostOverride?: number;
  modelsOverride?: ModelUsageSummary[];
}

export async function trackChatUsage(options: TrackChatUsageOptions): Promise<void> {
  try {
    const models = options.modelsOverride ?? summarizeModels(options.result);
    const tokenUsage = aggregateTokenUsage(models);
    const totalTokens = normalizeTokens(options.totalTokensOverride ?? tokenUsage.totalTokens);
    const providerCost = sanitizeCostValue(options.totalCostOverride ?? options.result?.totalCost ?? 0);
    const billedCost = sanitizeCostValue(
      applyBillingProfile(providerCost, tokenUsage, options.request.ailin_billing)
    );
    const billingApplied = billedCost !== providerCost;

    const strategy =
      options.result?.strategyUsed ??
      options.strategyOverride ??
      (options.cacheHit ? 'cache' : 'streaming');

    await Promise.all([
      // Prepaid wallet debit on the user's REAL tokens at the tier rate. No-op
      // when the gate flag is off or the model is not a tiered cell. Single
      // chokepoint covering streaming, non-streaming, and cache-hit paths.
      debitChatRequest({
        organizationId: options.organizationId,
        request: options.request,
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        requestId: options.requestId,
      }),
      recordUsageEvents({
        organizationId: options.organizationId,
        events: [
          {
            eventType: 'chat.completion',
            userId: options.userId,
            metadata: {
              request_id: options.requestId,
              model_requested: options.request.model,
              strategy,
              cache_hit: options.cacheHit,
              total_cost_usd: billedCost,
              provider_cost_usd: providerCost,
              billed_cost_usd: billedCost,
              billing_profile_applied: billingApplied,
              billing_alias: options.request.ailin_alias,
              total_tokens: totalTokens,
              prompt_tokens: tokenUsage.promptTokens,
              completion_tokens: tokenUsage.completionTokens,
              models,
            },
          },
        ],
      }),
      recordQuotaUsage(options.organizationId, {
        organizationId: options.organizationId,
        userId: options.userId,
        operation: {
          requests: 1,
          tokens: totalTokens,
          cost: billedCost,
        },
      }),
    ]);
  } catch (error) {
    log.error(
      { error, organizationId: options.organizationId, requestId: options.requestId },
      'Failed to track chat usage'
    );
  }
}

function summarizeModels(result?: OrchestrationResult): ModelUsageSummary[] {
  if (!result) {
    return [];
  }

  return result.modelsUsed.map((execution) => ({
    modelId: execution.modelId,
    modelName: execution.modelName,
    costUsd: sanitizeCostValue(execution.cost ?? 0),
    durationMs: execution.durationMs,
    success: execution.success,
    tokens: normalizeTokens(execution.response.usage?.total_tokens ?? 0),
    promptTokens: normalizeTokens(execution.response.usage?.prompt_tokens ?? 0),
    completionTokens: normalizeTokens(execution.response.usage?.completion_tokens ?? 0),
  }));
}

interface AggregatedTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function aggregateTokenUsage(models: ModelUsageSummary[]): AggregatedTokenUsage {
  const promptTokens = models.reduce((total, entry) => total + normalizeTokens(entry.promptTokens ?? 0), 0);
  const completionTokens = models.reduce(
    (total, entry) => total + normalizeTokens(entry.completionTokens ?? 0),
    0
  );
  const fallbackTotalTokens = models.reduce((total, entry) => total + normalizeTokens(entry.tokens ?? 0), 0);
  const totalTokens = promptTokens + completionTokens > 0 ? promptTokens + completionTokens : fallbackTotalTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function applyBillingProfile(
  providerCost: number,
  tokenUsage: AggregatedTokenUsage,
  billing: ChatRequest['ailin_billing']
): number {
  if (!billing || billing.enabled === false) {
    return providerCost;
  }

  const totalTokens = tokenUsage.totalTokens;
  const promptShare = totalTokens > 0 ? tokenUsage.promptTokens / totalTokens : 0.5;
  const completionShare = totalTokens > 0 ? tokenUsage.completionTokens / totalTokens : 0.5;

  const baseInputCost = providerCost * promptShare;
  const baseOutputCost = providerCost * completionShare;

  const inputMarkup = sanitizeMultiplier(billing.inputMarkupMultiplier);
  const outputMarkup = sanitizeMultiplier(billing.outputMarkupMultiplier);

  const minInputCost = sanitizeFloorPer1k(
    billing.minInputCostPer1kUsd,
    tokenUsage.promptTokens
  );
  const minOutputCost = sanitizeFloorPer1k(
    billing.minOutputCostPer1kUsd,
    tokenUsage.completionTokens
  );

  let billed =
    Math.max(baseInputCost * inputMarkup, minInputCost) +
    Math.max(baseOutputCost * outputMarkup, minOutputCost);

  billed += sanitizeMoney(billing.flatFeeUsd);
  billed = Math.max(billed, sanitizeMoney(billing.minimumChargeUsd));

  const maximumCharge = sanitizeMoneyOrUndefined(billing.maximumChargeUsd);
  if (maximumCharge !== undefined) {
    billed = Math.min(billed, maximumCharge);
  }

  if (!Number.isFinite(billed) || billed < 0) {
    return providerCost;
  }
  return billed;
}

function sanitizeMultiplier(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return value;
}

function sanitizeMoney(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function sanitizeMoneyOrUndefined(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function sanitizeFloorPer1k(per1k: number | undefined, tokens: number): number {
  if (typeof per1k !== 'number' || !Number.isFinite(per1k) || per1k < 0 || tokens <= 0) {
    return 0;
  }
  return (per1k * tokens) / 1000;
}

function normalizeTokens(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function sanitizeCostValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Number(value.toFixed(6));
}
