// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { SecretsProviderType } from '@/types';

export interface SecretsProvider {
  readonly id: string;
  readonly type: SecretsProviderType;
  readonly priority: number;
  readonly failOpen: boolean;

  initialize(): Promise<void>;
  getSecret(key: string): Promise<string>;
  getSecrets(keys: string[]): Promise<Record<string, string>>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  listSecrets(): Promise<string[]>;
  healthCheck(): Promise<boolean>;
  rotateSecret?(key: string, value: string): Promise<void>;
  disconnect(): Promise<void>;
}
