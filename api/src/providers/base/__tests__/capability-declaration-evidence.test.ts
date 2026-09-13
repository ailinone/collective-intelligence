// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Evidence guard for the two DECLARED provider capabilities.
 *
 * `ProviderAdapter.getDiarizationSupport()` and
 * `ProviderAdapter.getRealtimeTransport()` are how an adapter claims that its
 * upstream really performs speaker diarization / really speaks a realtime
 * WebSocket protocol. Those claims gate fail-closed behaviour: the audio
 * orchestrator refuses to transcribe with a non-declaring provider when
 * diarization is asked for, and `/v1/realtime?transport=provider` refuses to
 * downgrade to the composite pipeline.
 *
 * A claim without a vendor-documentation URL is exactly the "fabricated
 * coverage" this whole workstream exists to prevent, so the pairing is
 * enforced mechanically here: source is scanned rather than adapters
 * instantiated, because instantiating all ~40 first-party adapters would
 * require every provider's credential shape.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_ROOT = join(__dirname, '..', '..');
const BASE_ADAPTER = join(PROVIDERS_ROOT, 'base', 'provider-adapter.ts');

function collectAdapterSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      collectAdapterSources(full, out);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Return the body of every `<method>()` implementation in `source`, matched by
 * brace balance so a nested object literal does not truncate the body.
 */
function methodBodies(source: string, method: string): string[] {
  const bodies: string[] = [];
  const pattern = new RegExp(`${method}\\s*\\(\\s*\\)\\s*:[^{]*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      index += 1;
    }
    bodies.push(source.slice(start, index - 1));
  }
  return bodies;
}

const ADAPTER_SOURCES = collectAdapterSources(PROVIDERS_ROOT).filter(
  (path) => path !== BASE_ADAPTER
);

describe('declared capability evidence', () => {
  it('scans a non-trivial set of provider sources', () => {
    // Guards the guard: a broken path glob would make every assertion vacuous.
    expect(ADAPTER_SOURCES.length).toBeGreaterThan(30);
  });

  it('every native diarization claim carries a vendor documentation URL', () => {
    const violations: string[] = [];

    for (const path of ADAPTER_SOURCES) {
      const source = readFileSync(path, 'utf8');
      for (const body of methodBodies(source, 'getDiarizationSupport')) {
        if (!/native:\s*true/.test(body)) continue;
        if (!/evidenceUrl:\s*'https:\/\//.test(body)) {
          violations.push(path);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('every realtime transport claim carries a vendor documentation URL', () => {
    const violations: string[] = [];

    for (const path of ADAPTER_SOURCES) {
      const source = readFileSync(path, 'utf8');
      for (const body of methodBodies(source, 'getRealtimeTransport')) {
        if (/kind:\s*null/.test(body)) continue;
        if (!/evidenceUrl:\s*'https:\/\//.test(body)) {
          violations.push(path);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('the base class denies both capabilities by default', () => {
    const source = readFileSync(BASE_ADAPTER, 'utf8');

    const diarization = methodBodies(source, 'getDiarizationSupport');
    expect(diarization).toHaveLength(1);
    expect(diarization[0]).toMatch(/native:\s*false/);

    const realtime = methodBodies(source, 'getRealtimeTransport');
    expect(realtime).toHaveLength(1);
    expect(realtime[0]).toMatch(/kind:\s*null/);
  });

  it('at least one adapter declares each capability, so the gates are reachable', () => {
    let diarizing = 0;
    let realtimeCapable = 0;

    for (const path of ADAPTER_SOURCES) {
      const source = readFileSync(path, 'utf8');
      if (methodBodies(source, 'getDiarizationSupport').some((b) => /native:\s*true/.test(b))) {
        diarizing += 1;
      }
      if (methodBodies(source, 'getRealtimeTransport').some((b) => !/kind:\s*null/.test(b))) {
        realtimeCapable += 1;
      }
    }

    // A zero here would mean the fail-closed paths can never succeed — the
    // capability would be permanently unavailable rather than gated.
    expect(diarizing).toBeGreaterThanOrEqual(1);
    expect(realtimeCapable).toBeGreaterThanOrEqual(2);
  });
});
