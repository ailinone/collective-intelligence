// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Organization Aggregate
 * Aggregate Root: Organization + Members
 *
 * DDD Pattern: Aggregate
 * - Ensures consistency between Organization and Members
 * - Enforces tier limits
 * - Transaction boundary for multi-entity operations
 */

import { OrganizationEntity } from '../entities/organization.entity';
import { UserEntity, UserRole } from '../entities/user.entity';
import { OrganizationTierUpgradedEvent } from '../events/organization-tier-upgraded.event';
import { OrganizationTierDowngradedEvent } from '../events/organization-tier-downgraded.event';
import { BaseDomainEvent } from '../events/base-domain-event';
import { TierLevel } from '../value-objects/organization-tier';

export class OrganizationAggregate {
  private organization: OrganizationEntity;
  private members: Map<string, UserEntity>;
  private domainEvents: Array<BaseDomainEvent | OrganizationTierUpgradedEvent | OrganizationTierDowngradedEvent>;

  private constructor(organization: OrganizationEntity, members: UserEntity[] = []) {
    this.organization = organization;
    this.members = new Map();
    this.domainEvents = [];

    // Initialize members map
    for (const member of members) {
      this.members.set(member.id, member); // id is already string
    }
  }

  /**
   * Factory: Create new organization
   */
  static create(data: {
    name: string;
    tier?: TierLevel;
    ownerEmail: string;
    ownerName: string;
  }): OrganizationAggregate {
    const organization = OrganizationEntity.create({
      name: data.name,
      tier: data.tier,
    });

    // Create owner as first member
    // ownerEmail parameter expects Email VO, need to handle if string
    const ownerEmailStr =
      typeof data.ownerEmail === 'string'
        ? data.ownerEmail
        : (data.ownerEmail && typeof data.ownerEmail === 'object' && 'getValue' in data.ownerEmail && typeof (data.ownerEmail as { getValue: () => string }).getValue === 'function')
          ? (data.ownerEmail as { getValue: () => string }).getValue()
          : String(data.ownerEmail);

    const owner = UserEntity.create({
      email: ownerEmailStr,
      name: data.ownerName,
      organizationId: organization.id,
      role: UserRole.ADMIN, // Owner is admin
    });

    const aggregate = new OrganizationAggregate(organization, [owner]);

    // Increment member count
    organization.incrementMemberCount();

    return aggregate;
  }

  /**
   * Reconstitute from persistence
   */
  static reconstitute(
    organization: OrganizationEntity,
    members: UserEntity[] = []
  ): OrganizationAggregate {
    return new OrganizationAggregate(organization, members);
  }

  /**
   * Business Logic: Add member to organization
   */
  addMember(userData: { email: string; name: string; role?: string }): UserEntity {
    // Business rule: Organization must be active
    if (!this.organization.isActive()) {
      throw new Error('Cannot add member to suspended organization');
    }

    // Business rule: Check tier limit
    if (!this.organization.canAddMember()) {
      const limits = this.organization.tier.getLimits();
      throw new Error(
        `Cannot add member: tier limit reached (max ${limits.maxMembers} members for ${this.organization.tier.getLevel()} tier)`
      );
    }

    // Create new member
    interface EmailValueObject {
      getValue?: () => string;
    }
    const emailValue: string | EmailValueObject | unknown = userData.email;
    const emailStr: string =
      typeof emailValue === 'string'
        ? emailValue
        : (emailValue && typeof emailValue === 'object' && 'getValue' in emailValue && typeof emailValue.getValue === 'function')
          // The structural check above gives us a function; we still need
          // to constrain its return type because `function` is `Function`.
          ? String((emailValue as EmailValueObject).getValue?.() ?? '')
          : String(emailValue);

    const member = UserEntity.create({
      email: emailStr,
      name: userData.name,
      organizationId: this.organization.id,
      role: userData.role as UserRole,
    });

    // Add to aggregate
    this.members.set(member.id, member); // id is already string

    // Increment organization member count
    this.organization.incrementMemberCount();

    return member;
  }

  /**
   * Business Logic: Remove member
   */
  removeMember(userId: string): void {
    const member = this.members.get(userId);

    if (!member) {
      throw new Error(`Member not found: ${userId}`);
    }

    // Business rule: Cannot remove last admin
    if (member.isAdmin()) {
      const adminCount = Array.from(this.members.values()).filter((m) => m.isAdmin()).length;
      if (adminCount <= 1) {
        throw new Error('Cannot remove last admin from organization');
      }
    }

    // Remove from aggregate
    this.members.delete(userId);

    // Decrement organization member count
    this.organization.decrementMemberCount();
  }

  /**
   * Business Logic: Upgrade organization tier
   */
  upgradeTier(newTier: TierLevel, upgradedBy: string): void {
    const oldTier = this.organization.tier.getLevel();

    // Upgrade the organization
    this.organization.upgradeTier(newTier);

    // Emit domain event
    this.addDomainEvent(
      OrganizationTierUpgradedEvent.create({
        organizationId: this.organization.id,
        oldTier,
        newTier,
        upgradedBy,
        reason: 'Manual upgrade',
      })
    );
  }

  /**
   * Business Logic: Downgrade tier (with validation)
   */
  downgradeTier(newTier: TierLevel, reason?: string): void {
    const oldTier = this.organization.tier.getLevel();

    if (newTier === oldTier) {
      return;
    }

    this.organization.downgradeTier(newTier);

    this.addDomainEvent(
      OrganizationTierDowngradedEvent.create({
        organizationId: this.organization.id,
        oldTier,
        newTier,
        reason,
      })
    );
  }

  /**
   * Business Logic: Suspend organization (cascades to members)
   */
  suspendOrganization(reason?: string): void {
    this.organization.suspend(reason);

    // Business rule: Suspend all members when organization is suspended
    for (const member of this.members.values()) {
      if (member.isActive()) {
        member.suspend(`Organization suspended: ${reason || 'no reason'}`);
      }
    }
  }

  /**
   * Get active member count
   */
  getActiveMemberCount(): number {
    return Array.from(this.members.values()).filter((m) => m.isActive()).length;
  }

  /**
   * Get admin count
   */
  getAdminCount(): number {
    return Array.from(this.members.values()).filter((m) => m.isAdmin()).length;
  }

  /**
   * Check if user is member
   */
  isMember(userId: string): boolean {
    return this.members.has(userId);
  }

  /**
   * Check if user is admin
   */
  isAdmin(userId: string): boolean {
    const member = this.members.get(userId);
    return member?.isAdmin() || false;
  }

  /**
   * Domain Events Management
   */
  private addDomainEvent(event: BaseDomainEvent | OrganizationTierUpgradedEvent | OrganizationTierDowngradedEvent): void {
    this.domainEvents.push(event);
  }

  getDomainEvents(): Array<BaseDomainEvent | OrganizationTierUpgradedEvent | OrganizationTierDowngradedEvent> {
    return [...this.domainEvents];
  }

  clearDomainEvents(): void {
    this.domainEvents = [];
  }

  /**
   * Getters
   */
  getOrganization(): OrganizationEntity {
    return this.organization;
  }

  getMember(userId: string): UserEntity | undefined {
    return this.members.get(userId);
  }

  getAllMembers(): UserEntity[] {
    return Array.from(this.members.values());
  }

  /**
   * To persistence (for repository)
   */
  toPersistence(): {
    organization: ReturnType<OrganizationEntity['toPersistence']>;
    members: ReturnType<UserEntity['toPersistence']>[];
  } {
    return {
      organization: this.organization.toPersistence(),
      members: Array.from(this.members.values()).map((m) => m.toPersistence()),
    };
  }
}
