// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { prisma } from '@/database/client';
import type { UsageEvent, UsageMetrics, UsageMetricsRequest } from '@/types';
import { toInputJson } from '@/utils/json';

interface RecordUsageOptions {
  organizationId: string;
  events: UsageEvent[];
}

interface MetricsOptions extends UsageMetricsRequest {
  organizationId: string;
}

export async function recordUsageEvents(options: RecordUsageOptions): Promise<void> {
  if (!options.events || options.events.length === 0) {
    return;
  }

  const rows = options.events.map((event) => ({
    organizationId: event.organizationId ?? options.organizationId,
    teamId: event.teamId ?? null,
    userId: event.userId ?? null,
    eventType: event.eventType,
    metadata: toInputJson(event.metadata),
    timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
  }));

  await prisma.usageEvent.createMany({
    data: rows,
  });
}

export async function getUsageMetrics(options: MetricsOptions): Promise<UsageMetrics> {
  const start = options.start
    ? new Date(options.start)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const end = options.end ? new Date(options.end) : new Date();

  const baseWhere = {
    organizationId: options.organizationId,
    timestamp: {
      gte: start,
      lte: end,
    },
  } as const;

  // Four independent aggregate queries over the same base filter — none
  // depends on another's result, so run them concurrently.
  const [totalEvents, eventsByType, eventsByUser, eventsByTeam] = await Promise.all([
    prisma.usageEvent.count({
      where: baseWhere,
    }),
    prisma.usageEvent.groupBy({
      by: ['eventType' as const],
      where: baseWhere,
      _count: { _all: true },
    }),
    prisma.usageEvent.groupBy({
      by: ['userId' as const],
      where: {
        ...baseWhere,
        userId: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.usageEvent.groupBy({
      by: ['teamId' as const],
      where: {
        ...baseWhere,
        teamId: { not: null },
      },
      _count: { _all: true },
    }),
  ]);

  return {
    totalEvents,
    eventsByType: aggregateGroup(eventsByType, 'eventType'),
    eventsByUser: aggregateGroup(eventsByUser, 'userId'),
    eventsByTeam: aggregateGroup(eventsByTeam, 'teamId'),
    timeRange: {
      start: start.getTime(),
      end: end.getTime(),
    },
  };
}

function aggregateGroup<T extends { _count: { _all: number } }>(
  rows: (T & Record<string, unknown>)[],
  key: keyof T
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const row of rows) {
    const value = row[key] as string | null | undefined;
    if (!value) continue;
    result[String(value)] = row._count._all;
  }

  return result;
}
