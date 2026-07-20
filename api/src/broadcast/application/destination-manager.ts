// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DestinationManager — application service for destination CRUD.
 *
 * Responsibilities:
 *   - Validate config against the destination type's schema (webhook, langfuse,
 *     datadog, otlp_collector) BEFORE encrypting. A bad config stored in the DB
 *     would just fail at delivery time and fill the DLQ.
 *   - Envelope-encrypt the config via DestinationConfigCipher.
 *   - Enforce tenant scoping on every read/write. A user can only act on their
 *     own `tenant_type='user'` rows; an org principal can only act on their
 *     `tenant_type='organization'` rows. Cross-tenant access is impossible by
 *     construction (every query carries both tenantType and tenantId).
 *   - Soft-delete (set deleted_at). Hard-delete is reserved for the Right-to-
 *     Erasure admin path.
 *   - Rotate DEK on config update (not just re-encrypt with the same DEK) —
 *     each encrypt() call generates a fresh DEK, which is the right behavior
 *     per ADR-017.
 *
 * This service returns DTOs that never include decrypted config. Callers
 * (HTTP routes) are responsible for auth/authz and HTTP response shaping.
 */

import { randomUUID } from 'node:crypto';

import type { Prisma, PrismaClient } from '@/generated/prisma/index.js';
import { prisma as defaultPrisma } from '@/database/client';
import { toInputJson } from '@/utils/json';
import { logger } from '@/utils/logger';

import {
  DestinationConfigCipher,
  type EncryptedBlob,
  type TenantRef,
} from '@/broadcast/infrastructure/encryption';
import type {
  DestinationType,
} from '@/broadcast/infrastructure/destinations/destination-adapter';
import { validateDestinationConfig } from './destination-config-schemas';

const log = logger.child({ component: 'destination-manager' });

// ─── Types ──────────────────────────────────────────────────────────────

export type TenantType = 'organization' | 'user';

export interface TenantScope {
  tenantType: TenantType;
  tenantId: string;
}

export interface CreateDestinationInput extends TenantScope {
  destinationType: DestinationType;
  name: string;
  enabled?: boolean;
  samplingRate?: number;
  privacyMode?: boolean;
  privacyCustomFields?: string[];
  apiKeyFilter?: string[];
  releaseStatus?: 'alpha' | 'beta' | 'stable' | 'deprecated';
  config: Record<string, unknown>;
}

export interface UpdateDestinationInput {
  name?: string;
  enabled?: boolean;
  samplingRate?: number;
  privacyMode?: boolean;
  privacyCustomFields?: string[];
  apiKeyFilter?: string[];
  releaseStatus?: 'alpha' | 'beta' | 'stable' | 'deprecated';
  /** If present, replaces the encrypted config with a freshly-DEK'd version. */
  config?: Record<string, unknown>;
}

/**
 * DTO returned to API callers. Config is NEVER included. Only metadata that
 * is safe to log and display. Decrypt path is reserved for the delivery
 * executor inside the process.
 */
export interface DestinationDto {
  id: string;
  tenantType: TenantType;
  tenantId: string;
  destinationType: DestinationType;
  name: string;
  enabled: boolean;
  samplingRate: number;
  privacyMode: boolean;
  privacyCustomFields: string[];
  apiKeyFilter: string[];
  releaseStatus: 'alpha' | 'beta' | 'stable' | 'deprecated';
  kekResource: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DestinationManagerError =
  | { code: 'not_found' }
  | { code: 'invalid_config'; message: string }
  | { code: 'invalid_input'; message: string };

export type ManagerRunner = Pick<
  PrismaClient,
  'broadcastDestination' | '$queryRaw' | '$executeRaw' | '$transaction'
>;

export interface DestinationManagerDeps {
  cipher: DestinationConfigCipher;
  db?: ManagerRunner;
  now?: () => Date;
}

// ─── Manager ────────────────────────────────────────────────────────────

export class DestinationManager {
  private readonly cipher: DestinationConfigCipher;
  private readonly db: ManagerRunner;
  private readonly now: () => Date;

  constructor(deps: DestinationManagerDeps) {
    this.cipher = deps.cipher;
    // PrismaClient is structurally compatible with the ManagerRunner subset
    // we use (db.broadcastDestination.{findMany,create,update,...}). Single
    // cast — same shape, narrower view.
    this.db = deps.db ?? (defaultPrisma as ManagerRunner);
    this.now = deps.now ?? (() => new Date());
  }

  async create(
    input: CreateDestinationInput,
  ): Promise<{ ok: true; destination: DestinationDto } | { ok: false; error: DestinationManagerError }> {
    const validation = validateDestinationConfig(input.destinationType, input.config);
    if (!validation.ok) {
      return { ok: false, error: { code: 'invalid_config', message: validation.error } };
    }
    const samplingRate = input.samplingRate ?? 1.0;
    if (!Number.isFinite(samplingRate) || samplingRate < 0 || samplingRate > 1) {
      return {
        ok: false,
        error: { code: 'invalid_input', message: 'samplingRate must be in [0, 1]' },
      };
    }
    if (input.name.length === 0 || input.name.length > 128) {
      return {
        ok: false,
        error: { code: 'invalid_input', message: 'name must be 1..128 chars' },
      };
    }

    // We need a destinationId for AAD BEFORE encryption. Generate and pass it
    // to the insert — avoids a "decrypt with wrong AAD" bug on day one.
    const destinationId = randomUUID();
    const tenantRef: TenantRef = {
      tenantType: input.tenantType,
      tenantId: input.tenantId,
      destinationId,
    };
    const blob = await this.cipher.encrypt(validation.config, tenantRef);

    const now = this.now();
    const releaseStatus = input.releaseStatus ?? 'stable';

    const row = await this.db.broadcastDestination.create({
      data: {
        id: destinationId,
        tenantType: input.tenantType,
        tenantId: input.tenantId,
        destinationType: input.destinationType,
        name: input.name,
        enabled: input.enabled ?? true,
        configCiphertext: toBytes(blob.ciphertext),
        configIv: toBytes(blob.iv),
        configAuthTag: toBytes(blob.authTag),
        configAad: blob.aad,
        configDekWrapped: toBytes(blob.dekWrapped),
        configKekResource: blob.kekResource,
        apiKeyFilter: toInputJson(input.apiKeyFilter ?? []),
        samplingRate: new PrismaDecimalLike(samplingRate).toString(),
        privacyMode: input.privacyMode ?? false,
        privacyCustomFields: toInputJson(input.privacyCustomFields ?? []),
        releaseStatus,
        createdAt: now,
        updatedAt: now,
      },
    });

    log.info(
      {
        destinationId: row.id,
        tenantType: row.tenantType,
        tenantId: row.tenantId,
        destinationType: row.destinationType,
      },
      'broadcast destination created',
    );

    return { ok: true, destination: toDto(row) };
  }

  async list(scope: TenantScope): Promise<DestinationDto[]> {
    const rows = await this.db.broadcastDestination.findMany({
      where: {
        tenantType: scope.tenantType,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async getById(
    scope: TenantScope,
    id: string,
  ): Promise<{ ok: true; destination: DestinationDto } | { ok: false; error: DestinationManagerError }> {
    const row = await this.db.broadcastDestination.findFirst({
      where: {
        id,
        tenantType: scope.tenantType,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
    });
    if (!row) return { ok: false, error: { code: 'not_found' } };
    return { ok: true, destination: toDto(row) };
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateDestinationInput,
  ): Promise<{ ok: true; destination: DestinationDto } | { ok: false; error: DestinationManagerError }> {
    const existing = await this.db.broadcastDestination.findFirst({
      where: {
        id,
        tenantType: scope.tenantType,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
    });
    if (!existing) return { ok: false, error: { code: 'not_found' } };

    if (patch.name !== undefined && (patch.name.length === 0 || patch.name.length > 128)) {
      return { ok: false, error: { code: 'invalid_input', message: 'name must be 1..128 chars' } };
    }
    if (
      patch.samplingRate !== undefined &&
      (!Number.isFinite(patch.samplingRate) || patch.samplingRate < 0 || patch.samplingRate > 1)
    ) {
      return {
        ok: false,
        error: { code: 'invalid_input', message: 'samplingRate must be in [0, 1]' },
      };
    }

    const data: Prisma.BroadcastDestinationUpdateInput = {
      updatedAt: this.now(),
    };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.samplingRate !== undefined) {
      data.samplingRate = new PrismaDecimalLike(patch.samplingRate).toString();
    }
    if (patch.privacyMode !== undefined) data.privacyMode = patch.privacyMode;
    if (patch.privacyCustomFields !== undefined) {
      data.privacyCustomFields = toInputJson(patch.privacyCustomFields);
    }
    if (patch.apiKeyFilter !== undefined) {
      data.apiKeyFilter = toInputJson(patch.apiKeyFilter);
    }
    if (patch.releaseStatus !== undefined) data.releaseStatus = patch.releaseStatus;

    if (patch.config !== undefined) {
      const validation = validateDestinationConfig(
        existing.destinationType as DestinationType,
        patch.config,
      );
      if (!validation.ok) {
        return { ok: false, error: { code: 'invalid_config', message: validation.error } };
      }
      const tenantRef: TenantRef = {
        tenantType: scope.tenantType,
        tenantId: scope.tenantId,
        destinationId: id,
      };
      const blob = await this.cipher.encrypt(validation.config, tenantRef);
      // Invalidate the decryption cache so the delivery executor picks up
      // the new DEK immediately instead of serving a stale plaintext.
      this.cipher.invalidate(tenantRef);
      data.configCiphertext = toBytes(blob.ciphertext);
      data.configIv = toBytes(blob.iv);
      data.configAuthTag = toBytes(blob.authTag);
      data.configAad = blob.aad;
      data.configDekWrapped = toBytes(blob.dekWrapped);
      data.configKekResource = blob.kekResource;
    }

    const updated = await this.db.broadcastDestination.update({
      where: { id },
      data,
    });

    return { ok: true, destination: toDto(updated) };
  }

  async delete(
    scope: TenantScope,
    id: string,
  ): Promise<{ ok: true } | { ok: false; error: DestinationManagerError }> {
    const existing = await this.db.broadcastDestination.findFirst({
      where: {
        id,
        tenantType: scope.tenantType,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
    });
    if (!existing) return { ok: false, error: { code: 'not_found' } };

    await this.db.broadcastDestination.update({
      where: { id },
      data: {
        deletedAt: this.now(),
        enabled: false,
      },
    });
    this.cipher.invalidate({
      tenantType: scope.tenantType,
      tenantId: scope.tenantId,
      destinationId: id,
    });

    log.info(
      { destinationId: id, tenantType: scope.tenantType, tenantId: scope.tenantId },
      'broadcast destination soft-deleted',
    );

    return { ok: true };
  }

  /**
   * Decrypt-and-return helper reserved for admin surfaces like the connection
   * tester. NOT exposed on the public list/get routes — see class header.
   */
  async decryptConfig<T extends object = Record<string, unknown>>(
    scope: TenantScope,
    id: string,
  ): Promise<
    | { ok: true; config: T }
    | { ok: false; error: DestinationManagerError }
  > {
    const row = await this.db.broadcastDestination.findFirst({
      where: {
        id,
        tenantType: scope.tenantType,
        tenantId: scope.tenantId,
        deletedAt: null,
      },
    });
    if (!row) return { ok: false, error: { code: 'not_found' } };
    const blob: EncryptedBlob = {
      ciphertext: Buffer.from(row.configCiphertext),
      iv: Buffer.from(row.configIv),
      authTag: Buffer.from(row.configAuthTag),
      aad: row.configAad,
      dekWrapped: Buffer.from(row.configDekWrapped),
      kekResource: row.configKekResource,
    };
    const config = await this.cipher.decrypt<T>(blob, {
      tenantType: scope.tenantType,
      tenantId: scope.tenantId,
      destinationId: id,
    });
    return { ok: true, config };
  }
}

// ─── DTO mapping ────────────────────────────────────────────────────────

function toDto(row: {
  id: string;
  tenantType: string;
  tenantId: string;
  destinationType: string;
  name: string;
  enabled: boolean;
  samplingRate: unknown;
  privacyMode: boolean;
  privacyCustomFields: unknown;
  apiKeyFilter: unknown;
  releaseStatus: string;
  configKekResource: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DestinationDto {
  return {
    id: row.id,
    tenantType: row.tenantType as TenantType,
    tenantId: row.tenantId,
    destinationType: row.destinationType as DestinationType,
    name: row.name,
    enabled: row.enabled,
    samplingRate:
      typeof row.samplingRate === 'string'
        ? Number(row.samplingRate)
        : typeof row.samplingRate === 'number'
        ? row.samplingRate
        : Number((row.samplingRate as { toString(): string }).toString()),
    privacyMode: row.privacyMode,
    privacyCustomFields: Array.isArray(row.privacyCustomFields)
      ? (row.privacyCustomFields as string[])
      : [],
    apiKeyFilter: Array.isArray(row.apiKeyFilter) ? (row.apiKeyFilter as string[]) : [],
    releaseStatus: row.releaseStatus as DestinationDto['releaseStatus'],
    kekResource: row.configKekResource,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Minimal helper to pass a number as a Prisma Decimal without importing the
 * Decimal runtime. Prisma accepts strings for Decimal columns at write time.
 */
class PrismaDecimalLike {
  constructor(private readonly n: number) {}
  toString(): string {
    // Clamp to the DB precision: Decimal(5,4) — 5 total digits, 4 after dot.
    return this.n.toFixed(4);
  }
}

/**
 * Prisma v5 types Bytes columns as Uint8Array. Node Buffer IS a Uint8Array
 * at runtime but TS's structural check trips on the extra Buffer methods.
 * `Uint8Array.from(buf)` copies, so cast instead — safe because runtime OK.
 */
function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  // TS 5.7 parameterizes Uint8Array by backing-buffer kind. Prisma's generated
  // types pin Uint8Array<ArrayBuffer>. Buffers in Node are backed by an
  // ArrayBuffer pool — so a single cast is safe at runtime even though TS
  // can't see it. Copying via Uint8Array.from would also work but adds an
  // allocation. The structural overlap (Buffer extends Uint8Array<ArrayBufferLike>)
  // means we don't need to launder through `unknown`.
  return buf as Uint8Array<ArrayBuffer>;
}
