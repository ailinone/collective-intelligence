// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring + behavior contract — FC-pool recovery (2026-08-21).
 *
 * The tools-request pool collapsed to a handful of mostly-dead models
 * because EVERY layer hard-filtered on DECLARED function_calling. The
 * recovery relaxes the POOL layers and moves verification to the
 * execution-time lazy probe:
 *   - pool-builder: function_calling is deferred (never dropped at pool level)
 *   - base-strategy: pool is health-ranked, declared-FC first
 *   - quality-multipass: primary sort is runtime-health aware
 *   - orchestration-engine: unknown/non-declared FC → cached probe gate
 *   - dynamic-model-selector: FC deferred + never-empty failsafe
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PoolBuilder } from '@/core/pool/pool-builder';
import type { Model } from '@/types';

const ORCH = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ORCH, rel), 'utf8');

const chatModel = (id: string, provider: string, caps: string[]): Model =>
  ({
    id,
    provider,
    name: id,
    capabilities: caps,
    performance: { quality: 0.9 },
  }) as unknown as Model;

describe('pool-builder FC deferral', () => {
  it('function_calling is NOT hard-dropped from the pool', () => {
    const pool = new PoolBuilder([
      chatModel('with-fc', 'prov-a', ['chat', 'function_calling']),
      chatModel('without-fc', 'prov-b', ['chat']),
    ])
      .filterByModality()
      .filterByCapabilities(['function_calling'])
      .build().models;
    const ids = pool.map((m) => m.id).sort();
    expect(ids).toEqual(['with-fc', 'without-fc']);
  });

  it('non-FC required capabilities still hard-filter', () => {
    const pool = new PoolBuilder([
      chatModel('has-chat', 'prov-a', ['chat']),
      chatModel('has-vision', 'prov-b', ['chat', 'vision']),
    ])
      .filterByModality()
      .filterByCapabilities(['vision'])
      .build().models;
    expect(pool.map((m) => m.id)).toEqual(['has-vision']);
  });
});

describe('FC-pool recovery wiring', () => {
  it('orchestration-engine gates unknown FC through the cached probe', () => {
    const engine = read('orchestration-engine.ts');
    expect(engine).toMatch(/getFunctionCallingVerdict\(/);
    expect(engine).toMatch(/FC probe: model rejected the tools request shape/);
    // declared veto (inconclusive probe) preserved
    expect(engine).toMatch(/lacks declared function_calling and probe was inconclusive/);
  });

  it('base-strategy health-ranks the eligible pool', () => {
    const base = read('base-strategy.ts');
    expect(base).toMatch(/rankByRuntimeHealth\(/);
  });

  it('quality-multipass primary sort is runtime-health aware', () => {
    const qmp = read(join('strategies', 'quality-multipass-strategy.ts'));
    expect(qmp).toMatch(/runtimeHealthRank\(m\.provider, m\.id\)/);
  });

  it('dynamic-model-selector defers function_calling with never-empty failsafe', () => {
    const sel = read(join('..', 'selection', 'dynamic-model-selector.ts'));
    expect(sel).toMatch(/function_calling.*DEFERRED|DEFERRED.*function_calling/s);
    expect(sel).toMatch(
      /FAILSAFE: required-capability filter would empty the pool — keeping unfiltered pool/
    );
  });
});
