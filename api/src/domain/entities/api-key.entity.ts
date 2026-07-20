// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ApiKey Entity
 * Domain entity for API keys with rotation and security logic
 *
 * DDD Pattern: Entity
 * Business Rules:
 * - Must belong to a user and organization
 * - Can be rotated (zero-downtime with grace period)
 * - Can be revoked
 * - Auto-rotation scheduling
 * - IP whitelist validation
 */

import { ApiKeyValue } from '../value-objects/api-key-value';

export enum ApiKeyStatus {
  ACTIVE = 'active',
  ROTATING = 'rotating',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}

export interface ApiKeyProps {
  id: string;
  name: string;
  keyValue: ApiKeyValue;
  userId: string;
  organizationId: string;
  status: ApiKeyStatus;
  statusReason?: string;

  // Usage tracking
  lastUsedAt: Date;
  requestCount: number;
  lastRequestIp?: string;

  // Expiration
  expiresAt?: Date;
  createdAt: Date;

  // Rotation
  rotatedAt?: Date;
  revokedAt?: Date;
  rotationCount: number;
  previousKeyId?: string;
  nextKeyId?: string;

  // Auto-rotation config
  autoRotate: boolean;
  rotationIntervalDays?: number;
  gracePeriodDays: number;

  // Security
  ipWhitelist: string[];
  permissions?: Record<string, boolean>;
}

export class ApiKeyEntity {
  private props: ApiKeyProps;

  private constructor(props: ApiKeyProps) {
    this.validateInvariants(props);
    this.props = props;
  }

  /**
   * Factory: Create new API key
   */
  static create(data: {
    name: string;
    userId: string;
    organizationId: string;
    expiresAt?: Date;
    autoRotate?: boolean;
    rotationIntervalDays?: number;
    ipWhitelist?: string[];
  }): ApiKeyEntity {
    const now = new Date();
    const keyValue = ApiKeyValue.generate('live');

    return new ApiKeyEntity({
      id: crypto.randomUUID(),
      name: data.name.trim(),
      keyValue,
      userId: data.userId,
      organizationId: data.organizationId,
      status: ApiKeyStatus.ACTIVE,
      statusReason: undefined,
      lastUsedAt: now,
      requestCount: 0,
      expiresAt: data.expiresAt,
      createdAt: now,
      rotationCount: 0,
      autoRotate: data.autoRotate || false,
      rotationIntervalDays: data.rotationIntervalDays,
      gracePeriodDays: 7, // Default 7 days grace period
      ipWhitelist: data.ipWhitelist || [],
    });
  }

  /**
   * Reconstitute from persistence
   */
  static reconstitute(data: {
    id: string;
    name: string;
    keyValue: string;
    userId: string;
    organizationId: string;
    status: string;
    statusReason?: string | null;
    lastUsedAt: Date;
    requestCount?: number;
    lastRequestIp?: string | null;
    expiresAt?: Date | null;
    createdAt: Date;
    rotatedAt?: Date | null;
    revokedAt?: Date | null;
    rotationCount?: number;
    previousKeyId?: string | null;
    nextKeyId?: string | null;
    autoRotate?: boolean;
    rotationIntervalDays?: number | null;
    gracePeriodDays?: number;
    ipWhitelist?: string[];
    permissions?: Record<string, boolean> | null;
  }): ApiKeyEntity {
    return new ApiKeyEntity({
      id: data.id,
      name: data.name,
      keyValue: ApiKeyValue.create(data.keyValue),
      userId: data.userId,
      organizationId: data.organizationId,
      status: data.status as ApiKeyStatus,
      statusReason: data.statusReason ?? undefined,
      lastUsedAt: data.lastUsedAt ?? undefined,
      requestCount: data.requestCount || 0,
      lastRequestIp: data.lastRequestIp ?? undefined,
      expiresAt: data.expiresAt ?? undefined,
      createdAt: data.createdAt,
      rotatedAt: data.rotatedAt ?? undefined,
      revokedAt: data.revokedAt ?? undefined,
      rotationCount: data.rotationCount || 0,
      previousKeyId: data.previousKeyId ?? undefined,
      nextKeyId: data.nextKeyId ?? undefined,
      autoRotate: data.autoRotate || false,
      rotationIntervalDays: data.rotationIntervalDays ?? undefined,
      gracePeriodDays: data.gracePeriodDays || 7,
      ipWhitelist: data.ipWhitelist || [],
      permissions: data.permissions ?? undefined,
    });
  }

  /**
   * Invariant validation
   */
  private validateInvariants(props: ApiKeyProps): void {
    if (!props.name || props.name.trim().length === 0) {
      throw new Error('API key name cannot be empty');
    }

    if (!props.userId) {
      throw new Error('API key must belong to a user');
    }

    if (!props.organizationId) {
      throw new Error('API key must belong to an organization');
    }

    if (props.expiresAt && props.expiresAt <= props.createdAt) {
      throw new Error('Expiration date must be after creation date');
    }

    if (props.autoRotate && !props.rotationIntervalDays) {
      throw new Error('Auto-rotation enabled but no interval specified');
    }

    if (props.rotationIntervalDays && props.rotationIntervalDays < 1) {
      throw new Error('Rotation interval must be at least 1 day');
    }

    if (props.gracePeriodDays < 0) {
      throw new Error('Grace period cannot be negative');
    }
  }

  /**
   * Business Logic: Record usage
   */
  recordUsage(ipAddress?: string): void {
    this.props.lastUsedAt = new Date();
    this.props.requestCount += 1;

    if (ipAddress) {
      this.props.lastRequestIp = ipAddress;
    }
  }

  /**
   * Business Logic: Start rotation (creates new key, enters grace period)
   */
  startRotation(newKeyId: string): void {
    if (this.props.status === ApiKeyStatus.ROTATING) {
      throw new Error('API key is already rotating');
    }

    if (this.props.status === ApiKeyStatus.REVOKED) {
      throw new Error('Cannot rotate revoked API key');
    }

    if (this.props.status === ApiKeyStatus.EXPIRED) {
      throw new Error('Cannot rotate expired API key');
    }

    this.props.status = ApiKeyStatus.ROTATING;
    this.props.nextKeyId = newKeyId;
    this.props.rotatedAt = new Date();
    this.props.statusReason = 'rotation-initiated';
  }

  /**
   * Business Logic: Complete rotation (revoke old key after grace period)
   */
  completeRotation(): void {
    if (this.props.status !== ApiKeyStatus.ROTATING) {
      throw new Error('API key is not in rotating state');
    }

    this.props.status = ApiKeyStatus.REVOKED;
    this.props.revokedAt = new Date();
    this.props.rotationCount += 1;
    this.props.statusReason = 'rotation-completed';
  }

  /**
   * Business Logic: Revoke immediately
   */
  revoke(reason?: string): void {
    if (this.props.status === ApiKeyStatus.REVOKED) {
      throw new Error('API key is already revoked');
    }

    this.props.status = ApiKeyStatus.REVOKED;
    this.props.revokedAt = new Date();
    this.props.statusReason = reason ?? 'manual-revocation';
  }

  /**
   * Business Logic: Mark as expired
   */
  markExpired(): void {
    if (this.props.status === ApiKeyStatus.EXPIRED) {
      throw new Error('API key is already expired');
    }

    this.props.status = ApiKeyStatus.EXPIRED;
    this.props.statusReason = 'expired';
  }

  /**
   * Business Logic: Enable auto-rotation
   */
  enableAutoRotation(intervalDays: number): void {
    if (intervalDays < 1) {
      throw new Error('Rotation interval must be at least 1 day');
    }

    this.props.autoRotate = true;
    this.props.rotationIntervalDays = intervalDays;
  }

  /**
   * Business Logic: Disable auto-rotation
   */
  disableAutoRotation(): void {
    this.props.autoRotate = false;
    this.props.rotationIntervalDays = undefined;
  }

  /**
   * Business Logic: Check if rotation is due
   */
  isRotationDue(): boolean {
    if (!this.props.autoRotate || !this.props.rotationIntervalDays) {
      return false;
    }

    const lastRotation = this.props.rotatedAt || this.props.createdAt;
    const nextRotation = new Date(lastRotation);
    nextRotation.setDate(nextRotation.getDate() + this.props.rotationIntervalDays);

    return new Date() >= nextRotation;
  }

  /**
   * Business Logic: Check if expired
   */
  isExpired(): boolean {
    if (!this.props.expiresAt) {
      return false;
    }
    return new Date() > this.props.expiresAt;
  }

  /**
   * Business Logic: Check if grace period active
   */
  isInGracePeriod(): boolean {
    if (this.props.status !== ApiKeyStatus.ROTATING || !this.props.rotatedAt) {
      return false;
    }

    const graceEnd = new Date(this.props.rotatedAt);
    graceEnd.setDate(graceEnd.getDate() + this.props.gracePeriodDays);

    return new Date() <= graceEnd;
  }

  /**
   * Business Logic: Validate IP whitelist
   */
  isIpAllowed(ipAddress: string): boolean {
    // If no whitelist, allow all
    if (!this.props.ipWhitelist || this.props.ipWhitelist.length === 0) {
      return true;
    }

    return this.props.ipWhitelist.includes(ipAddress);
  }

  /**
   * Getters
   */
  get id(): string {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get keyValue(): ApiKeyValue {
    return this.props.keyValue;
  }

  get status(): ApiKeyStatus {
    return this.props.status;
  }

  get userId(): string {
    return this.props.userId;
  }

  get organizationId(): string {
    return this.props.organizationId;
  }

  get statusReason(): string | undefined {
    return this.props.statusReason;
  }

  get requestCount(): number {
    return this.props.requestCount;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  /**
   * To persistence DTO
   */
  toPersistence(): {
    id: string;
    name: string;
    keyPrefix: string;
    keyValue: string; // Will be hashed before storage
    userId: string;
    organizationId: string;
    status: string;
    statusReason: string | null;
    lastUsedAt: Date;
    requestCount: number;
    lastRequestIp: string | null;
    expiresAt: Date | null;
    createdAt: Date;
    rotatedAt: Date | null;
    revokedAt: Date | null;
    rotationCount: number;
    previousKeyId: string | null;
    nextKeyId: string | null;
    autoRotate: boolean;
    rotationIntervalDays: number | null;
    gracePeriodDays: number;
    ipWhitelist: string[];
    permissions: Record<string, boolean> | null;
  } {
    return {
      id: this.props.id,
      name: this.props.name,
      keyPrefix: this.props.keyValue.getPrefix(),
      keyValue: this.props.keyValue.getValue(), // Will be hashed before storage
      userId: this.props.userId,
      organizationId: this.props.organizationId,
      status: this.props.status,
      statusReason: this.props.statusReason ?? null,
      lastUsedAt: this.props.lastUsedAt,
      requestCount: this.props.requestCount,
      lastRequestIp: this.props.lastRequestIp ?? null,
      expiresAt: this.props.expiresAt ?? null,
      createdAt: this.props.createdAt,
      rotatedAt: this.props.rotatedAt ?? null,
      revokedAt: this.props.revokedAt ?? null,
      rotationCount: this.props.rotationCount,
      previousKeyId: this.props.previousKeyId ?? null,
      nextKeyId: this.props.nextKeyId ?? null,
      autoRotate: this.props.autoRotate,
      rotationIntervalDays: this.props.rotationIntervalDays !== undefined ? this.props.rotationIntervalDays : null,
      gracePeriodDays: this.props.gracePeriodDays,
      ipWhitelist: this.props.ipWhitelist,
      permissions: this.props.permissions ?? null,
    };
  }

  /**
   * To presentation DTO (MASKED for security)
   */
  toDTO(): {
    id: string;
    name: string;
    keyPreview: string; // MASKED
    status: string;
    statusReason: string | null;
    lastUsedAt: string;
    requestCount: number;
    expiresAt: string | null;
    createdAt: string;
    rotationCount: number;
    autoRotate: boolean;
    rotationIntervalDays: number | null;
  } {
    return {
      id: this.props.id,
      name: this.props.name,
      keyPreview: this.props.keyValue.getMasked(), // MASKED
      status: this.props.status,
      statusReason: this.props.statusReason ?? null,
      lastUsedAt: this.props.lastUsedAt.toISOString(),
      requestCount: this.props.requestCount,
      expiresAt: this.props.expiresAt?.toISOString() ?? null,
      createdAt: this.props.createdAt.toISOString(),
      rotationCount: this.props.rotationCount,
      autoRotate: this.props.autoRotate,
      rotationIntervalDays: this.props.rotationIntervalDays ?? null,
    };
  }
}
