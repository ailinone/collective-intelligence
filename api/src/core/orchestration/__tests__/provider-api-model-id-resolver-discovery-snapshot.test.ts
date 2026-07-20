// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1F §12.2 — Resolver consumes discovery snapshot at top priority.
 */
import { describe, it, expect } from 'vitest';
import { resolveApiModelId } from '@/core/orchestration/model-routing/provider-api-model-id-resolver';

describe('01C.1B-J1F §12.2 — resolver discovery snapshot integration', () => {
  it('explicit alias trumps snapshot (operator override wins for KNOWN cases)', () => {
    // J1F design decision: catalog rows can be noisy. Operator-curated
    // PROVIDER_MODEL_ALIASES knows the canonical API form; snapshot is
    // for UNKNOWN cases. So explicit > snapshot.
    const r = resolveApiModelId({
      providerId: 'openrouter',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      discoverySnapshotLookup: ({ providerId, logicalModelId }) => {
        if (providerId === 'openrouter' && logicalModelId === 'anthropic-claude-3.7-sonnet') {
          return { apiModelId: 'anthropic/claude-3.7-sonnet:beta', confidence: 'exact', matchKind: 'exact_canonical' };
        }
        return undefined;
      },
    });
    // openrouter HAS an explicit alias entry in PROVIDER_MODEL_ALIASES — that wins
    expect(r.source).toBe('provider_explicit_alias');
    expect(r.apiModelId).toBe('anthropic/claude-3.7-sonnet');
  });

  it('snapshot wins when NO explicit alias exists for the pair', () => {
    // unmapped-router has no explicit alias entry → snapshot takes over
    const r = resolveApiModelId({
      providerId: 'unmapped-router',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      discoverySnapshotLookup: ({ providerId }) => {
        if (providerId === 'unmapped-router') {
          return { apiModelId: 'anthropic/claude-3.7-sonnet:discovered', confidence: 'exact', matchKind: 'exact_canonical' };
        }
        return undefined;
      },
    });
    expect(r.source).toBe('discovery_alias_snapshot');
    expect(r.apiModelId).toBe('anthropic/claude-3.7-sonnet:discovered');
  });

  it('falls back to conservative derivation when snapshot AND alias both miss', () => {
    const r = resolveApiModelId({
      providerId: 'unmapped-router',
      logicalModelId: 'anthropic-claude-3.7-sonnet',
      nativeProviderId: 'anthropic',
      discoverySnapshotLookup: () => undefined,
    });
    expect(r.source).toBe('conservative_derivation');
    expect(r.apiModelId).toBe('anthropic/claude-3.7-sonnet');
  });

  it('snapshot confidence "high" maps to resolution confidence "discovery"', () => {
    const r = resolveApiModelId({
      providerId: 'p',
      logicalModelId: 'm',
      nativeProviderId: 'p',
      discoverySnapshotLookup: () => ({ apiModelId: 'x', confidence: 'high', matchKind: 'native_family_match' }),
    });
    expect(r.confidence).toBe('discovery');
  });

  it('aliasReason includes match kind + confidence for auditability', () => {
    const r = resolveApiModelId({
      providerId: 'p',
      logicalModelId: 'm',
      nativeProviderId: 'p',
      discoverySnapshotLookup: () => ({ apiModelId: 'x', confidence: 'high', matchKind: 'native_family_match' }),
    });
    expect(r.aliasReason).toContain('native_family_match');
    expect(r.aliasReason).toContain('high');
  });
});
