// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Zod schemas for Model metadata validation.
 *
 * Part of the Full SOTA Provider Resolution architecture (L8: Type Safety).
 *
 * All reads/writes to model.metadata MUST go through these schemas to ensure
 * runtime type safety. This prevents:
 * - Silent typos in metadata field names (e.g., 'sorceType' vs 'sourceType')
 * - Invalid values (e.g., sourceType: 'natve_api')
 * - Missing fields that downstream code assumes exist
 *
 * Usage:
 *   import { parseModelMetadata, safeMetadata } from '@/types/model-metadata.schema';
 *   const meta = safeMetadata(model.metadata);  // validated, typed
 *   meta.sourceType // SourceType | undefined (not `unknown`)
 */

import { z } from 'zod';

// ─── Source Type Classification ──────────────────────────────────────────

export const SourceType = z.enum(['native_api', 'cloud_hub', 'router', 'aggregator']);
export type SourceType = z.infer<typeof SourceType>;

export const BalanceStatusEnum = z.enum(['has-credits', 'no-credits', 'unknown', 'local']);
export type BalanceStatus = z.infer<typeof BalanceStatusEnum>;

// ─── Model Metadata Schema ───────────────────────────────────────────────

/**
 * Complete schema for model.metadata JSON field.
 * All fields are optional because metadata is progressively enriched
 * during discovery, execution, and feedback loops.
 */
export const ModelMetadataSchema = z.object({
  // ── Discovery metadata ──
  /** How the model was discovered: native API, cloud hub, router, or aggregator. */
  sourceType: SourceType.optional(),
  /** Discovery source priority (1 = native/highest, 2 = hub, 3+ = router). */
  sourcePriority: z.number().int().min(1).max(10).optional(),
  /** Discovery source name (e.g., 'openai-native', 'openrouter'). */
  source: z.string().optional(),
  /** ISO timestamp when model was first discovered. */
  discoveredAt: z.string().optional(),

  // ── Provider chain metadata ──
  /** The provider that originally created/published this model (e.g., 'openai' for GPT models). */
  originalProvider: z.string().optional(),
  /** The provider that actually executes the model (may differ from originalProvider for hubs). */
  executionProvider: z.string().optional(),
  /** True if this provider was discovered via a router, not directly. */
  virtualProvider: z.boolean().optional(),
  /** Which router/aggregator discovered this provider (e.g., 'openrouter'). */
  routedVia: z.string().optional(),

  // ── Model equivalence (L2) ──
  /** Cluster ID for cross-provider model matching (e.g., 'openai:gpt-5.4-pro'). */
  equivalenceGroup: z.string().optional(),

  // ── Provider health (L1, L3, L4) ──
  /** Rolling success rate for this model+provider pair (0-1). Updated by feedback loop. */
  providerReliability: z.number().min(0).max(1).optional(),
  /** Credit status from last probe. */
  creditStatus: BalanceStatusEnum.optional(),
  /** ISO timestamp of last credit check. */
  lastCreditCheckAt: z.string().optional(),

  // ── Model capability metadata ──
  /** Whether this model uses max_completion_tokens instead of max_tokens. */
  uses_max_completion_tokens: z.boolean().optional(),
  /** Supported API parameters (from provider metadata). */
  supported_parameters: z.array(z.string()).optional(),

  // ── Pricing (from discovery) ──
  pricing: z.record(z.unknown()).optional(),
}).passthrough(); // Allow additional unknown fields for backward compatibility

export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

// ─── Model Performance Schema ────────────────────────────────────────────

export const ModelPerformanceSchema = z.object({
  latencyMs: z.number().min(0).default(1000),
  throughput: z.number().min(0).default(100),
  /** Quality score (0-1). Updated by feedback loop from judge scores. */
  quality: z.number().min(0).max(1).default(0.8),
  /** Reliability score (0-1). Updated by feedback loop from execution success rate. */
  reliability: z.number().min(0).max(1).default(0.95),
  lastValidated: z.date().optional(),
});

export type ModelPerformanceTyped = z.infer<typeof ModelPerformanceSchema>;

// ─── Branded Types ────────────────────────────────────────────────────────
// Prevent accidental interchange of semantically different string IDs.

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Model ID (e.g., 'gpt-5.4-pro'). NOT the uid (which is MD5 hash). */
export type ModelId = Brand<string, 'ModelId'>;

/** Provider ID from the providers table (e.g., 'openai', 'aihubmix'). */
export type ProviderId = Brand<string, 'ProviderId'>;

/** Model uid — deterministic surrogate PK = MD5(providerId + ':' + modelId)[0:25]. */
export type ModelUid = Brand<string, 'ModelUid'>;

/** Equivalence group ID for cross-provider matching (e.g., 'openai:gpt-5.4-pro'). */
export type EquivalenceGroupId = Brand<string, 'EquivalenceGroupId'>;

// ─── Safe Accessors ──────────────────────────────────────────────────────

/**
 * Parse and validate model metadata from the raw JSON field.
 * Returns a fully typed ModelMetadata object.
 *
 * Throws ZodError if the data is structurally invalid (not just missing fields).
 * Unknown additional fields are preserved (passthrough mode).
 */
export function parseModelMetadata(raw: unknown): ModelMetadata {
  return ModelMetadataSchema.parse(raw ?? {});
}

/**
 * Safe metadata accessor — returns typed metadata without throwing.
 * Falls back to empty object on invalid data.
 *
 * Use this in hot paths where you can't afford a thrown error.
 */
export function safeMetadata(raw: unknown): ModelMetadata {
  const result = ModelMetadataSchema.safeParse(raw ?? {});
  return result.success ? result.data : ({} as ModelMetadata);
}

/**
 * Type-safe read of a single metadata field.
 * Returns undefined if the field doesn't exist or metadata is invalid.
 */
export function readMetadataField<K extends keyof ModelMetadata>(
  metadata: unknown,
  field: K,
): ModelMetadata[K] | undefined {
  const parsed = safeMetadata(metadata);
  return parsed[field];
}

// ─── Brand Constructors ──────────────────────────────────────────────────
// These are intentionally verbose — they document WHERE a brand is created.

export function asModelId(id: string): ModelId { return id as ModelId; }
export function asProviderId(id: string): ProviderId { return id as ProviderId; }
export function asModelUid(uid: string): ModelUid { return uid as ModelUid; }
export function asEquivalenceGroupId(id: string): EquivalenceGroupId { return id as EquivalenceGroupId; }
