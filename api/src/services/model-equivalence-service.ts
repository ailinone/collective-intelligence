// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Equivalence Service
 *
 * Part of Full SOTA Provider Resolution (L2: Embedding-Based Model Identity).
 *
 * Resolves model identity across providers using character n-gram hashing.
 * "gpt-5.4-pro", "gpt-5.4-pro-2026-03-05", "openai/gpt-5.4-pro" are all
 * mapped to the same equivalence group, enabling cross-provider fallback.
 *
 * Architecture:
 * 1. computeEmbedding(): Converts model ID to a 384-dim vector via n-gram hashing
 * 2. cosineSimilarity(): Measures similarity between two embeddings
 * 3. buildIndex(): Clusters all models by cosine similarity > threshold
 * 4. getEquivalentModels(): Returns all models in the same equivalence group
 *
 * Phase 1: In-memory index with n-gram hashing (no external deps)
 * Phase 2: pgvector for hardware-accelerated similarity queries (future migration)
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { safeMetadata } from '@/types/model-metadata.schema';

const log = logger.child({ component: 'model-equivalence' });

// ─── Configuration ─────────────────────────────────────────────────────────

const EMBEDDING_DIM = 384;
const SIMILARITY_THRESHOLD = 0.85;
const NGRAM_SIZES = [2, 3, 4]; // character n-gram sizes for hashing

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EquivalenceGroup {
  groupId: string;
  canonicalName: string;
  members: Array<{
    uid: string;
    modelId: string;
    providerId: string;
    provider: string;
    sourceType: string;
    similarity: number;
  }>;
}

interface ModelEmbeddingEntry {
  uid: string;
  modelId: string;
  providerId: string;
  provider: string;
  sourceType: string;
  embedding: Float32Array;
  groupId: string;
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let instance: ModelEquivalenceService | null = null;

export function getModelEquivalenceService(): ModelEquivalenceService {
  if (!instance) {
    instance = new ModelEquivalenceService();
  }
  return instance;
}

// ─── Service ───────────────────────────────────────────────────────────────

export class ModelEquivalenceService {
  private index = new Map<string, ModelEmbeddingEntry>(); // keyed by uid
  private groups = new Map<string, EquivalenceGroup>();   // keyed by groupId
  private modelToGroup = new Map<string, string>();       // modelId → groupId (many-to-one)
  private lastBuildAt: Date | null = null;

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Compute a 384-dimensional embedding vector from a model ID string.
   * Uses character n-gram hashing (deterministic, no network, <1ms).
   */
  computeEmbedding(modelId: string): Float32Array {
    const normalized = this.normalizeForEmbedding(modelId);
    const vec = new Float32Array(EMBEDDING_DIM);

    // Hash character n-grams into the vector space
    for (const n of NGRAM_SIZES) {
      for (let i = 0; i <= normalized.length - n; i++) {
        const ngram = normalized.substring(i, i + n);
        const hash = this.fnv1aHash(ngram);
        const idx = hash % EMBEDDING_DIM;
        // Use sign from another hash bit to create positive/negative dimensions
        const sign = (hash >>> 16) & 1 ? 1 : -1;
        vec[idx] += sign * (1.0 / NGRAM_SIZES.length);
      }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;

    return vec;
  }

  /**
   * Cosine similarity between two L2-normalized embeddings.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) dot += a[i] * b[i];
    return dot; // Already L2-normalized, so dot product = cosine similarity
  }

  /**
   * Build the full equivalence index from all active models in DB.
   * Uses agglomerative clustering with cosine threshold.
   * Should be called after each discovery cycle.
   */
  async buildIndex(): Promise<{ groups: number; models: number; durationMs: number }> {
    const start = Date.now();

    // Fetch all active models with provider info
    const models = await prisma.model.findMany({
      where: { status: 'active' },
      select: {
        uid: true,
        id: true,
        providerId: true,
        metadata: true,
        provider: { select: { name: true } },
      },
    });

    // Clear existing index
    this.index.clear();
    this.groups.clear();
    this.modelToGroup.clear();

    // Compute embeddings for all models
    const entries: ModelEmbeddingEntry[] = models.map(m => {
      const meta = safeMetadata(m.metadata);
      return {
        uid: m.uid,
        modelId: m.id,
        providerId: m.providerId,
        provider: m.provider?.name ?? m.providerId,
        sourceType: meta.sourceType ?? 'unknown',
        embedding: this.computeEmbedding(m.id),
        groupId: '', // assigned during clustering
      };
    });

    // Agglomerative clustering: assign each model to the first group it matches.
    // The inner cost is O(n * G * M) cosine ops. With ~6.7k models, ~1.5k groups,
    // and ~5 members/group this is ~50M dot products on a 384-dim vector — easily
    // tens of seconds of CPU. Yielding every YIELD_EVERY_OPS keeps the event loop
    // responsive (Fastify health checks, /v1/models reads, scheduler ticks) while
    // the rebuild runs in the background.
    const YIELD_EVERY_OPS = Number(process.env.MODEL_EQUIVALENCE_YIELD_OPS || '10000');
    let opCount = 0;
    for (const entry of entries) {
      let assigned = false;

      for (const [groupId, group] of this.groups.entries()) {
        // Compare against ALL members and compute average similarity
        let simSum = 0;
        let memberCount = 0;
        for (const member of group.members) {
          const memberEntry = this.index.get(member.uid);
          if (!memberEntry) continue;
          simSum += this.cosineSimilarity(entry.embedding, memberEntry.embedding);
          memberCount++;
          if (++opCount >= YIELD_EVERY_OPS) {
            opCount = 0;
            await new Promise(resolve => setImmediate(resolve));
          }
        }
        if (memberCount === 0) continue;
        const avgSim = simSum / memberCount;

        if (avgSim >= SIMILARITY_THRESHOLD) {
          // Add to existing group
          entry.groupId = groupId;
          group.members.push({
            uid: entry.uid,
            modelId: entry.modelId,
            providerId: entry.providerId,
            provider: entry.provider,
            sourceType: entry.sourceType,
            similarity: avgSim,
          });
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        // Create new group
        const groupId = this.computeCanonicalGroupId(entry.modelId);
        entry.groupId = groupId;
        this.groups.set(groupId, {
          groupId,
          canonicalName: entry.modelId,
          members: [{
            uid: entry.uid,
            modelId: entry.modelId,
            providerId: entry.providerId,
            provider: entry.provider,
            sourceType: entry.sourceType,
            similarity: 1.0,
          }],
        });
      }

      this.index.set(entry.uid, entry);
      this.modelToGroup.set(entry.modelId, entry.groupId);
    }

    this.lastBuildAt = new Date();
    const durationMs = Date.now() - start;

    log.info({
      groups: this.groups.size,
      models: entries.length,
      durationMs,
    }, 'Model equivalence index built');

    return { groups: this.groups.size, models: entries.length, durationMs };
  }

  /**
   * Get all models equivalent to the given model ID (cross-provider).
   * Returns null if the model ID is not in the index.
   *
   * Members are sorted: native_api first, then cloud_hub, then router.
   */
  getEquivalentModels(modelId: string): EquivalenceGroup | null {
    // Direct lookup
    let groupId = this.modelToGroup.get(modelId);

    // If not found, try stripping provider prefix
    if (!groupId && modelId.includes('/')) {
      const stripped = modelId.split('/').slice(1).join('/');
      groupId = this.modelToGroup.get(stripped);
    }

    // If still not found, try fuzzy match via embedding
    if (!groupId) {
      const queryEmbedding = this.computeEmbedding(modelId);
      let bestSim = 0;
      let bestGroupId: string | null = null;

      for (const [_uid, entry] of this.index.entries()) {
        const sim = this.cosineSimilarity(queryEmbedding, entry.embedding);
        if (sim > bestSim && sim >= SIMILARITY_THRESHOLD) {
          bestSim = sim;
          bestGroupId = entry.groupId;
        }
      }

      groupId = bestGroupId ?? undefined;
    }

    if (!groupId) return null;

    const group = this.groups.get(groupId);
    if (!group) return null;

    // Sort members: native_api first, then cloud_hub, then router
    const SOURCE_ORDER: Record<string, number> = { native_api: 0, cloud_hub: 1, router: 2, aggregator: 3 };
    const sorted = {
      ...group,
      members: [...group.members].sort((a, b) => {
        const orderA = SOURCE_ORDER[a.sourceType] ?? 9;
        const orderB = SOURCE_ORDER[b.sourceType] ?? 9;
        return orderA - orderB;
      }),
    };

    return sorted;
  }

  /**
   * Assign a model to an equivalence group (called during discovery).
   * Returns the group ID.
   *
   * Note: providerId is intentionally unused. Equivalence group IDs are
   * provider-independent by design — the same model served by different
   * providers (e.g. "gpt-5.4-pro" on openai vs openrouter) must map to
   * the same group to enable cross-provider fallback.
   */
  assignEquivalenceGroup(modelId: string, _providerId: string): string {
    const groupId = this.computeCanonicalGroupId(modelId);
    this.modelToGroup.set(modelId, groupId);
    return groupId;
  }

  /**
   * Get index statistics for monitoring.
   */
  getStats(): { groups: number; models: number; lastBuildAt: Date | null } {
    return {
      groups: this.groups.size,
      models: this.index.size,
      lastBuildAt: this.lastBuildAt,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  /**
   * Normalize model ID for embedding computation.
   * Strips dates, versions, provider prefixes — makes similar models hash similarly.
   */
  private normalizeForEmbedding(modelId: string): string {
    let s = modelId.toLowerCase().trim();

    // Strip provider prefix: "openai/gpt-5.4-pro" → "gpt-5.4-pro"
    if (s.includes('/')) {
      s = s.split('/').slice(1).join('/');
    }

    // Strip date suffix: "gpt-5.4-pro-2026-03-05" → "gpt-5.4-pro"
    s = s.replace(/-\d{4}-\d{2}-\d{2}$/, '');

    // Strip version suffix: "claude-3-5-sonnet-v2" → "claude-3-5-sonnet"
    s = s.replace(/-v\d+$/, '');

    // Strip common suffixes that don't affect model identity
    s = s.replace(/-latest$/, '');
    s = s.replace(/-preview$/, '');

    // Normalize separators
    s = s.replace(/[._]/g, '-');

    return s;
  }

  /**
   * Compute a canonical group ID from a model ID.
   * This is a simplified version of the full equivalence resolution.
   */
  private computeCanonicalGroupId(modelId: string): string {
    return this.normalizeForEmbedding(modelId);
  }

  /**
   * FNV-1a hash for strings (deterministic, fast).
   */
  private fnv1aHash(str: string): number {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0; // FNV prime, unsigned 32-bit
    }
    return hash;
  }
}
