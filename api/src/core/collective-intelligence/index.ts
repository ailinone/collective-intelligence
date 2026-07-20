// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Collective Intelligence Module
 *
 * Central exports for all CI components:
 * - Semantic Memory Store
 * - Semantic Cache
 * - Reasoning Transparency
 * - Self-Critique Engine
 * - Agentic Workflow Engine
 * - Memory Context Service
 * - CI Metrics
 */

// Semantic Memory
export {
  SemanticMemoryStore,
  getSemanticMemoryStore,
  type MemoryEntry,
  type MemorySearchResult,
  type MemoryStoreOptions,
  type MemoryType,
} from '@/core/memory/semantic-memory-store';

// Memory Context Service
export {
  MemoryContextService,
  getMemoryContextService,
  initializeMemoryContextService,
  type MemoryContext,
  type MemoryContextOptions,
} from '@/core/memory/memory-context-service';

// Semantic Cache
export {
  SemanticCache,
  getSemanticCache,
  type SemanticCacheOptions,
} from '@/core/cache/semantic-cache';

// Reasoning Transparency
export {
  ReasoningTransparencyService,
  getReasoningTransparency,
  type ReasoningTrace,
  type ModelSelectionReasoning,
  type StrategySelectionReasoning,
} from '@/core/transparency/reasoning-transparency';

// Self-Critique Engine
export {
  SelfCritiqueEngine,
  getSelfCritiqueEngine,
  type SelfCritiqueOptions,
  type CritiqueResult,
} from '@/core/critique/self-critique-engine';

// Agentic Workflow Engine
export {
  AgenticWorkflowEngine,
  getAgenticWorkflowEngine,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowResult,
  type StepResult,
  type StepType,
} from '@/core/agentic/agentic-workflow-engine';

// CI Metrics
export {
  recordStrategyExecution,
  recordModelSelection,
  recordMemoryOperation,
  recordCacheOperation,
  recordWorkflowExecution,
  recordTriage,
  strategyExecutionTotal,
  strategyExecutionDuration,
  strategyQualityScore,
  strategyCostUsd,
  cacheHitsTotal,
  cacheMissesTotal,
  memoryStoreTotal,
  memorySearchTotal,
  workflowExecutionTotal,
  ciMetricsRegistry,
} from '@/observability/ci-metrics';

// Re-import for the initialize function
import { SemanticMemoryStore, getSemanticMemoryStore } from '@/core/memory/semantic-memory-store';
import { MemoryContextService, getMemoryContextService } from '@/core/memory/memory-context-service';
import { SemanticCache, getSemanticCache } from '@/core/cache/semantic-cache';
import { ReasoningTransparencyService, getReasoningTransparency } from '@/core/transparency/reasoning-transparency';
import { SelfCritiqueEngine, getSelfCritiqueEngine } from '@/core/critique/self-critique-engine';
import { AgenticWorkflowEngine, getAgenticWorkflowEngine } from '@/core/agentic/agentic-workflow-engine';

/**
 * Collective Intelligence services bundle
 */
export interface CollectiveIntelligenceServices {
  memoryStore: SemanticMemoryStore;
  memoryContext: MemoryContextService;
  semanticCache: SemanticCache;
  reasoningTransparency: ReasoningTransparencyService;
  selfCritique: SelfCritiqueEngine;
  agenticWorkflow: AgenticWorkflowEngine;
}

/**
 * Initialize all Collective Intelligence components
 * This is a convenience function that initializes all singletons
 */
export function initializeCollectiveIntelligence(): CollectiveIntelligenceServices {
  return {
    memoryStore: getSemanticMemoryStore(),
    memoryContext: getMemoryContextService(),
    semanticCache: getSemanticCache(),
    reasoningTransparency: getReasoningTransparency(),
    selfCritique: getSelfCritiqueEngine(),
    agenticWorkflow: getAgenticWorkflowEngine(),
  };
}
