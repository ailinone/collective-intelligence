// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Cloud-agnostic KEK surface — the only symbols the rest of the app should
// import. New backends (aws-kms, azure-keyvault) will be added to
// `KekProviderConfig`; the factory dispatch in `resolveKekProviderFromConfig`
// keeps the choice explicit and exhaustively typed.
export {
  type KekProvider,
  type KekProviderConfig,
  type KekBackend,
  KEK_BACKENDS,
  LocalKekProvider,
  GcpKmsKekProvider,
  resolveKekProvider,
  resolveKekProviderFromConfig,
  parseKekConfigFromEnv,
} from './kek-provider';
export {
  type EncryptedBlob,
  type TenantRef,
  type DestinationConfigCipherOptions,
  DestinationConfigCipher,
  AAD_VERSION,
  buildAad,
} from './destination-config-cipher';
