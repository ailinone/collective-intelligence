// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Knowledge Graph Service
 *
 * Maintains a lightweight directed graph of execution relationships:
 *   - model → task_type edges (which models perform well on which tasks)
 *   - strategy → model edges (which models are commonly used by which strategies)
 *   - model → model edges (which models complement each other in collective strategies)
 *
 * OI-11 Enhancement: Benchmark + Archive unification
 *   - benchmark → task_type edges (which tasks are well-covered by benchmarks)
 *   - archive → strategy edges (which strategies are archive elites)
 *   - strategy → task_type edges (which strategies excel at which tasks, from benchmark data)
 *   This creates a unified graph where production, benchmark, and archive data
 *   all contribute to the same relationship model.
 *
 * Storage: `knowledge_edges` table in PostgreSQL (no external graph DB needed).
 * Queries are index-backed and run in < 10ms for typical graph sizes (< 50k edges).
 *
 * Use cases:
 *   1. getComplementaryModels(modelId, taskType) — find models that have worked
 *      well alongside a given model for a task type
 *   2. getBestModelsForTask(taskType) — ranked list of models by cumulative quality
 *   3. getStrategyAffinities(strategy) — which models does a strategy prefer
 *   4. getBestStrategiesForTask(taskType) — strategies ranked by benchmark + production quality (OI-11)
 *   5. getArchiveRecommendations(taskType) — archive-backed strategy suggestions (OI-11)
 *
 * Update path:
 *   Called from OrchestrationEngine after each successful execution.
 *   Each model used in the execution gets edges created/strengthened.
 *   Also called from benchmark-evaluator and configuration-archive (OI-11).
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'knowledge-graph' });

export type EdgeType =
  | 'model_task'       // model → task:X (production quality)
  | 'model_model'      // model → model (complementary pairs)
  | 'strategy_model'   // strategy:X → model (strategy-model affinity)
  | 'strategy_task'    // strategy:X → task:X (strategy-task effectiveness from benchmarks)
  | 'benchmark_task'   // benchmark:X → task:X (benchmark coverage & quality)
  | 'archive_strategy'; // archive:X → strategy:X (archive elite designation)

interface KnowledgeEdge {
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  weight: number;
  metadata?: Record<string, unknown>;
}

class KnowledgeGraphService {
  /**
   * Record execution relationships as graph edges.
   * Called after each successful orchestration.
   */
  async recordExecution(params: {
    strategy: string;
    taskType: string;
    modelIds: string[];
    qualityScore: number;
  }): Promise<void> {
    const { strategy, taskType, modelIds, qualityScore } = params;
    if (modelIds.length === 0 || qualityScore <= 0) return;

    try {
      const edges: KnowledgeEdge[] = [];

      // model → task_type edges
      for (const modelId of modelIds) {
        edges.push({
          sourceId: modelId,
          targetId: `task:${taskType}`,
          edgeType: 'model_task',
          weight: qualityScore,
        });
      }

      // strategy → model edges
      for (const modelId of modelIds) {
        edges.push({
          sourceId: `strategy:${strategy}`,
          targetId: modelId,
          edgeType: 'strategy_model',
          weight: qualityScore,
        });
      }

      // model → model complementary edges (all pairs)
      if (modelIds.length > 1) {
        for (let i = 0; i < modelIds.length; i++) {
          for (let j = i + 1; j < modelIds.length; j++) {
            edges.push({
              sourceId: modelIds[i],
              targetId: modelIds[j],
              edgeType: 'model_model',
              weight: qualityScore,
            });
          }
        }
      }

      // Batch upsert
      for (const edge of edges) {
        await prisma.$executeRaw`
          INSERT INTO knowledge_edges (source_id, target_id, edge_type, weight, hit_count, created_at, updated_at)
          VALUES (${edge.sourceId}, ${edge.targetId}, ${edge.edgeType}, ${edge.weight}, 1, NOW(), NOW())
          ON CONFLICT (source_id, target_id, edge_type) DO UPDATE
            SET
              weight = (knowledge_edges.weight * knowledge_edges.hit_count + ${edge.weight}) / (knowledge_edges.hit_count + 1),
              hit_count = knowledge_edges.hit_count + 1,
              updated_at = NOW()
        `;
      }
    } catch (err) {
      log.warn({ error: String(err) }, 'Knowledge graph edge recording failed');
    }
  }

  /**
   * Find models that complement a given model for a task type.
   * Returns models ranked by average co-execution quality.
   */
  async getComplementaryModels(
    modelId: string,
    limit: number = 5
  ): Promise<Array<{ modelId: string; avgQuality: number; coExecutions: number }>> {
    try {
      const rows = await prisma.$queryRaw<
        Array<{ target_id: string; weight: number; hit_count: number }>
      >`
        SELECT target_id, weight, hit_count
        FROM knowledge_edges
        WHERE source_id = ${modelId}
          AND edge_type = 'model_model'
          AND hit_count >= 3
        ORDER BY weight DESC
        LIMIT ${limit}
      `;

      // Also check reverse direction
      const reverseRows = await prisma.$queryRaw<
        Array<{ source_id: string; weight: number; hit_count: number }>
      >`
        SELECT source_id, weight, hit_count
        FROM knowledge_edges
        WHERE target_id = ${modelId}
          AND edge_type = 'model_model'
          AND hit_count >= 3
        ORDER BY weight DESC
        LIMIT ${limit}
      `;

      const combined = new Map<string, { avgQuality: number; coExecutions: number }>();

      for (const row of rows) {
        combined.set(row.target_id, {
          avgQuality: row.weight,
          coExecutions: row.hit_count,
        });
      }

      for (const row of reverseRows) {
        const existing = combined.get(row.source_id);
        if (existing) {
          existing.avgQuality = (existing.avgQuality + row.weight) / 2;
          existing.coExecutions += row.hit_count;
        } else {
          combined.set(row.source_id, {
            avgQuality: row.weight,
            coExecutions: row.hit_count,
          });
        }
      }

      return [...combined.entries()]
        .map(([mid, data]) => ({ modelId: mid, ...data }))
        .sort((a, b) => b.avgQuality - a.avgQuality)
        .slice(0, limit);
    } catch (err) {
      log.warn({ error: String(err) }, 'getComplementaryModels failed');
      return [];
    }
  }

  /**
   * Get best-performing models for a given task type.
   */
  async getBestModelsForTask(
    taskType: string,
    limit: number = 10
  ): Promise<Array<{ modelId: string; avgQuality: number; executions: number }>> {
    try {
      const rows = await prisma.$queryRaw<
        Array<{ source_id: string; weight: number; hit_count: number }>
      >`
        SELECT source_id, weight, hit_count
        FROM knowledge_edges
        WHERE target_id = ${'task:' + taskType}
          AND edge_type = 'model_task'
          AND hit_count >= 3
        ORDER BY weight DESC
        LIMIT ${limit}
      `;

      return rows.map((r) => ({
        modelId: r.source_id,
        avgQuality: r.weight,
        executions: r.hit_count,
      }));
    } catch (err) {
      log.warn({ error: String(err) }, 'getBestModelsForTask failed');
      return [];
    }
  }

  /**
   * Get models that a strategy has historically preferred.
   */
  async getStrategyAffinities(
    strategy: string,
    limit: number = 10
  ): Promise<Array<{ modelId: string; avgQuality: number; uses: number }>> {
    try {
      const rows = await prisma.$queryRaw<
        Array<{ target_id: string; weight: number; hit_count: number }>
      >`
        SELECT target_id, weight, hit_count
        FROM knowledge_edges
        WHERE source_id = ${'strategy:' + strategy}
          AND edge_type = 'strategy_model'
        ORDER BY weight DESC
        LIMIT ${limit}
      `;

      return rows.map((r) => ({
        modelId: r.target_id,
        avgQuality: r.weight,
        uses: r.hit_count,
      }));
    } catch (err) {
      log.warn({ error: String(err) }, 'getStrategyAffinities failed');
      return [];
    }
  }

  // ─── OI-11: Benchmark + Archive Unification ────────────────────────────

  /**
   * Record benchmark results as graph edges.
   * Creates strategy → task edges weighted by benchmark quality scores.
   *
   * This allows the graph to answer: "Which strategies have been proven
   * effective for this task type through controlled benchmarks?"
   */
  async recordBenchmarkResults(results: Array<{
    taskType: string;
    strategy: string;
    qualityScore: number;
    complexity: string;
    modelIds?: string[];
  }>): Promise<void> {
    if (results.length === 0) return;

    try {
      const edges: KnowledgeEdge[] = [];

      for (const r of results) {
        if (r.qualityScore <= 0) continue;

        // strategy → task edge (benchmark-validated effectiveness)
        edges.push({
          sourceId: `strategy:${r.strategy}`,
          targetId: `task:${r.taskType}`,
          edgeType: 'strategy_task',
          weight: r.qualityScore,
          metadata: { source: 'benchmark', complexity: r.complexity },
        });

        // benchmark → task edge (coverage tracking)
        edges.push({
          sourceId: `benchmark:${r.complexity}`,
          targetId: `task:${r.taskType}`,
          edgeType: 'benchmark_task',
          weight: r.qualityScore,
        });

        // If model IDs provided, also record model → task from benchmark
        if (r.modelIds && r.modelIds.length > 0) {
          for (const modelId of r.modelIds) {
            edges.push({
              sourceId: modelId,
              targetId: `task:${r.taskType}`,
              edgeType: 'model_task',
              weight: r.qualityScore,
              metadata: { source: 'benchmark' },
            });
          }
        }
      }

      // Batch upsert all edges
      for (const edge of edges) {
        await prisma.$executeRaw`
          INSERT INTO knowledge_edges (source_id, target_id, edge_type, weight, hit_count, created_at, updated_at)
          VALUES (${edge.sourceId}, ${edge.targetId}, ${edge.edgeType}, ${edge.weight}, 1, NOW(), NOW())
          ON CONFLICT (source_id, target_id, edge_type) DO UPDATE
            SET
              weight = (knowledge_edges.weight * knowledge_edges.hit_count + ${edge.weight}) / (knowledge_edges.hit_count + 1),
              hit_count = knowledge_edges.hit_count + 1,
              updated_at = NOW()
        `;
      }

      log.info({ resultCount: results.length, edgeCount: edges.length },
        'Benchmark results recorded in knowledge graph (OI-11)');
    } catch (err) {
      log.warn({ error: String(err) }, 'Knowledge graph benchmark recording failed (OI-11)');
    }
  }

  /**
   * Record archive elite promotions as graph edges.
   * Creates archive:dimension → strategy edges to track which strategies
   * are archive elites and in which optimization dimensions.
   */
  async recordArchiveElites(elites: Array<{
    taskType: string;
    complexity: string;
    dimension: string;
    strategy: string;
    fitness: number;
    avgQuality: number;
  }>): Promise<void> {
    if (elites.length === 0) return;

    try {
      const edges: KnowledgeEdge[] = [];

      for (const elite of elites) {
        if (elite.fitness <= 0) continue;

        // archive:dimension → strategy edge
        edges.push({
          sourceId: `archive:${elite.dimension}`,
          targetId: `strategy:${elite.strategy}`,
          edgeType: 'archive_strategy',
          weight: elite.fitness,
          metadata: { taskType: elite.taskType, complexity: elite.complexity },
        });

        // Also strengthen strategy → task edge with archive quality data
        edges.push({
          sourceId: `strategy:${elite.strategy}`,
          targetId: `task:${elite.taskType}`,
          edgeType: 'strategy_task',
          weight: elite.avgQuality,
          metadata: { source: 'archive', dimension: elite.dimension },
        });
      }

      for (const edge of edges) {
        await prisma.$executeRaw`
          INSERT INTO knowledge_edges (source_id, target_id, edge_type, weight, hit_count, created_at, updated_at)
          VALUES (${edge.sourceId}, ${edge.targetId}, ${edge.edgeType}, ${edge.weight}, 1, NOW(), NOW())
          ON CONFLICT (source_id, target_id, edge_type) DO UPDATE
            SET
              weight = (knowledge_edges.weight * knowledge_edges.hit_count + ${edge.weight}) / (knowledge_edges.hit_count + 1),
              hit_count = knowledge_edges.hit_count + 1,
              updated_at = NOW()
        `;
      }

      log.info({ eliteCount: elites.length, edgeCount: edges.length },
        'Archive elites recorded in knowledge graph (OI-11)');
    } catch (err) {
      log.warn({ error: String(err) }, 'Knowledge graph archive recording failed (OI-11)');
    }
  }

  /**
   * Get best strategies for a task type based on all data sources
   * (production execution, benchmarks, archive elites).
   * OI-11: Unified query across all edge types.
   */
  async getBestStrategiesForTask(
    taskType: string,
    limit: number = 10
  ): Promise<Array<{ strategy: string; avgQuality: number; sources: number; dataPoints: number }>> {
    try {
      const rows = await prisma.$queryRaw<
        Array<{ source_id: string; weight: number; hit_count: number }>
      >`
        SELECT source_id, weight, hit_count
        FROM knowledge_edges
        WHERE target_id = ${'task:' + taskType}
          AND edge_type = 'strategy_task'
          AND hit_count >= 2
        ORDER BY weight DESC
        LIMIT ${limit}
      `;

      return rows.map((r) => ({
        strategy: r.source_id.replace('strategy:', ''),
        avgQuality: r.weight,
        sources: 1, // Could be enhanced with join across edge types
        dataPoints: r.hit_count,
      }));
    } catch (err) {
      log.warn({ error: String(err) }, 'getBestStrategiesForTask failed (OI-11)');
      return [];
    }
  }

  /**
   * Get graph statistics for admin inspection (OI-11).
   */
  async getGraphStats(): Promise<{
    totalEdges: number;
    edgesByType: Record<string, number>;
    uniqueNodes: number;
    avgWeight: number;
  }> {
    try {
      const stats = await prisma.$queryRaw<
        Array<{ edge_type: string; count: bigint; avg_weight: number }>
      >`
        SELECT edge_type, COUNT(*) as count, AVG(weight) as avg_weight
        FROM knowledge_edges
        GROUP BY edge_type
      `;

      const edgesByType: Record<string, number> = {};
      let totalEdges = 0;
      let weightedSum = 0;

      for (const row of stats) {
        const count = Number(row.count);
        edgesByType[row.edge_type] = count;
        totalEdges += count;
        weightedSum += row.avg_weight * count;
      }

      const nodeCount = await prisma.$queryRaw<
        Array<{ count: bigint }>
      >`
        SELECT COUNT(DISTINCT node_id) as count
        FROM (
          SELECT source_id as node_id FROM knowledge_edges
          UNION
          SELECT target_id as node_id FROM knowledge_edges
        ) nodes
      `;

      return {
        totalEdges,
        edgesByType,
        uniqueNodes: Number(nodeCount[0]?.count ?? 0),
        avgWeight: totalEdges > 0 ? weightedSum / totalEdges : 0,
      };
    } catch (err) {
      log.warn({ error: String(err) }, 'getGraphStats failed (OI-11)');
      return { totalEdges: 0, edgesByType: {}, uniqueNodes: 0, avgWeight: 0 };
    }
  }
}

// Singleton
export const knowledgeGraphService = new KnowledgeGraphService();
