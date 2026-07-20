// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Independence Test — Class 3 Validation Infrastructure
 *
 * Measures real diversity between model outputs instead of relying on
 * provider diversity as proxy (P1.1).
 *
 * When models from different providers produce semantically identical outputs,
 * the system is not genuinely collective — it's averaging. This module:
 * 1. Computes embedding similarity between intermediate outputs
 * 2. Builds agreement matrices per strategy execution
 * 3. Detects diversity collapse (avg cosine > threshold)
 * 4. Measures information uniqueness per output
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'independence-test' });

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single intermediate output from a model during strategy execution */
export interface IntermediateOutput {
  modelId: string;
  provider: string;
  content: string;
  /** Role in the strategy (e.g., 'opening', 'specialist', 'critic') */
  role: string;
  /** Round number (for multi-round strategies like debate) */
  round: number;
  /** Embedding vector (populated after embedding computation) */
  embedding?: number[];
}

/** Pairwise similarity between two model outputs */
export interface PairwiseSimilarity {
  modelA: string;
  modelB: string;
  cosineSimilarity: number;
  /** Word-level Jaccard overlap (legacy metric, kept for comparison) */
  jaccardSimilarity: number;
}

/** Diversity measurement for a single strategy execution */
export interface DiversityMeasurement {
  /** Strategy that produced these outputs */
  strategy: string;
  /** Task information */
  taskType: string;
  complexity: string;
  /** Number of models involved */
  modelCount: number;
  /** All pairwise similarities */
  pairwiseSimilarities: PairwiseSimilarity[];
  /** Average cosine similarity (lower = more diverse) */
  avgCosineSimilarity: number;
  /** Maximum cosine similarity (detects near-duplicate pairs) */
  maxCosineSimilarity: number;
  /** Minimum cosine similarity */
  minCosineSimilarity: number;
  /** Whether diversity has collapsed (avg > threshold) */
  diversityCollapsed: boolean;
  /** Information uniqueness per model: % of content not in other outputs */
  informationUniqueness: Map<string, number>;
  /** Timestamp */
  timestamp: Date;
}

/** Configuration for independence testing */
export interface IndependenceTestConfig {
  /** Cosine similarity threshold above which diversity is considered collapsed */
  collapseThreshold?: number;
  /** Minimum number of outputs to compute diversity (otherwise skip) */
  minOutputs?: number;
}

// ─── Default Config ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<IndependenceTestConfig> = {
  collapseThreshold: 0.85,
  minOutputs: 2,
};

// ─── Independence Test Service ──────────────────────────────────────────────

export class IndependenceTestService {
  private config: Required<IndependenceTestConfig>;
  /** Rolling history of diversity measurements */
  private measurements: DiversityMeasurement[] = [];
  /** Max measurements to retain in memory */
  private maxHistory = 1000;

  constructor(config: IndependenceTestConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Measure diversity between intermediate outputs from a strategy execution.
   *
   * @param outputs - Intermediate outputs from models (opening round / specialist outputs)
   * @param strategy - Strategy name
   * @param taskType - Task type
   * @param complexity - Complexity level
   * @param embedFn - Function to compute embeddings (injected to avoid hard dependency)
   */
  async measureDiversity(
    outputs: IntermediateOutput[],
    strategy: string,
    taskType: string,
    complexity: string,
    embedFn?: (texts: string[]) => Promise<number[][]>
  ): Promise<DiversityMeasurement | null> {
    if (outputs.length < this.config.minOutputs) {
      return null;
    }

    // Compute embeddings if function provided
    if (embedFn) {
      try {
        const texts = outputs.map(o => o.content);
        const embeddings = await embedFn(texts);
        for (let i = 0; i < outputs.length; i++) {
          outputs[i].embedding = embeddings[i];
        }
      } catch (err) {
        log.warn({ error: String(err) }, 'Embedding computation failed, falling back to Jaccard');
      }
    }

    // Compute pairwise similarities
    const pairwiseSimilarities: PairwiseSimilarity[] = [];
    for (let i = 0; i < outputs.length; i++) {
      for (let j = i + 1; j < outputs.length; j++) {
        const sim = this.computePairwiseSimilarity(outputs[i], outputs[j]);
        pairwiseSimilarities.push(sim);
      }
    }

    // Aggregate
    const cosines = pairwiseSimilarities.map(p => p.cosineSimilarity);
    const avgCosine = cosines.length > 0
      ? cosines.reduce((a, b) => a + b, 0) / cosines.length
      : 0;
    const maxCosine = cosines.length > 0 ? Math.max(...cosines) : 0;
    const minCosine = cosines.length > 0 ? Math.min(...cosines) : 0;

    // Compute information uniqueness
    const informationUniqueness = this.computeInformationUniqueness(outputs);

    const measurement: DiversityMeasurement = {
      strategy,
      taskType,
      complexity,
      modelCount: outputs.length,
      pairwiseSimilarities,
      avgCosineSimilarity: avgCosine,
      maxCosineSimilarity: maxCosine,
      minCosineSimilarity: minCosine,
      diversityCollapsed: avgCosine > this.config.collapseThreshold,
      informationUniqueness,
      timestamp: new Date(),
    };

    // Store measurement
    this.measurements.push(measurement);
    if (this.measurements.length > this.maxHistory) {
      this.measurements = this.measurements.slice(-this.maxHistory);
    }

    if (measurement.diversityCollapsed) {
      log.warn(
        { strategy, taskType, avgCosine, threshold: this.config.collapseThreshold },
        'Diversity collapsed — outputs are too similar'
      );
    }

    return measurement;
  }

  /**
   * Get diversity trend for a strategy over recent measurements
   */
  getDiversityTrend(
    strategy: string,
    windowSize = 50
  ): { avgDiversity: number; trend: 'improving' | 'stable' | 'degrading'; collapseRate: number } {
    const relevant = this.measurements
      .filter(m => m.strategy === strategy)
      .slice(-windowSize);

    if (relevant.length < 2) {
      return { avgDiversity: 0, trend: 'stable', collapseRate: 0 };
    }

    const avgDiversity = 1 - (relevant.reduce((s, m) => s + m.avgCosineSimilarity, 0) / relevant.length);
    const collapseRate = relevant.filter(m => m.diversityCollapsed).length / relevant.length;

    // Compute trend: compare first half vs second half
    const half = Math.floor(relevant.length / 2);
    const firstHalf = relevant.slice(0, half);
    const secondHalf = relevant.slice(half);
    const firstAvg = firstHalf.reduce((s, m) => s + m.avgCosineSimilarity, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, m) => s + m.avgCosineSimilarity, 0) / secondHalf.length;

    const delta = secondAvg - firstAvg;
    const trend = delta > 0.05 ? 'degrading' : delta < -0.05 ? 'improving' : 'stable';

    return { avgDiversity, trend, collapseRate };
  }

  /**
   * Get all measurements (for export/analysis)
   */
  getMeasurements(): DiversityMeasurement[] {
    return [...this.measurements];
  }

  private computePairwiseSimilarity(a: IntermediateOutput, b: IntermediateOutput): PairwiseSimilarity {
    let cosineSimilarity = 0;
    if (a.embedding && b.embedding) {
      cosineSimilarity = this.cosineSim(a.embedding, b.embedding);
    }

    const jaccardSimilarity = this.jaccardSim(a.content, b.content);

    return {
      modelA: a.modelId,
      modelB: b.modelId,
      cosineSimilarity,
      jaccardSimilarity,
    };
  }

  private cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private jaccardSim(textA: string, textB: string): number {
    const wordsA = new Set(textA.toLowerCase().split(/\s+/));
    const wordsB = new Set(textB.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * Compute information uniqueness per model:
   * For each model, what % of its unique n-grams are NOT in any other model's output?
   */
  private computeInformationUniqueness(outputs: IntermediateOutput[]): Map<string, number> {
    const result = new Map<string, number>();
    const ngramSize = 3; // trigrams

    // Extract n-grams for each output
    const ngramSets = outputs.map(o => this.extractNgrams(o.content, ngramSize));

    for (let i = 0; i < outputs.length; i++) {
      const myNgrams = ngramSets[i];
      const otherNgrams = new Set<string>();
      for (let j = 0; j < outputs.length; j++) {
        if (j !== i) {
          for (const ng of ngramSets[j]) {
            otherNgrams.add(ng);
          }
        }
      }

      const uniqueNgrams = [...myNgrams].filter(ng => !otherNgrams.has(ng));
      const uniqueness = myNgrams.size === 0 ? 0 : uniqueNgrams.length / myNgrams.size;
      result.set(outputs[i].modelId, uniqueness);
    }

    return result;
  }

  private extractNgrams(text: string, n: number): Set<string> {
    const words = text.toLowerCase().split(/\s+/);
    const ngrams = new Set<string>();
    for (let i = 0; i <= words.length - n; i++) {
      ngrams.add(words.slice(i, i + n).join(' '));
    }
    return ngrams;
  }
}

/** Singleton */
let instance: IndependenceTestService | null = null;
export function getIndependenceTestService(config?: IndependenceTestConfig): IndependenceTestService {
  if (!instance) {
    instance = new IndependenceTestService(config);
  }
  return instance;
}
