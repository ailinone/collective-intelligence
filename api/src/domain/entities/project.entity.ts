// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Project Entity
 *
 * Resource-layer sub-entity within an Organization. A Project is a container
 * for application-scoped resources (API keys, deploys, telemetry).
 *
 * DDD Pattern: Aggregate Root
 *   - Owns its lifecycle (active / archived)
 *   - Enforces invariants on name + slug
 *   - Business operations (rename, archive, restore) emit state transitions
 *     that the repository persists atomically
 *
 * Status model: `active` | `archived`. Archived is reversible (restore).
 * Hard delete is NOT exposed on the entity — handled separately at infra
 * layer for admin-only ops (CWE-274 mitigation: don't lower privilege of
 * destructive actions).
 */

export enum ProjectStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

export interface ProjectProps {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  createdBy: string;
}

const NAME_MAX_LENGTH = 100;
const SLUG_MAX_LENGTH = 64;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DESCRIPTION_MAX_LENGTH = 1000;

export class ProjectEntity {
  private props: ProjectProps;

  private constructor(props: ProjectProps) {
    this.validateInvariants(props);
    this.props = props;
  }

  /**
   * Factory: create a brand-new Project. Caller passes the slug already
   * derived (so collision-resolution lives in the application layer, not
   * the entity — keeps invariants pure).
   */
  static create(data: {
    organizationId: string;
    name: string;
    slug: string;
    description?: string | null;
    settings?: Record<string, unknown>;
    createdBy: string;
  }): ProjectEntity {
    const now = new Date();
    return new ProjectEntity({
      id: crypto.randomUUID(),
      organizationId: data.organizationId,
      name: data.name.trim(),
      slug: data.slug.trim().toLowerCase(),
      description: data.description?.trim() || null,
      status: ProjectStatus.ACTIVE,
      settings: data.settings ?? {},
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      createdBy: data.createdBy,
    });
  }

  /**
   * Reconstitute from persistence (repository read path).
   */
  static reconstitute(data: {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    description: string | null;
    status: string;
    settings: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
    createdBy: string;
  }): ProjectEntity {
    return new ProjectEntity({
      id: data.id,
      organizationId: data.organizationId,
      name: data.name,
      slug: data.slug,
      description: data.description,
      status: data.status as ProjectStatus,
      settings: data.settings ?? {},
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      archivedAt: data.archivedAt,
      createdBy: data.createdBy,
    });
  }

  /**
   * Domain invariants. Enforced on construct and after mutations.
   * Length caps mirror the migration's column types — keep them in sync.
   */
  private validateInvariants(props: ProjectProps): void {
    if (!props.name || props.name.trim().length === 0) {
      throw new Error('Project name cannot be empty');
    }
    if (props.name.length > NAME_MAX_LENGTH) {
      throw new Error(`Project name cannot exceed ${NAME_MAX_LENGTH} characters`);
    }
    if (!props.slug || props.slug.length === 0) {
      throw new Error('Project slug cannot be empty');
    }
    if (props.slug.length > SLUG_MAX_LENGTH) {
      throw new Error(`Project slug cannot exceed ${SLUG_MAX_LENGTH} characters`);
    }
    if (!SLUG_PATTERN.test(props.slug)) {
      throw new Error(
        'Project slug must be lowercase alphanumeric with hyphens (no leading/trailing hyphen)'
      );
    }
    if (props.description && props.description.length > DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `Project description cannot exceed ${DESCRIPTION_MAX_LENGTH} characters`
      );
    }
  }

  /**
   * Rename a Project. Does NOT mutate slug — slug is immutable after create
   * to keep URLs stable. To "rename" the URL, create a new project.
   */
  rename(newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Project name cannot be empty');
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      throw new Error(`Project name cannot exceed ${NAME_MAX_LENGTH} characters`);
    }
    this.props.name = trimmed;
    this.props.updatedAt = new Date();
  }

  /**
   * Update the description. Empty string clears it (sets null in persistence).
   */
  setDescription(newDescription: string | null): void {
    if (newDescription === null) {
      this.props.description = null;
    } else {
      const trimmed = newDescription.trim();
      if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
        throw new Error(
          `Project description cannot exceed ${DESCRIPTION_MAX_LENGTH} characters`
        );
      }
      this.props.description = trimmed || null;
    }
    this.props.updatedAt = new Date();
  }

  /**
   * Merge new settings on top of existing (shallow). Caller should pass
   * the FULL desired settings if they want replacement semantics.
   */
  mergeSettings(patch: Record<string, unknown>): void {
    this.props.settings = { ...this.props.settings, ...patch };
    this.props.updatedAt = new Date();
  }

  archive(): void {
    if (this.props.status === ProjectStatus.ARCHIVED) {
      throw new Error('Project is already archived');
    }
    this.props.status = ProjectStatus.ARCHIVED;
    this.props.archivedAt = new Date();
    this.props.updatedAt = new Date();
  }

  restore(): void {
    if (this.props.status === ProjectStatus.ACTIVE) {
      throw new Error('Project is already active');
    }
    this.props.status = ProjectStatus.ACTIVE;
    this.props.archivedAt = null;
    this.props.updatedAt = new Date();
  }

  // ── Queries ─────────────────────────────────────────────────────────
  isActive(): boolean {
    return this.props.status === ProjectStatus.ACTIVE;
  }

  isArchived(): boolean {
    return this.props.status === ProjectStatus.ARCHIVED;
  }

  // ── Getters ─────────────────────────────────────────────────────────
  get id(): string {
    return this.props.id;
  }

  get organizationId(): string {
    return this.props.organizationId;
  }

  get name(): string {
    return this.props.name;
  }

  get slug(): string {
    return this.props.slug;
  }

  get description(): string | null {
    return this.props.description;
  }

  get status(): ProjectStatus {
    return this.props.status;
  }

  get settings(): Record<string, unknown> {
    return this.props.settings;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get archivedAt(): Date | null {
    return this.props.archivedAt;
  }

  get createdBy(): string {
    return this.props.createdBy;
  }

  /**
   * Persistence DTO — matches Prisma column shape.
   */
  toPersistence(): {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    description: string | null;
    status: string;
    settings: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
    createdBy: string;
  } {
    return {
      id: this.props.id,
      organizationId: this.props.organizationId,
      name: this.props.name,
      slug: this.props.slug,
      description: this.props.description,
      status: this.props.status,
      settings: this.props.settings,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      archivedAt: this.props.archivedAt,
      createdBy: this.props.createdBy,
    };
  }

  /**
   * Presentation DTO — what API consumers see.
   */
  toDTO(): {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    description: string | null;
    status: string;
    settings: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
  } {
    return {
      id: this.props.id,
      organizationId: this.props.organizationId,
      name: this.props.name,
      slug: this.props.slug,
      description: this.props.description,
      status: this.props.status,
      settings: this.props.settings,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
      archivedAt: this.props.archivedAt?.toISOString() ?? null,
    };
  }
}
