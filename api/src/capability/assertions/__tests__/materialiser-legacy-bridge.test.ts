// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the HCRA→legacy capability bridge (2026-07-03).
 *
 * The collective's member-selection path reads the legacy `capabilities`
 * column; the single arm uses HCRA semantic search. This bridge mirrors the
 * canonical projection into the legacy column so the collective composes
 * members from provenance-backed capabilities — WITHOUT ever emptying a
 * model's legacy capabilities (the April pool-collapse failure mode).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  projectLegacyCapabilities,
  writeProjectionForTest,
  LEGACY_PROJECTION_FLOOR,
  type MaterialiseStats,
} from '../materialiser';
import { legacyToUri } from '@/capability/legacy-capability-uri';

const uri = (slug: string) => legacyToUri(slug as never);
const emptyStats = (): MaterialiseStats => ({
  modelsWritten: 0,
  modelsCleared: 0,
  capabilitiesEmitted: 0,
  capabilitiesSuppressed: 0,
  elapsedMs: 0,
});

/** Records every query so tests can assert which UPDATE variant ran. */
function recordingPool(): { pool: Pool; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

afterEach(() => {
  delete process.env.HCRA_LEGACY_PROJECTION_DISABLED;
  delete process.env.HCRA_LEGACY_PROJECTION_FLOOR;
});

describe('projectLegacyCapabilities', () => {
  it('mirrors kept URIs at/above the floor as deduped legacy slugs', () => {
    const out = projectLegacyCapabilities([
      { uri: uri('chat'), confidence: 0.9 },
      { uri: uri('vision'), confidence: 0.8 },
      { uri: uri('function_calling'), confidence: 0.4 },
    ]);
    expect(out).toEqual(['chat', 'vision', 'function_calling']);
  });

  it('drops URIs below LEGACY_PROJECTION_FLOOR (regex-only noise)', () => {
    const out = projectLegacyCapabilities([
      { uri: uri('chat'), confidence: 0.9 },
      { uri: uri('vision'), confidence: LEGACY_PROJECTION_FLOOR - 0.01 },
    ]);
    expect(out).toEqual(['chat']);
  });

  it('dedupes and preserves confidence-desc order', () => {
    const out = projectLegacyCapabilities([
      { uri: uri('chat'), confidence: 0.9 },
      { uri: uri('chat'), confidence: 0.5 },
      { uri: uri('reasoning'), confidence: 0.7 },
    ]);
    expect(out).toEqual(['chat', 'reasoning']);
  });

  it('drops malformed URIs without throwing', () => {
    const out = projectLegacyCapabilities([
      { uri: 'not-a-cap-uri', confidence: 0.9 },
      { uri: uri('chat'), confidence: 0.9 },
    ]);
    expect(out).toEqual(['chat']);
  });
});

describe('writeProjection — legacy bridge behaviour', () => {
  it('writes the legacy capabilities column when a strong projection exists', async () => {
    const { pool, calls } = recordingPool();
    await writeProjectionForTest(
      pool,
      'model-1',
      [
        { uri: uri('chat'), confidence: 0.9, sources: ['provider-declared'] },
        { uri: uri('vision'), confidence: 0.8, sources: ['modality-derived'] },
      ],
      emptyStats(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('capabilities = $4::jsonb');
    // $4 is the legacy JSON payload.
    expect(JSON.parse(calls[0].values[3] as string)).toEqual(['chat', 'vision']);
  });

  it('does NOT touch the legacy column when kept is empty (no pool eviction)', async () => {
    const { pool, calls } = recordingPool();
    const stats = emptyStats();
    await writeProjectionForTest(pool, 'model-2', [], stats);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toContain('capabilities =');
    expect(calls[0].text).toContain("capability_uris = ARRAY[]::text[]");
    expect(stats.modelsCleared).toBe(1);
  });

  it('does NOT touch the legacy column when all signals are below the floor', async () => {
    const { pool, calls } = recordingPool();
    // Kept (>= INCLUSION_THRESHOLD 0.03) but all below LEGACY_PROJECTION_FLOOR:
    // regex-only noise must not blank a model's legacy capabilities.
    await writeProjectionForTest(
      pool,
      'model-3',
      [{ uri: uri('chat'), confidence: 0.05, sources: ['name-regex'] }],
      emptyStats(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toContain('capabilities =');
    // HCRA columns still updated (weak signal preserved as a URI hint).
    expect(calls[0].text).toContain('capability_uris = $1::text[]');
  });

  it('respects HCRA_LEGACY_PROJECTION_DISABLED=true (URI cols only)', async () => {
    process.env.HCRA_LEGACY_PROJECTION_DISABLED = 'true';
    const { pool, calls } = recordingPool();
    await writeProjectionForTest(
      pool,
      'model-4',
      [{ uri: uri('chat'), confidence: 0.9, sources: ['provider-declared'] }],
      emptyStats(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toContain('capabilities =');
  });
});
