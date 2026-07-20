// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Guardrail tests for the `error_class` Prometheus label cardinality budget.
 *
 * Two invariants:
 *   1. `normalizeErrorClass` clamps any string not in the enum to `'other'`.
 *      Unit-testable — forms the runtime defence.
 *   2. Every literal `errorClass: '...'` emitted by adapter source code MUST
 *      already be in the enum (or in the known-dynamic helpers). Static scan
 *      over the broadcast source. This is the build-time defence that keeps
 *      dashboards honest: a new adapter adding a new errorClass without
 *      touching the enum fails this test.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  ERROR_CLASS_ENUM,
  knownErrorClasses,
  normalizeErrorClass,
} from '../error-class-enum';

describe('normalizeErrorClass', () => {
  it('passes known enum members through unchanged', () => {
    for (const v of ERROR_CLASS_ENUM) {
      expect(normalizeErrorClass(v)).toBe(v);
    }
  });

  it('clamps unknown strings to "other"', () => {
    expect(normalizeErrorClass('http_418')).toBe('other');
    expect(normalizeErrorClass('some_new_thing')).toBe('other');
    expect(normalizeErrorClass('completely random 💥')).toBe('other');
  });

  it('returns "none" for null/undefined/empty', () => {
    expect(normalizeErrorClass(null)).toBe('none');
    expect(normalizeErrorClass(undefined)).toBe('none');
    expect(normalizeErrorClass('')).toBe('none');
  });
});

describe('cardinality guardrail — static scan of broadcast/**', () => {
  // ---- Discover every .ts file under src/broadcast (minus tests) ----
  const BROADCAST_ROOT = join(process.cwd(), 'src', 'broadcast');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (ent === '__tests__' || ent === 'node_modules') continue;
        out.push(...walk(full));
      } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  // Skip this file itself + the enum module (which legitimately lists every
  // class as a literal).
  const SELF_EXCLUDES = new Set([
    join(BROADCAST_ROOT, 'infrastructure', 'metrics', 'error-class-enum.ts'),
  ]);

  it('every literal `errorClass: "..."` in broadcast source is in the enum', () => {
    const known = knownErrorClasses();
    const violators: Array<{ file: string; literal: string }> = [];

    for (const file of walk(BROADCAST_ROOT)) {
      if (SELF_EXCLUDES.has(file)) continue;
      const src = readFileSync(file, 'utf8');
      // Match: errorClass: 'xxx'   OR   errorClass: "xxx"
      const re = /errorClass:\s*['"]([^'"\n]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const literal = m[1]!;
        if (!known.has(literal)) {
          violators.push({ file: file.replace(process.cwd(), ''), literal });
        }
      }
    }

    if (violators.length > 0) {
      const report = violators
        .map((v) => `  ${v.file}: "${v.literal}"`)
        .join('\n');
      throw new Error(
        `Unbounded errorClass literals found — add them to ERROR_CLASS_ENUM or pick an existing bucket:\n${report}`,
      );
    }
    expect(violators).toHaveLength(0);
  });

  it('no adapter `errorClassForStatus` returns a dynamic template literal', () => {
    // Template-literal fallbacks like `http_${status}` are the classic
    // cardinality-explosion source. Adapters MUST land unknown statuses on
    // a bounded label (http_other, etc).
    const adaptersDir = join(BROADCAST_ROOT, 'infrastructure', 'destinations');
    const offenders: string[] = [];
    for (const ent of readdirSync(adaptersDir)) {
      if (!ent.endsWith('.ts') || ent.endsWith('.test.ts')) continue;
      const src = readFileSync(join(adaptersDir, ent), 'utf8');
      // Look for `return \`http_${...}\`;` patterns
      if (/return\s+`[^`]*\$\{[^}]+\}[^`]*`\s*;/.test(src)) {
        // Narrow — only flag if the template is in errorClassForStatus
        const fn = /errorClassForStatus\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/.exec(src);
        if (fn && /`[^`]*\$\{[^}]+\}[^`]*`/.test(fn[1]!)) {
          offenders.push(ent);
        }
      }
    }
    expect(offenders, `Adapter(s) return a dynamic errorClass literal: ${offenders.join(', ')}`).toHaveLength(0);
  });
});
