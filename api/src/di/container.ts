// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dependency Injection Container
 * Using tsyringe for IoC (Inversion of Control)
 *
 * Clean Architecture Pattern:
 * - Register all dependencies here
 * - Interface → Implementation mapping
 * - Singleton vs Transient lifecycles
 */

import 'reflect-metadata';
import { container } from 'tsyringe';
import { logger } from '@/utils/logger';

// Repository Interfaces → Implementations
import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';
import { IApiKeyRepository } from '@/domain/repositories/iapi-key-repository';
import { IProjectRepository } from '@/domain/repositories/iproject-repository';

// Repository Implementations
import { PrismaUserRepository } from '@/infrastructure/repositories/prisma-user-repository';
import { PrismaOrganizationRepository } from '@/infrastructure/repositories/prisma-organization-repository';
import { PrismaApiKeyRepository } from '@/infrastructure/repositories/prisma-api-key-repository';
import { PrismaProjectRepository } from '@/infrastructure/repositories/prisma-project-repository';

// Event Bus
import { IEventBus } from '@/infrastructure/events/event-bus.interface';
import { InMemoryEventBus } from '@/infrastructure/events/in-memory-event-bus';

const log = logger.child({ component: 'di-container' });
let initialized = false;

/**
 * Initialize DI Container
 * Register all dependencies
 */
export function initializeDIContainer(): void {
  if (initialized) {
    log.debug('DI Container already initialized, skipping re-registration');
    return;
  }

  try {
    // ==========================================
    // REPOSITORIES (Singleton)
    // ==========================================

    container.registerSingleton<IUserRepository>('IUserRepository', PrismaUserRepository);

    container.registerSingleton<IOrganizationRepository>(
      'IOrganizationRepository',
      PrismaOrganizationRepository
    );

    container.registerSingleton<IApiKeyRepository>('IApiKeyRepository', PrismaApiKeyRepository);

    container.registerSingleton<IProjectRepository>(
      'IProjectRepository',
      PrismaProjectRepository
    );

    // ==========================================
    // EVENT BUS (Singleton)
    // ==========================================

    container.registerSingleton<IEventBus>('IEventBus', InMemoryEventBus);

    // ==========================================
    // COMMAND HANDLERS (Transient)
    // ==========================================

    // Auto-registered via @injectable decorator
    // Handlers are created on-demand with injected dependencies
    // Available handlers:
    // - CreateUserHandler
    // - UpdateUserHandler
    // - RegisterUserHandler
    // - LoginUserHandler
    // - RotateApiKeyHandler

    // ==========================================
    // QUERY HANDLERS (Transient)
    // ==========================================

    // Auto-registered via @injectable decorator
    // Available handlers:
    // - GetUserHandler
    // - ListOrganizationsHandler
    // - ListApiKeysHandler

    log.info('✅ DI Container initialized successfully');
    log.info(
      {
        repositories: 4,
        eventBus: 1,
        handlers: 'auto-registered',
      },
      'DI registrations complete'
    );

    initialized = true;
  } catch (error) {
    log.error({ error }, 'Failed to initialize DI container');
    throw error;
  }
}

/**
 * Get container instance
 */
export function getDIContainer() {
  return container;
}

/**
 * Reset container (for testing)
 */
export function resetDIContainer(): void {
  container.clearInstances();
  initialized = false;
  log.info('DI Container cleared');
}
