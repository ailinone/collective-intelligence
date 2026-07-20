// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1F §12.1 — Learner unit tests.
 *
 * Pins the matching algorithm's safety guards: family/version/variant
 * must match strictly; cross-variant (sonnet vs opus) and cross-gen
 * (3.7 vs 4.x) matches are HARD-REJECTED.
 */
import { describe, it, expect } from 'vitest';
import {
  learnAliasForProvider,
  parseLogicalModelTokens,
  type DiscoveredModelRow,
} from '@/core/orchestration/model-routing/provider-discovery-alias-learner';

describe('01C.1B-J1F §12.1 — parseLogicalModelTokens', () => {
  it('parses anthropic-claude-3.7-sonnet', () => {
    const t = parseLogicalModelTokens('anthropic-claude-3.7-sonnet');
    expect(t).toEqual({ family: 'claude', versionMajor: '3', versionMinor: '7', variant: 'sonnet' });
  });

  it('parses claude-3-7-sonnet (hyphen version)', () => {
    const t = parseLogicalModelTokens('claude-3-7-sonnet');
    expect(t?.family).toBe('claude');
    expect(t?.versionMajor).toBe('3');
    expect(t?.versionMinor).toBe('7');
    expect(t?.variant).toBe('sonnet');
  });

  it('returns null for unknown shape', () => {
    expect(parseLogicalModelTokens('xyz/random-thing')).toBeNull();
  });
});

describe('01C.1B-J1F §12.1 — learner matching guards', () => {
  const logical = 'anthropic-claude-3.7-sonnet';

  it('SELECTS exact same family+version+variant from same provider', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'phala', id: 'anthropic/claude-3.7-sonnet', name: 'anthropic/claude-3.7-sonnet' },
    ];
    const r = learnAliasForProvider({ providerId: 'phala', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected?.apiModelId).toBe('anthropic/claude-3.7-sonnet');
  });

  it('REJECTS opus when logical is sonnet (cross-variant guard)', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'p', id: 'anthropic/claude-3.7-opus', name: 'claude-3.7-opus' },
    ];
    const r = learnAliasForProvider({ providerId: 'p', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected).toBeUndefined();
    expect(r.unresolvedReason).toBeDefined();
  });

  it('REJECTS haiku when logical is sonnet', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'p', id: 'anthropic/claude-3.7-haiku', name: 'claude-3.7-haiku' },
    ];
    const r = learnAliasForProvider({ providerId: 'p', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected).toBeUndefined();
  });

  it('REJECTS claude-4 when logical is claude-3 (cross-generation guard)', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'p', id: 'anthropic/claude-4.5-sonnet', name: 'claude-4.5-sonnet' },
    ];
    const r = learnAliasForProvider({ providerId: 'p', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected).toBeUndefined();
  });

  it('REJECTS claude-3.5 when logical is claude-3.7 (different patch version)', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'p', id: 'anthropic/claude-3.5-sonnet', name: 'claude-3.5-sonnet' },
    ];
    const r = learnAliasForProvider({ providerId: 'p', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected).toBeUndefined();
  });

  it('PREFERS -latest over date-pinned in tie-break', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'orqai', id: 'anthropic/claude-3-7-sonnet-20250219', name: 'anthropic/claude-3-7-sonnet-20250219' },
      { providerId: 'orqai', id: 'anthropic/claude-3-7-sonnet-latest', name: 'anthropic/claude-3-7-sonnet-latest' },
    ];
    const r = learnAliasForProvider({ providerId: 'orqai', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected?.apiModelId).toBe('anthropic/claude-3-7-sonnet-latest');
  });

  it('PREFERS non-regional over regional', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'requesty', id: 'bedrock/claude-3-7-sonnet@us-east-1', name: 'bedrock/claude-3-7-sonnet@us-east-1' },
      { providerId: 'requesty', id: 'bedrock/claude-3-7-sonnet', name: 'bedrock/claude-3-7-sonnet' },
    ];
    const r = learnAliasForProvider({ providerId: 'requesty', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected?.apiModelId).toBe('bedrock/claude-3-7-sonnet');
  });

  it('unresolvedReason explicit when no candidate passes guards', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'p', id: 'gpt-4o', name: 'gpt-4o' }, // wrong family
    ];
    const r = learnAliasForProvider({ providerId: 'p', logicalModelId: logical, discoveredRows: rows });
    expect(r.unresolvedReason).toBe('no_catalog_row_matches_family_version_variant');
  });

  it('filters by providerId (no cross-provider leakage)', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'X', id: 'anthropic/claude-3.7-sonnet', name: 'X' },
    ];
    const r = learnAliasForProvider({ providerId: 'Y', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected).toBeUndefined();
  });

  it('NEVER returns the bad anthropic/anthropic-claude-* form', () => {
    const rows: DiscoveredModelRow[] = [
      { providerId: 'p', id: 'anthropic/anthropic-claude-3.7-sonnet', name: 'anthropic/anthropic-claude-3.7-sonnet' },
      { providerId: 'p', id: 'anthropic/claude-3.7-sonnet', name: 'anthropic/claude-3.7-sonnet' },
    ];
    const r = learnAliasForProvider({ providerId: 'p', logicalModelId: logical, discoveredRows: rows });
    expect(r.selected?.apiModelId).toBe('anthropic/claude-3.7-sonnet');
  });
});
