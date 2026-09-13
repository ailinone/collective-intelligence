// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression suite for SILENT provider/model substitution.
 *
 * Measured live: a circuit breaker opening for a whole provider made traffic
 * fall through to a different provider, and the response reported
 * `degraded: false` with nothing anywhere saying so — a caller that asked for
 * one vendor received another with no way to tell.
 *
 * `degraded` itself was not lying about its own meaning ("the [DEGRADED]
 * placeholder was returned, no provider succeeded"), and it is deliberately not
 * overloaded here: two readers key off exactly that meaning, and a response
 * served by a substitute IS a real answer. What was missing is that the
 * substitution had no field at all, in a response that also carried no
 * provider — `ModelExecution` did not record one, so it could not reach
 * metadata assembly even in principle.
 */
import { describe, expect, it } from 'vitest';
import { detectModelSubstitution, mapSubcallEntries } from '@/services/chat-request-processor';
import type { ChatRequest } from '@/types';

const request = (model?: string): ChatRequest =>
  ({
    messages: [{ role: 'user', content: 'hi' }],
    ...(model === undefined ? {} : { model }),
  }) as ChatRequest;

const execution = (overrides: {
  modelId: string;
  modelName?: string;
  provider?: string;
  success?: boolean;
}) => ({
  modelName: overrides.modelId,
  ...overrides,
});

describe('model substitution visibility', () => {
  describe('detectModelSubstitution', () => {
    it('flags the measured case: pinned one vendor, another answered', () => {
      const signal = detectModelSubstitution({
        request: request('anthropic/claude-sonnet-4'),
        resolvedModel: 'mistral/mistral-large',
        modelsUsed: [execution({ modelId: 'mistral/mistral-large', provider: 'mistral' })],
      });

      expect(signal.substituted).toBe(true);
      expect(signal.requestedModel).toBe('anthropic/claude-sonnet-4');
      expect(signal.servedProvider).toBe('mistral');
    });

    it('does not flag a pin that was honoured', () => {
      const signal = detectModelSubstitution({
        request: request('anthropic/claude-sonnet-4'),
        resolvedModel: 'anthropic/claude-sonnet-4',
        modelsUsed: [execution({ modelId: 'anthropic/claude-sonnet-4', provider: 'anthropic' })],
      });

      expect(signal.substituted).toBe(false);
      expect(signal.servedProvider).toBe('anthropic');
    });

    it('accepts the pin matching an execution by NAME as well as by id', () => {
      // Downstream resolvers match `m.name === request.model || m.id === …`;
      // the detector must not report a substitution the resolver did not make.
      const signal = detectModelSubstitution({
        request: request('Claude Sonnet 4'),
        resolvedModel: undefined,
        modelsUsed: [
          {
            modelId: 'anthropic/claude-sonnet-4',
            modelName: 'Claude Sonnet 4',
            provider: 'anthropic',
          },
        ],
      });

      expect(signal.substituted).toBe(false);
    });

    it('never flags a request that pinned nothing', () => {
      for (const model of [undefined, 'auto', 'ailin-economy']) {
        const signal = detectModelSubstitution({
          request: request(model),
          resolvedModel: 'some/other-model',
          modelsUsed: [execution({ modelId: 'some/other-model', provider: 'someprovider' })],
        });

        expect(signal.substituted).toBe(false);
        expect(signal.requestedModel).toBeNull();
      }
    });

    it('reports the provider of the last SUCCESSFUL execution, not a failed attempt', () => {
      // The interesting case is exactly a failed attempt on the pinned
      // provider followed by a success elsewhere — a circuit-breaker fallover.
      const signal = detectModelSubstitution({
        request: request('anthropic/claude-sonnet-4'),
        resolvedModel: 'mistral/mistral-large',
        modelsUsed: [
          execution({
            modelId: 'anthropic/claude-sonnet-4',
            provider: 'anthropic',
            success: false,
          }),
          execution({ modelId: 'mistral/mistral-large', provider: 'mistral', success: true }),
        ],
      });

      expect(signal.substituted).toBe(true);
      expect(signal.servedProvider).toBe('mistral');
    });

    it('still flags a pin that resolved to nothing at all', () => {
      const signal = detectModelSubstitution({
        request: request('vendor/pinned-model'),
        resolvedModel: undefined,
        modelsUsed: [],
      });

      expect(signal.substituted).toBe(true);
      expect(signal.servedProvider).toBeNull();
    });

    it('tolerates executions that recorded no provider', () => {
      const signal = detectModelSubstitution({
        request: request('vendor/pinned-model'),
        resolvedModel: 'vendor/other-model',
        modelsUsed: [execution({ modelId: 'vendor/other-model' })],
      });

      expect(signal.substituted).toBe(true);
      expect(signal.servedProvider).toBeNull();
    });
  });

  describe('subcall provider attribution', () => {
    it('carries the serving provider per subcall', () => {
      const entries = mapSubcallEntries(
        [
          {
            modelId: 'anthropic/claude-sonnet-4',
            modelName: 'claude',
            provider: 'anthropic',
            role: 'primary',
            cost: 0.01,
            durationMs: 120,
            success: false,
          },
          {
            modelId: 'mistral/mistral-large',
            modelName: 'mistral',
            provider: 'mistral',
            role: 'primary',
            cost: 0.02,
            durationMs: 300,
            success: true,
          },
        ],
        false
      );

      expect(entries.map((e) => e.provider)).toEqual(['anthropic', 'mistral']);
    });

    it('reports null rather than guessing when no provider was recorded', () => {
      const entries = mapSubcallEntries(
        [
          {
            modelId: 'vendor/model',
            modelName: 'model',
            role: 'primary',
            cost: 0,
            durationMs: 1,
            success: true,
          },
        ],
        false
      );

      expect(entries[0].provider).toBeNull();
    });
  });
});
