// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { logger } from '../logger';

// Reads the serializers configured on the shared logger instead of piping
// output, so the test is independent of pino-pretty / transports.
const serializers = (logger as unknown as Record<symbol, Record<string, (v: unknown) => unknown>>)[
  Symbol.for('pino.serializers')
];

describe('logger serializers', () => {
  it('serializes an Error logged under `error` (previously printed as {})', () => {
    const out = serializers.error(new Error('boom')) as Record<string, unknown>;
    expect(out.message).toBe('boom');
    expect(typeof out.stack).toBe('string');
  });

  it('leaves non-Error values logged under `error` untouched', () => {
    expect(serializers.error('timeout')).toBe('timeout');
    const obj = { code: 'E_X', detail: 1 };
    expect(serializers.error(obj)).toBe(obj);
  });

  it('keeps the `err` serializer behaviour for Errors', () => {
    const out = serializers.err(new Error('boom')) as Record<string, unknown>;
    expect(out.message).toBe('boom');
  });

  it('is wired into pino so `{ error }` is not emitted as {}', () => {
    const lines: string[] = [];
    const l = pino(
      { serializers: { error: serializers.error } },
      { write: (m: string) => void lines.push(m) }
    );
    l.error({ error: new Error('visible') }, 'x');
    expect(JSON.parse(lines[0]).error.message).toBe('visible');
  });
});
