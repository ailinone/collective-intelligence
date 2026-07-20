// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operability Plane — public surface.
 *
 * This barrel re-exports the Phase 1 control-plane modules. Consumers should
 * import from `@/core/operability` rather than reaching into individual
 * files, so that internal restructuring (Phase 2+) doesn't ripple.
 *
 * Phase 1 surface:
 *   - Types: ProviderHealthState, ProviderErrorClass, CandidateTrace, etc.
 *   - error-classification: classifyProviderError (pure)
 *   - candidate-trace: emitCandidateTrace, queryTraces (observability)
 *   - provider-health-registry: getProviderHealthRegistry (granular health)
 *   - skip-near-zero: shouldSkipNearZero (hot-path predicate)
 *   - probe-strategy: resolveProbeStrategy (per-adapter probe config)
 *   - discovery-service: runProviderDiscovery (operator-time discovery)
 *   - metrics: structured log emitters with Prometheus-compatible names
 *
 * NOT exported: legacy `provider-operability-hub.ts` and
 * `operability-snapshot.ts` — those continue to live alongside this module
 * and serve the route-based snapshot used by CreditGovernor. The two
 * coexist by design (different granularities, different responsibilities).
 */

// Types
export type {
  ProviderErrorClass,
  ProviderHealthState,
  ProviderErrorScope,
  ProviderErrorRetryability,
  ProviderErrorClassification,
  HealthKey,
  ProviderHealthRecord,
  SkipDecision,
  CandidateStage,
  CandidateTrace,
  DiscoveryConfidence,
  DiscoveredModel,
  ProviderDiscoveryResult,
  ProviderDiscoverySnapshot,
  CredentialProbeKind,
  CreditProbeKind,
  EndpointProbeKind,
  ModelProbeKind,
  ProviderProbeStrategy,
} from './types';

export {
  buildHealthKey,
  mapHealthStateToLegacyOperability,
  DEFAULT_COOLDOWNS,
} from './types';

// Error classification
export {
  classifyProviderError,
  extractHttpStatus,
  extractErrorMessage,
  extractRetryAfter,
  parseRetryAfterMs,
} from './error-classification';

// Candidate trace
export {
  emitCandidateTrace,
  queryTraces,
  clearTraceBufferForTesting,
  getRingSizeForTesting,
} from './candidate-trace';
export type { EmitTraceInput, TraceQuery } from './candidate-trace';

// Provider health registry
export {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
  startProviderHealthSync,
} from './provider-health-registry';
export type { ProviderHealthRegistry } from './provider-health-registry';

// Health sync bus
export {
  getHealthSyncBus,
  resetHealthSyncBusForTesting,
} from './health-sync-bus';
export type { HealthSyncBus, HealthSyncMessage, HealthSyncEventKind } from './health-sync-bus';

// Skip-near-zero
export {
  shouldSkipNearZero,
  recordDeadProviderHttpAttempt,
} from './skip-near-zero';
export type { ShouldSkipNearZeroOptions } from './skip-near-zero';

// Dead-provider audit (R5 — bypass detection over the registry)
export {
  recordHttpOutcome,
  explainHealthState,
  detectBypassForTesting,
  getFatalStatesForTesting,
  getTransientSkipStatesForTesting,
} from './dead-provider-audit';
export type { HttpOutcome } from './dead-provider-audit';

// Probe strategy
export {
  resolveProbeStrategy,
  probeSupportsCredentialCheck,
  probeSupportsCreditCheck,
  probeSupportsEndpointCheck,
  probeSupportsModelEnumeration,
} from './probe-strategy';

// Discovery service
export {
  getProviderDiscoveryService,
  resetProviderDiscoveryServiceForTesting,
  runProviderDiscovery,
} from './discovery-service';
export type {
  ProviderDiscoveryService,
  ConfiguredProvider,
  ProviderProbeCallbacks,
  DiscoveryConfig,
} from './discovery-service';

// Adapter probe callbacks
export {
  buildProbeCallbacks,
  buildProbeCallbacksMap,
  inferProbeErrorClass,
} from './adapter-probe-callbacks';
export type { BuildProbeCallbacksInput } from './adapter-probe-callbacks';

// Operational candidate pool (Phase 3)
export {
  getOperationalCandidatePool,
  resetOperationalCandidatePoolForTesting,
} from './operational-candidate-pool';
export type {
  OperationalCandidatePool,
  OperationalCandidate,
  CandidateFilter,
  ProviderTier,
} from './operational-candidate-pool';

// TEI client + embedding cache + semantic index (Phase 4)
export {
  getTEIClient,
  resetTEIClientForTesting,
} from './tei-client';
export type { TEIClient, TEIClientConfig } from './tei-client';

export {
  getEmbeddingCache,
  resetEmbeddingCacheForTesting,
} from './embedding-cache';
export type { EmbeddingCache } from './embedding-cache';

export {
  getSemanticIndex,
  createSemanticIndex,
  resetSemanticIndexForTesting,
  cosineSimilarity,
  vectorNorm,
} from './semantic-index';
export type {
  SemanticIndex,
  SemanticIndexEntry,
  SemanticIndexHit,
  SemanticIndexImplementation,
  CreateSemanticIndexInput,
} from './semantic-index';

export {
  resolveSemanticCandidates,
} from './semantic-resolver';
export type {
  RankedCandidate,
  ResolveSemanticCandidatesInput,
} from './semantic-resolver';

// Discovery scheduler (orchestrates periodic discovery + pool rebuild)
export {
  getDiscoveryScheduler,
  resetDiscoveryShedulerForTesting,
} from './discovery-scheduler';
export type {
  DiscoveryScheduler,
  DiscoveryScheduleConfig,
} from './discovery-scheduler';

// Embedding pipeline (Phase 4.2 — populates SemanticIndex)
export {
  getEmbeddingPipeline,
  resetEmbeddingPipelineForTesting,
  rebuildEmbeddingIndex,
  embedSingleCandidate,
  buildCandidateText,
} from './embedding-pipeline';
export type {
  EmbeddingPipeline,
  EmbeddingPipelineConfig,
} from './embedding-pipeline';

// Catalog resolver (PROVIDER_CATALOG → scheduler inputs)
export {
  resolveConfiguredProviders,
  resolveProbeCallbackInputs,
  resolveIntegrationClasses,
  resolveFallbackModels,
  buildCatalogResolvers,
} from './catalog-resolver';

// Metrics
export {
  METRIC_NAMES,
  incrementCounter,
  observeHistogram,
  setGauge,
  getCounterValueForTesting,
  getAllCountersForTesting,
  resetMetricCountersForTesting,
  setActiveRegistryForTesting,
} from './metrics';
export type { MetricName, CounterIncrementOptions } from './metrics';
