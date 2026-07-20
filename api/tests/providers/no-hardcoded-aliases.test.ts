// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import fs from 'fs';
import path from 'path';

function readAdapterFiles(): Array<{ file: string; content: string }> {
  const providerDir = path.join(__dirname, '../../src/providers');
  const files = fs
    .readdirSync(providerDir, { recursive: true })
    .filter((file) => typeof file === 'string' && file.endsWith('-adapter.ts'))
    .map((file) => path.join(providerDir, file as string));

  return files
    .filter((file) => fs.existsSync(file))
    .map((file) => ({
      file,
      content: fs.readFileSync(file, 'utf8'),
    }));
}

describe('No Hardcoded Aliases - Provider Adapters', () => {
  it('should not contain legacy alias-map constants in provider adapters', () => {
    for (const { content } of readAdapterFiles()) {
      expect(content).not.toContain('MODEL_ALIASES');
      expect(content).not.toMatch(/const\s+aliases?\s*:\s*Record<\s*string\s*,\s*string\s*>\s*=/);
      expect(content).not.toMatch(/const\s+aliases?\s*=\s*\{/);
    }
  });

  it('should expose normalizeModelName contract in adapters', () => {
    for (const { content } of readAdapterFiles()) {
      expect(content).toMatch(/\bnormalizeModelName\s*\(/);
    }
  });

  it('should avoid explicit one-to-one alias maps near normalizeModelName', () => {
    const aliasMapPattern = /normalizeModelName[\s\S]{0,400}const\s+\w*aliases?\s*=\s*\{/;

    for (const { content } of readAdapterFiles()) {
      expect(content).not.toMatch(aliasMapPattern);
    }
  });
});
