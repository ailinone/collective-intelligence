// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { prisma } from '@/database/client';
import type { CostMetrics, CostEvent } from '@/types';

export interface UsageAggregationParams {
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface UsageAggregationResult {
  metrics: CostMetrics;
  events: CostEvent[];
}

export async function aggregateUsageCosts({
  organizationId,
  periodStart,
  periodEnd,
}: UsageAggregationParams): Promise<UsageAggregationResult> {
  const events = await prisma.usageEvent.findMany({
    where: {
      organizationId,
      eventType: 'chat.completion',
      timestamp: {
        gte: periodStart,
        lt: periodEnd,
      },
    },
    select: {
      userId: true,
      teamId: true,
      metadata: true,
    },
  });

  const costByModel: Record<string, number> = {};
  const costByProvider: Record<string, number> = {};
  const costByUser: Record<string, number> = {};
  const costByTeam: Record<string, number> = {};
  const usageEventsByModel = new Map<
    string,
    {
      cost: number;
      tokens: number;
      provider?: string;
    }
  >();

  let totalCost = 0;
  let totalTokens = 0;

  for (const event of events) {
    const metadata = toRecord(event.metadata);
    const eventCost = toNumber(metadata.total_cost_usd ?? metadata.cost);
    const eventTokens = normalizeTokens(metadata.total_tokens ?? metadata.tokens);

    if (event.userId) {
      costByUser[event.userId] = (costByUser[event.userId] ?? 0) + eventCost;
    }
    if (event.teamId) {
      costByTeam[event.teamId] = (costByTeam[event.teamId] ?? 0) + eventCost;
    }

    const models = Array.isArray(metadata.models) ? metadata.models : [];

    if (models.length === 0) {
      const requestedModel = metadata.model_requested as string | undefined;
      if (requestedModel) {
        accumulateModelUsage(usageEventsByModel, requestedModel, eventCost, eventTokens, undefined);
        costByModel[requestedModel] = (costByModel[requestedModel] ?? 0) + eventCost;
      }
    }

    for (const modelEntry of models) {
      if (!modelEntry || typeof modelEntry !== 'object') {
        continue;
      }

      const modelRecord = modelEntry as Record<string, unknown>;
      const modelId = String(
        modelRecord.modelId ?? modelRecord.model_id ?? modelRecord.id ?? 'unknown'
      );
      const modelName = String(modelRecord.modelName ?? modelRecord.model ?? modelId);
      const provider = deriveProvider(modelId);
      const modelCost = toNumber(
        modelRecord.costUsd ?? modelRecord.cost ?? eventCost / Math.max(models.length, 1)
      );
      const modelTokens = normalizeTokens(
        modelRecord.tokens ?? modelRecord.tokensUsed ?? eventTokens
      );

      accumulateModelUsage(usageEventsByModel, modelName, modelCost, modelTokens, provider);
      costByModel[modelName] = (costByModel[modelName] ?? 0) + modelCost;

      if (provider) {
        costByProvider[provider] = (costByProvider[provider] ?? 0) + modelCost;
      }
    }

    totalCost += eventCost;
    totalTokens += eventTokens;
  }

  const metrics: CostMetrics = {
    totalCost: roundCurrency(totalCost),
    costByModel: Object.fromEntries(
      Object.entries(costByModel).map(([key, value]) => [key, roundCurrency(value)])
    ),
    tokenUsage: totalTokens,
    timeRange: {
      start: periodStart.getTime(),
      end: periodEnd.getTime(),
    },
  };

  if (Object.keys(costByProvider).length > 0) {
    metrics.costByProvider = Object.fromEntries(
      Object.entries(costByProvider).map(([key, value]) => [key, roundCurrency(value)])
    );
  }
  if (Object.keys(costByUser).length > 0) {
    metrics.costByUser = Object.fromEntries(
      Object.entries(costByUser).map(([key, value]) => [key, roundCurrency(value)])
    );
  }
  if (Object.keys(costByTeam).length > 0) {
    metrics.costByTeam = Object.fromEntries(
      Object.entries(costByTeam).map(([key, value]) => [key, roundCurrency(value)])
    );
  }

  const costEvents: CostEvent[] = Array.from(usageEventsByModel.entries()).map(
    ([modelName, details]) => ({
      model: modelName,
      cost: roundCurrency(details.cost),
      tokensUsed: normalizeTokens(details.tokens),
      category: details.provider,
    })
  );

  return {
    metrics,
    events: costEvents,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function normalizeTokens(value: unknown): number {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(parsed));
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(6));
}

function deriveProvider(modelId: string | undefined): string | undefined {
  if (!modelId) {
    return undefined;
  }
  if (modelId.includes(':')) {
    return modelId.split(':')[0];
  }
  if (modelId.includes('/')) {
    return modelId.split('/')[0];
  }
  return undefined;
}

function accumulateModelUsage(
  accumulator: Map<string, { cost: number; tokens: number; provider?: string }>,
  modelName: string,
  cost: number,
  tokens: number,
  provider?: string
): void {
  const current = accumulator.get(modelName);
  if (current) {
    current.cost += cost;
    current.tokens += tokens;
    if (!current.provider && provider) {
      current.provider = provider;
    }
    return;
  }
  accumulator.set(modelName, {
    cost,
    tokens,
    provider,
  });
}
