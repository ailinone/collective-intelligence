// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LegacyModelSnapshot — pure structural contract for a single legacy
 * `Model` row, as it would be read by `getChatEligibleModels()` today.
 *
 * MVP 2 invariant: this type is INTENTIONALLY decoupled from Prisma.
 * It declares only the fields the registry needs to know about, with
 * the same shape the legacy DB row carries. The registry builder
 * accepts these snapshots as plain objects — supplied by fixtures in
 * tests, by a future read-only DB snapshot loader in production.
 *
 * Forbidden in this file:
 *   - `import { Model } from '@prisma/client'`
 *   - `import { PrismaClient } from '@prisma/client'`
 *   - any runtime import that opens a connection
 *
 * The shape matches the columns the audit identified in `schema.prisma`
 * (Model table) with two exceptions:
 *   1. `capabilities` is typed `unknown` because the legacy column is
 *      JSON-typed and may carry `string[]`, `Record<string, boolean>`,
 *      or `null`. The builder normalizes.
 *   2. `embedding` is typed `readonly number[]` rather than
 *      `Unsupported("vector(384)")` since the snapshot is a plain JS
 *      array at this layer.
 */

export interface LegacyModelSnapshot {
  /** Provider-local model id — e.g. `gpt-4o`, `claude-opus-4-7`. */
  readonly id: string;
  /** Deterministic surrogate — `md5(providerId + ':' + id)[:25]`. Optional in fixtures. */
  readonly uid?: string;
  /** Canonical provider id. */
  readonly providerId: string;
  /** Active/inactive/deprecated/disabled — string for forward-compat. */
  readonly status: 'active' | 'inactive' | 'deprecated' | 'disabled' | string;

  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;

  // ─── Capabilities (canonical preferred, legacy fallback) ──────────────
  readonly capabilityUris?: readonly string[];
  /** Legacy JSON capabilities column — may be `string[]` or record. */
  readonly capabilities?: unknown;
  readonly capabilityConfidence?: Readonly<Record<string, number>>;
  readonly capabilitySources?: Readonly<Record<string, readonly string[]>>;
  readonly capabilityUpdatedAt?: string;

  // ─── Capacity ─────────────────────────────────────────────────────────
  readonly contextWindow?: number | null;
  readonly maxOutputTokens?: number | null;

  // ─── Pricing (per 1k tokens in legacy schema) ─────────────────────────
  readonly inputCostPer1k?: number | null;
  readonly outputCostPer1k?: number | null;

  // ─── Lifecycle ────────────────────────────────────────────────────────
  readonly lifecycleStatus?: string | null;
  readonly lifecycleReason?: string | null;
  readonly lifecycleEvaluatedAt?: string | null;

  // ─── Embedding ────────────────────────────────────────────────────────
  readonly embedding?: readonly number[] | null;
  readonly embeddingModel?: string | null;
  readonly embeddingUpdatedAt?: string | null;

  // ─── Performance (legacy `performance JSON` column) ───────────────────
  readonly performance?: Readonly<Record<string, unknown>> | null;

  // ─── Metadata ─────────────────────────────────────────────────────────
  readonly metadata?: Readonly<Record<string, unknown>> | null;

  // ─── Timestamps ───────────────────────────────────────────────────────
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastSyncedAt?: string | null;
}
