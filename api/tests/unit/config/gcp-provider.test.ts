// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GcpSecretsProviderConfig } from '@/types';
import { GcpSecretsProvider } from '@/config/providers/gcp-provider';

const mocks = vi.hoisted(() => ({
  listSecretsMock: vi.fn(),
  closeMock: vi.fn(),
  clientCtorMock: vi.fn(),
}));

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: mocks.clientCtorMock,
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function buildConfig(
  optionsOverride: Partial<GcpSecretsProviderConfig['options']> = {}
): GcpSecretsProviderConfig {
  return {
    id: 'gcp-test',
    type: 'gcp',
    priority: 1,
    failOpen: false,
    options: {
      projectId: 'test-project',
      secretPrefix: 'test',
      ...optionsOverride,
    },
  };
}

describe('GcpSecretsProvider', () => {
  const envSnapshot = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!envSnapshot.has(key)) {
      envSnapshot.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  }

  beforeEach(() => {
    mocks.listSecretsMock.mockResolvedValue([[]]);
    mocks.closeMock.mockResolvedValue(undefined);
    mocks.clientCtorMock.mockImplementation(() => ({
      listSecrets: mocks.listSecretsMock,
      close: mocks.closeMock,
    }));
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [key, value] of envSnapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    envSnapshot.clear();
    vi.restoreAllMocks();
  });

  it('updates NO_PROXY for google domains and strips loopback proxy vars', async () => {
    setEnv('SECRETS_PROVIDER_PRIMARY', 'gcp');
    setEnv('NO_PROXY', 'internal.local');
    setEnv('HTTPS_PROXY', 'http://127.0.0.1:9');

    const provider = new GcpSecretsProvider(buildConfig());
    await provider.initialize();

    expect(process.env.NO_PROXY).toContain('internal.local');
    expect(process.env.NO_PROXY).toContain('.googleapis.com');
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(mocks.listSecretsMock).toHaveBeenCalled();
  });

  it('fails in production when credentials are authorized_user', async () => {
    setEnv('NODE_ENV', 'production');

    const provider = new GcpSecretsProvider(
      buildConfig({
        credentialsJson: JSON.stringify({
          type: 'authorized_user',
          client_id: 'client-id',
          client_secret: 'client-secret',
          refresh_token: 'refresh-token',
        }),
      })
    );

    await expect(provider.initialize()).rejects.toThrow(
      /credential type "authorized_user".*not allowed/i
    );
  });

  it('allows authorized_user credentials when explicit override is enabled', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('SECRETS_GCP_ALLOW_AUTHORIZED_USER', 'true');

    const provider = new GcpSecretsProvider(
      buildConfig({
        credentialsJson: JSON.stringify({
          type: 'authorized_user',
          client_id: 'client-id',
          client_secret: 'client-secret',
          refresh_token: 'refresh-token',
        }),
      })
    );

    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(mocks.listSecretsMock).toHaveBeenCalled();
  });
});
