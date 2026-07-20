// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it } from 'vitest';
import { loadSecret } from '@/config/secrets-loader';

const envVarsToReset = [
  'NVIDIA_API_KEY',
  'AIHUBMIX_API_KEY',
  'NOVITA_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'JINA_API_KEY',
  'FRIENDLI_API_KEY',
  'AIML_API_KEY',
  'IMAGEROUTER_API_KEY',
  'ORQAI_API_KEY',
  'EDENAI_API_KEY',
  'HELICONEAI_API_KEY',
] as const;

describe('secrets-loader alias resolution', () => {
  afterEach(() => {
    for (const envVar of envVarsToReset) {
      delete process.env[envVar];
    }
  });

  it('resolves API key from env using primary api-key naming', async () => {
    process.env.ORQAI_API_KEY = 'orq-secret';
    await expect(loadSecret('orqai-api-key')).resolves.toBe('orq-secret');
  });

  it('resolves API key from env using legacy key naming', async () => {
    process.env.EDENAI_API_KEY = 'eden-secret';
    await expect(loadSecret('edenai-key')).resolves.toBe('eden-secret');
  });

  it('supports reverse alias lookup for helicone keys', async () => {
    process.env.HELICONEAI_API_KEY = 'helicone-secret';
    await expect(loadSecret('heliconeai-api-key')).resolves.toBe('helicone-secret');
    await expect(loadSecret('heliconeai-key')).resolves.toBe('helicone-secret');
  });

  it('resolves aliases for newly added providers', async () => {
    process.env.NVIDIA_API_KEY = 'nvidia-secret';
    process.env.AIHUBMIX_API_KEY = 'aihubmix-secret';
    process.env.NOVITA_API_KEY = 'novita-secret';
    process.env.MOONSHOT_API_KEY = 'moonshot-secret';
    process.env.MINIMAX_API_KEY = 'minimax-secret';
    process.env.JINA_API_KEY = 'jina-secret';
    process.env.FRIENDLI_API_KEY = 'friendli-secret';
    process.env.AIML_API_KEY = 'aiml-secret';
    process.env.IMAGEROUTER_API_KEY = 'imagerouter-secret';

    await expect(loadSecret('nvidia-api-key')).resolves.toBe('nvidia-secret');
    await expect(loadSecret('nvidia-hub-api-key')).resolves.toBe('nvidia-secret');
    await expect(loadSecret('aihubmix-key')).resolves.toBe('aihubmix-secret');
    await expect(loadSecret('novita-api-key')).resolves.toBe('novita-secret');
    await expect(loadSecret('moonshot-key')).resolves.toBe('moonshot-secret');
    await expect(loadSecret('minimax-api-key')).resolves.toBe('minimax-secret');
    await expect(loadSecret('jina-key')).resolves.toBe('jina-secret');
    await expect(loadSecret('friendli-api-key')).resolves.toBe('friendli-secret');
    await expect(loadSecret('aiml-key')).resolves.toBe('aiml-secret');
    await expect(loadSecret('imagerouter-api-key')).resolves.toBe('imagerouter-secret');
  });

  it('throws informative error for required secret when all aliases are missing', async () => {
    await expect(loadSecret('orqai-api-key', true)).rejects.toThrow('tried aliases');
  });
});
