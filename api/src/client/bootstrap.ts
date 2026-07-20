// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Inicialização do sistema Universal Model Client
 * Registra todos os adapters de provedor disponíveis
 */

import { registerProviderAdapter } from './provider-registry';
import { OpenAIProviderAdapter } from './adapters/openai-adapter';
import { GenericHTTPProviderAdapter } from './adapters/generic-http-adapter';

/**
 * Inicializa o registry de adapters
 * Deve ser chamado na inicialização da aplicação
 */
export function initializeUniversalClient() {
  // Registrar adapter OpenAI
  registerProviderAdapter('openai', OpenAIProviderAdapter);

  // Registrar adapter genérico HTTP para hubs/routers
  registerProviderAdapter('custom_http', GenericHTTPProviderAdapter);

  // Adapters adicionais podem ser registrados aqui assim que estiverem disponíveis:
  // registerProviderAdapter('anthropic', AnthropicProviderAdapter);
  // registerProviderAdapter('google', GoogleProviderAdapter);
  // registerProviderAdapter('mistral', MistralProviderAdapter);
  // registerProviderAdapter('deepinfra', GenericHTTPProviderAdapter); // usando custom_http
  // registerProviderAdapter('openrouter', GenericHTTPProviderAdapter); // usando custom_http
}
