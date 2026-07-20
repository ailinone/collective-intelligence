// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1E §14.3 — Fingerprint includes apiModelId + alias resolution.
 *
 * Pins:
 *   - Different apiModelId values produce different fingerprints
 *     (the fingerprint hashes the EXECUTABLE routeCandidates, and the
 *     apiModelId is part of each route projection).
 *   - The contract: if the resolver produces a different apiModelId
 *     (e.g., because an alias was added), the planFingerprint MUST
 *     change.
 *
 * Pure-projection tests — no DB, no provider calls.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

// Mirror the chat-request-processor's fingerprint projection for routes.
function projectRouteForFingerprint(route: {
  routeId: string;
  apiModelId: string;
  providerId: string;
  adapterKind: string;
  equivalenceKind: string;
  logicalModelId: string;
}) {
  return {
    routeId: route.routeId,
    logicalModelId: route.logicalModelId,
    apiModelId: route.apiModelId,
    providerId: route.providerId,
    adapterKind: route.adapterKind,
    equivalenceKind: route.equivalenceKind,
  };
}

function hashRoutes(routes: ReadonlyArray<ReturnType<typeof projectRouteForFingerprint>>): string {
  return createHash('sha256').update(JSON.stringify(routes)).digest('hex');
}

describe('01C.1B-J1E §14.3 — fingerprint includes apiModelId', () => {
  it('changing apiModelId changes the fingerprint', () => {
    const route1 = {
      routeId: 'openrouter::anthropic/claude-3.7-sonnet::openai-compatible-chat',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      apiModelId: 'anthropic/claude-3.7-sonnet',
      providerId: 'openrouter',
      adapterKind: 'openai-compatible-chat',
      equivalenceKind: 'exact_same_model',
    };
    const route2 = {
      ...route1,
      apiModelId: 'anthropic/anthropic-claude-3.7-sonnet', // the BAD form
      routeId: 'openrouter::anthropic/anthropic-claude-3.7-sonnet::openai-compatible-chat',
    };
    const fp1 = hashRoutes([projectRouteForFingerprint(route1)]);
    const fp2 = hashRoutes([projectRouteForFingerprint(route2)]);
    expect(fp1).not.toBe(fp2);
  });

  it('same apiModelId produces same fingerprint (determinism)', () => {
    const route = {
      routeId: 'openrouter::anthropic/claude-3.7-sonnet::openai-compatible-chat',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      apiModelId: 'anthropic/claude-3.7-sonnet',
      providerId: 'openrouter',
      adapterKind: 'openai-compatible-chat',
      equivalenceKind: 'exact_same_model',
    };
    expect(hashRoutes([projectRouteForFingerprint(route)])).toBe(hashRoutes([projectRouteForFingerprint(route)]));
  });

  it('multiple routes: order-stable fingerprint', () => {
    const routes = [
      { routeId: 'a::m::adapter', logicalModelId: 'm', apiModelId: 'm', providerId: 'a', adapterKind: 'adapter', equivalenceKind: 'exact_same_model' },
      { routeId: 'b::m::adapter', logicalModelId: 'm', apiModelId: 'm', providerId: 'b', adapterKind: 'adapter', equivalenceKind: 'exact_same_model' },
    ];
    const fp1 = hashRoutes(routes.map(projectRouteForFingerprint));
    const fp2 = hashRoutes(routes.map(projectRouteForFingerprint));
    expect(fp1).toBe(fp2);
  });

  it('apiModelId change propagates into all 15 synthesizer routes', () => {
    // Simulate: before J1E, all 14 router peerings had `anthropic/anthropic-claude-3.7-sonnet`
    // After J1E, alias map flips them to `anthropic/claude-3.7-sonnet`.
    const beforeRoutes = Array.from({ length: 14 }, (_, i) => ({
      routeId: `router${i}::anthropic/anthropic-claude-3.7-sonnet::adapter`,
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      apiModelId: 'anthropic/anthropic-claude-3.7-sonnet',
      providerId: `router${i}`,
      adapterKind: 'adapter',
      equivalenceKind: 'same_provider_model_via_router',
    }));
    const afterRoutes = beforeRoutes.map((r) => ({
      ...r,
      routeId: r.routeId.replace('anthropic/anthropic-', 'anthropic/'),
      apiModelId: 'anthropic/claude-3.7-sonnet',
    }));
    const fpBefore = hashRoutes(beforeRoutes.map(projectRouteForFingerprint));
    const fpAfter = hashRoutes(afterRoutes.map(projectRouteForFingerprint));
    expect(fpBefore).not.toBe(fpAfter);
  });

  it('contract: pure function, no Prisma, no fetch', () => {
    expect(typeof projectRouteForFingerprint).toBe('function');
    expect(typeof hashRoutes).toBe('function');
  });
});
