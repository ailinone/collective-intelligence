// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'dead-model-registry' });

/**
 * #1 prove-before-admit — a per-EXACT-model dead set.
 *
 * When a provider returns 404 / model_not_found for a specific model id at
 * execution, that model is a dead catalog entry (HF aggregated-index junk, a
 * renamed/removed model, a wrong id). The operability hub is keyed per
 * (executionProvider, model-FAMILY), so it CANNOT gate a single dead model
 * without penalising its whole family — this registry closes that gap (404 was
 * the single largest error class in the operability burst: 32 errors).
 *
 * In-memory + TTL'd (self-healing): a dead model is excluded for DEAD_MODEL_TTL_MS,
 * then re-probed (a transient/misclassified 404 recovers automatically). Bounded
 * size with oldest-eviction. Fail-open by construction — a miss just leaves the
 * model eligible. No persistence: the set rebuilds cheaply from runtime 404s.
 */
const DEAD_TTL_MS = Number(process.env.DEAD_MODEL_TTL_MS) || 30 * 60 * 1000; // 30m
const MAX_SIZE = 5000;

class DeadModelRegistry {
  private dead = new Map<string, number>(); // modelId -> expiresAt (epoch ms)

  markDead(modelId: string, reason?: string): void {
    if (!modelId) return;
    if (this.dead.size >= MAX_SIZE && !this.dead.has(modelId)) {
      const oldest = this.dead.keys().next().value; // Map preserves insertion order
      if (oldest) this.dead.delete(oldest);
    }
    this.dead.set(modelId, Date.now() + DEAD_TTL_MS);
    log.debug({ modelId, reason, ttlMs: DEAD_TTL_MS }, 'Model marked dead (404/model_not_found)');
  }

  isDead(modelId: string): boolean {
    const exp = this.dead.get(modelId);
    if (exp === undefined) return false;
    if (Date.now() >= exp) {
      this.dead.delete(modelId);
      return false;
    }
    return true;
  }

  /** Number of currently-tracked (possibly-expired) entries. */
  size(): number {
    return this.dead.size;
  }
}

let instance: DeadModelRegistry | null = null;

export function getDeadModelRegistry(): DeadModelRegistry {
  if (!instance) {
    instance = new DeadModelRegistry();
  }
  return instance;
}

/** Detect a model-not-found signal from an execution failure. */
export function isModelNotFound(httpStatus?: number, errorMessage?: string): boolean {
  if (httpStatus === 404) return true;
  const msg = (errorMessage || '').toLowerCase();
  return (
    msg.includes('model_not_found') ||
    msg.includes('model not found') ||
    msg.includes('does not exist') ||
    msg.includes('no such model') ||
    msg.includes('not a valid model') ||
    msg.includes('unknown model') ||
    msg.includes('model does not exist')
  );
}
