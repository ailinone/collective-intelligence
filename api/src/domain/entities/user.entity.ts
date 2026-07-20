// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Entity
 * Core domain entity representing a user
 *
 * DDD Pattern: Entity
 * - Has identity (UserId)
 * - Has lifecycle
 * - Contains business logic
 * - Validates invariants
 */

import { UserId } from '../value-objects/user-id';
import { Email } from '../value-objects/email';
import { PasswordHash } from '../value-objects/password-hash';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  DEVELOPER = 'developer',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

export interface UserProps {
  id: UserId;
  email: Email;
  name: string;
  role: UserRole;
  status: UserStatus;
  organizationId: string;
  createdAt: Date;
  updatedAt: Date;
  passwordHash?: PasswordHash;
  statusReason?: string;
}

export class UserEntity {
  private props: UserProps;

  private constructor(props: UserProps) {
    this.validateInvariants(props);
    this.props = props;
  }

  /**
   * Factory method - Create new user
   */
  static create(data: {
    email: string;
    name: string;
    organizationId: string;
    role?: UserRole;
    passwordHash?: PasswordHash;
  }): UserEntity {
    const now = new Date();

    return new UserEntity({
      id: UserId.generate(),
      email: Email.create(data.email),
      name: data.name.trim(),
      role: data.role || UserRole.USER,
      status: UserStatus.ACTIVE,
      organizationId: data.organizationId,
      passwordHash: data.passwordHash,
      createdAt: now,
      updatedAt: now,
      statusReason: undefined,
    });
  }

  /**
   * Reconstitute from persistence
   */
  static reconstitute(data: {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organizationId: string;
    createdAt: Date;
    updatedAt: Date;
    passwordHash?: string | null;
    statusReason?: string | null;
  }): UserEntity {
    return new UserEntity({
      id: UserId.create(data.id),
      email: Email.create(data.email),
      name: data.name,
      role: data.role as UserRole,
      status: data.status as UserStatus,
      organizationId: data.organizationId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      passwordHash: data.passwordHash ? PasswordHash.fromHash(data.passwordHash) : undefined,
      statusReason: data.statusReason ?? undefined,
    });
  }

  /**
   * Business rule validation (invariants)
   */
  private validateInvariants(props: UserProps): void {
    if (!props.name || props.name.trim().length === 0) {
      throw new Error('User name cannot be empty');
    }

    if (props.name.length > 100) {
      throw new Error('User name cannot exceed 100 characters');
    }

    if (!props.organizationId) {
      throw new Error('User must belong to an organization');
    }

    if (props.createdAt > new Date()) {
      throw new Error('Created date cannot be in the future');
    }
  }

  /**
   * Business Logic: Activate user
   */
  activate(): void {
    if (this.props.status === UserStatus.ACTIVE) {
      throw new Error('User is already active');
    }

    this.props.status = UserStatus.ACTIVE;
    this.props.updatedAt = new Date();
    this.props.statusReason = undefined;
  }

  /**
   * Business Logic: Suspend user
   */
  suspend(reason?: string): void {
    if (this.props.status === UserStatus.SUSPENDED) {
      throw new Error('User is already suspended');
    }

    this.props.status = UserStatus.SUSPENDED;
    this.props.updatedAt = new Date();
    this.props.statusReason = reason ?? 'suspended';

    // Could emit domain event here
    // this.addDomainEvent(new UserSuspended(this.id, reason));
  }

  /**
   * Business Logic: Change name
   */
  changeName(newName: string): void {
    if (!newName || newName.trim().length === 0) {
      throw new Error('Name cannot be empty');
    }

    if (newName.length > 100) {
      throw new Error('Name cannot exceed 100 characters');
    }

    this.props.name = newName.trim();
    this.props.updatedAt = new Date();
  }

  /**
   * Business Logic: Change email
   * Note: Email changes may require verification in production
   */
  changeEmail(newEmail: string): void {
    if (!newEmail || newEmail.trim().length === 0) {
      throw new Error('Email cannot be empty');
    }

    // Validate email format via Email value object
    const emailValueObject = Email.create(newEmail);
    
    // Only update if email actually changed
    if (this.props.email.getValue().toLowerCase() !== emailValueObject.getValue().toLowerCase()) {
      this.props.email = emailValueObject;
      this.props.updatedAt = new Date();
    }
  }

  /**
   * Business Logic: Promote to admin
   */
  promoteToAdmin(): void {
    if (this.props.role === UserRole.ADMIN) {
      throw new Error('User is already an admin');
    }

    this.props.role = UserRole.ADMIN;
    this.props.updatedAt = new Date();
  }

  /**
   * Check if user is active
   */
  isActive(): boolean {
    return this.props.status === UserStatus.ACTIVE;
  }

  /**
   * Check if user is admin
   */
  isAdmin(): boolean {
    return this.props.role === UserRole.ADMIN;
  }

  /**
   * Business Logic: Set / update password hash
   */
  setPasswordHash(hash: PasswordHash): void {
    this.props.passwordHash = hash;
    this.props.updatedAt = new Date();
  }

  /**
   * Verify plain text password against stored hash
   */
  async verifyPassword(password: string): Promise<boolean> {
    if (!this.props.passwordHash) {
      return false;
    }

    return this.props.passwordHash.verify(password);
  }

  /**
   * Getters (expose only what's needed)
   */
  get id(): string {
    return this.props.id.getValue();
  }

  // Return Value Object (for domain use)
  getIdObject(): UserId {
    return this.props.id;
  }

  get email(): string {
    return this.props.email.getValue();
  }

  // Return Value Object (for domain use)
  getEmailObject(): Email {
    return this.props.email;
  }

  get name(): string {
    return this.props.name;
  }

  get role(): UserRole {
    return this.props.role;
  }

  get status(): UserStatus {
    return this.props.status;
  }

  get statusReason(): string | undefined {
    return this.props.statusReason;
  }

  get organizationId(): string {
    return this.props.organizationId;
  }

  get passwordHash(): PasswordHash | undefined {
    return this.props.passwordHash;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /**
   * To persistence (DTO)
   */
  toPersistence(): {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organizationId: string;
    createdAt: Date;
    updatedAt: Date;
    passwordHash?: string | null;
    statusReason?: string | null;
  } {
    return {
      id: this.props.id.getValue(),
      email: this.props.email.getValue(),
      name: this.props.name,
      role: this.props.role,
      status: this.props.status,
      organizationId: this.props.organizationId,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      passwordHash: this.props.passwordHash ? this.props.passwordHash.getValue() : null,
      statusReason: this.props.statusReason ?? null,
    };
  }

  /**
   * To presentation (DTO)
   */
  toDTO(): {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organizationId: string;
    createdAt: string;
    updatedAt: string;
    statusReason?: string | null;
  } {
    return {
      id: this.props.id.getValue(),
      email: this.props.email.getValue(),
      name: this.props.name,
      role: this.props.role,
      status: this.props.status,
      organizationId: this.props.organizationId,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
      statusReason: this.props.statusReason ?? null,
    };
  }

  toJSON(): {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organizationId: string;
    createdAt: string;
    updatedAt: string;
    statusReason?: string | null;
  } {
    return this.toDTO();
  }
}
