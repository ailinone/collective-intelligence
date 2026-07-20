// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Own-Model Registry Integration
 *
 * Exposes own-model metadata to the ci/api orchestration engine so that
 * triage, model selection, and strategy routing can consider own models
 * alongside third-party providers.
 *
 * This module:
 * 1. Periodically polls the own-model serving endpoint for available models
 * 2. Translates own-model metadata into the gateway's internal model format
 * 3. Registers models with the orchestration engine's model pool
 * 4. Tracks own-model health for circuit breaker integration
 *
 * STATUS (audited 2026-06-11): STAGED, DEAD-BY-CHAIN today — by design, NOT an
 * accidental orphan. This registry currently has no importer, so
 * own-model-adapter.ts is never instantiated and `OWN_MODEL_ENABLED` is not set
 * in any config. That is the EXPECTED state until local/self-hosted inference
 * (vLLM) is turned on: this is the model-stack↔API bridge that Phase P4 of the
 * roadmap depends on. Retained deliberately (product decision, 2026-06-11) —
 * do NOT delete. To activate: wire `startOwnModelRegistry()` into the boot path
 * (index.ts) behind `OWN_MODEL_ENABLED`, provision the serving endpoint, and the
 * C3 experiment arms that reference own/* model ids will resolve.
 */

import { logger } from '@/utils/logger';
import { serializeError } from '@/utils/type-guards';
import { getOwnModelAdapter, type OwnModelInfo } from './own-model-adapter';

const log = logger.child({ component: 'own-model-registry' });

// ---------------------------------------------------------------------------
// Types matching gateway internal model format
// ---------------------------------------------------------------------------

export interface OwnModelRegistryEntry {
  id: string;
  provider: 'own-model';
  displayName: string;
  capabilities: {
    chat: boolean;
    completion: boolean;
    embedding: boolean;
    toolUse: boolean;
    streaming: boolean;
    vision: boolean;
  };
  contextWindow: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  maxOutputTokens: number;
  version: string;
  status: 'active' | 'loading' | 'unavailable';
  metadata: {
    architecture: string;
    paramCount: string;
    quantization: string;
    servingEndpoint: string;
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registeredModels = new Map<string, OwnModelRegistryEntry>();
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function getOwnModels(): OwnModelRegistryEntry[] {
  return Array.from(registeredModels.values()).filter((m) => m.status === 'active');
}

export function getOwnModel(id: string): OwnModelRegistryEntry | undefined {
  return registeredModels.get(id);
}

function toRegistryEntry(model: OwnModelInfo): OwnModelRegistryEntry {
  return {
    id: model.id,
    provider: 'own-model',
    displayName: model.id.replace('own/', 'ailin-'),
    capabilities: {
      chat: model.capabilities.chat,
      completion: model.capabilities.completion,
      embedding: model.capabilities.embedding,
      toolUse: model.capabilities.tool_use,
      streaming: true,
      vision: false,
    },
    contextWindow: model.context_window,
    // Own model: marginal cost only (compute amortized)
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0003,
    maxOutputTokens: model.context_window,
    version: model.version,
    status: model.status === 'ready' ? 'active' : model.status === 'loading' ? 'loading' : 'unavailable',
    metadata: {
      architecture: 'ailin-transformer',
      paramCount: '1.28B',
      quantization: 'awq-int4',
      servingEndpoint: process.env.OWN_MODEL_ENDPOINT || 'http://localhost:8081',
    },
  };
}

export async function refreshOwnModels(): Promise<void> {
  const adapter = getOwnModelAdapter();
  if (!adapter.isEnabled) return;

  try {
    const models = await adapter.listModels();

    // Clear models that are no longer served
    const servedIds = new Set(models.map((m) => m.id));
    for (const id of registeredModels.keys()) {
      if (!servedIds.has(id)) {
        registeredModels.delete(id);
        log.info({ modelId: id }, 'Own model removed from registry (no longer served)');
      }
    }

    // Add/update models
    for (const model of models) {
      const entry = toRegistryEntry(model);
      const existing = registeredModels.get(model.id);
      if (!existing || existing.status !== entry.status || existing.version !== entry.version) {
        registeredModels.set(model.id, entry);
        log.info(
          { modelId: model.id, status: entry.status, version: entry.version },
          'Own model registered/updated'
        );
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to refresh own models');
    // Mark all as unavailable on error
    for (const entry of registeredModels.values()) {
      entry.status = 'unavailable';
    }
  }
}

export function startOwnModelPolling(intervalMs = 60_000): void {
  const adapter = getOwnModelAdapter();
  if (!adapter.isEnabled) {
    log.info('Own-model provider disabled — skipping registry polling');
    return;
  }

  log.info({ intervalMs }, 'Starting own-model registry polling');

  // Initial fetch
  refreshOwnModels().catch((err) =>
    log.warn({ err: serializeError(err) }, 'Initial own-model registry fetch failed')
  );

  pollInterval = setInterval(() => {
    refreshOwnModels().catch((err) =>
      log.warn({ err: serializeError(err) }, 'Own-model registry poll failed')
    );
  }, intervalMs);
}

export function stopOwnModelPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log.info('Stopped own-model registry polling');
  }
}
