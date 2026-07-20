// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { config } from '@/config';
import { logger } from '@/utils/logger';
import type { AppConfig } from '@/types';

export interface QueueRuntimeConfiguration {
  queueName: string;
  workerCount: number;
  workerConcurrency: number;
  maxAttempts: number;
  backoffStrategy: AppConfig['queue']['backoffStrategy'];
  backoffInitialDelayMs: number;
  resultTtlSeconds: number;
  statusTtlSeconds: number;
  maxQueueTimeSeconds: number;
  pollIntervalMs: number;
  runWorkersInApiProcess: boolean;
  workerMetricsPort: number;
  forceQueue: boolean;
  priority: AppConfig['queue']['priority'];
  scale: AppConfig['queue']['scale'];
}

export interface QueueRuntimeSnapshot {
  enabled: boolean;
  reason: string | null;
  details?: unknown;
  initializedAt: number;
  configuration: QueueRuntimeConfiguration;
}

interface QueueRuntimeState extends QueueRuntimeSnapshot {}

let runtimeState: QueueRuntimeState | null = null;

function freezeConfiguration(queueConfig: AppConfig['queue']): QueueRuntimeConfiguration {
  const configuration: QueueRuntimeConfiguration = {
    queueName: queueConfig.queueName,
    workerCount: queueConfig.workerCount,
    workerConcurrency: queueConfig.workerConcurrency,
    maxAttempts: queueConfig.maxAttempts,
    backoffStrategy: queueConfig.backoffStrategy,
    backoffInitialDelayMs: queueConfig.backoffInitialDelayMs,
    resultTtlSeconds: queueConfig.resultTtlSeconds,
    statusTtlSeconds: queueConfig.statusTtlSeconds,
    maxQueueTimeSeconds: queueConfig.maxQueueTimeSeconds,
    pollIntervalMs: queueConfig.pollIntervalMs,
    runWorkersInApiProcess: queueConfig.runWorkersInApiProcess,
    workerMetricsPort: queueConfig.workerMetricsPort,
    forceQueue: queueConfig.forceQueue,
    priority: { ...queueConfig.priority },
    scale: { ...queueConfig.scale },
  };

  return Object.freeze({
    ...configuration,
    priority: Object.freeze({ ...configuration.priority }),
    scale: Object.freeze({ ...configuration.scale }),
  });
}

function ensureInitialized(): void {
  if (runtimeState) {
    return;
  }

  const initialConfig = freezeConfiguration(config.queue);
  runtimeState = {
    enabled: config.queue.enabled,
    reason: config.queue.enabled ? null : 'disabled_by_configuration',
    details: config.queue.enabled ? undefined : { source: 'config' },
    initializedAt: Date.now(),
    configuration: initialConfig,
  };
}

export function initializeQueueRuntime(queueConfig: AppConfig['queue']): void {
  const configuration = freezeConfiguration(queueConfig);
  runtimeState = {
    enabled: queueConfig.enabled,
    reason: queueConfig.enabled ? null : 'disabled_by_configuration',
    details: queueConfig.enabled ? undefined : { source: 'config' },
    initializedAt: Date.now(),
    configuration,
  };
  logger.debug({ enabled: runtimeState.enabled }, 'Queue runtime state initialized');
}

export function isQueueEnabled(): boolean {
  ensureInitialized();
  return runtimeState!.enabled;
}

export function getQueueRuntimeState(): QueueRuntimeSnapshot {
  ensureInitialized();
  const snapshot = runtimeState!;
  return {
    enabled: snapshot.enabled,
    reason: snapshot.reason,
    details: snapshot.details,
    initializedAt: snapshot.initializedAt,
    configuration: {
      ...snapshot.configuration,
      priority: { ...snapshot.configuration.priority },
      scale: { ...snapshot.configuration.scale },
    },
  };
}

export function disableQueueRuntime(reason: string, details?: unknown): void {
  ensureInitialized();
  if (!runtimeState!.enabled) {
    logger.debug({ reason }, 'Queue runtime already disabled');
    return;
  }

  runtimeState = {
    ...runtimeState!,
    enabled: false,
    reason,
    details,
  };

  logger.warn({ reason, details }, 'Queue runtime disabled');
}

export function enableQueueRuntime(): void {
  ensureInitialized();
  if (runtimeState!.enabled) {
    return;
  }

  runtimeState = {
    ...runtimeState!,
    enabled: true,
    reason: null,
    details: undefined,
  };

  logger.info('Queue runtime re-enabled');
}
