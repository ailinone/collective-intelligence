// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ProviderId, ModelRecord } from '@/types/model-client';
import type { ProviderAdapter } from './provider-adapter';
import type { UniversalModelClient } from './universal-model-client';

const providers = new Map<ProviderId, ProviderAdapter>();

/**
 * Registra um adapter para um provedor
 */
export function registerProviderAdapter(id: ProviderId, adapter: ProviderAdapter) {
  providers.set(id, adapter);
}

/**
 * Obtém o adapter de um provedor
 */
export function getProviderAdapter(id: ProviderId): ProviderAdapter {
  const adapter = providers.get(id);
  if (!adapter) {
    throw new Error(`No provider adapter registered for '${id}'`);
  }
  return adapter;
}

/**
 * Cria um cliente universal para um modelo
 * Este é o ponto de entrada principal para usar qualquer modelo
 */
export function createUniversalClient(model: ModelRecord): UniversalModelClient {
  const adapter = getProviderAdapter(model.provider);

  return {
    model,

    text: (req) => adapter.text(model, req),
    streamText: (req) => adapter.streamText(model, req),
    toolChat: (req) => adapter.toolChat(model, req),
    structuredJson: (req) => adapter.structuredJson(model, req),
    embeddings: (req) => adapter.embeddings(model, req),
    vision: (req) => adapter.vision(model, req),
    imageGenerate: (req) => adapter.imageGenerate(model, req),
    textToSpeech: (req) => adapter.textToSpeech(model, req),
    speechToText: (req) => adapter.speechToText(model, req),
    rawInvoke: (op, payload) => adapter.rawInvoke(model, op, payload),
  };
}

/**
 * Lista todos os provedores registrados
 */
export function getRegisteredProviders(): ProviderId[] {
  return Array.from(providers.keys());
}

/**
 * Verifica se um provedor está registrado
 */
export function hasProviderAdapter(id: ProviderId): boolean {
  return providers.has(id);
}
