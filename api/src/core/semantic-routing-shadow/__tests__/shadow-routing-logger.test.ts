// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-logger.test.ts — MVP 8C.0
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryShadowLogger,
  noopShadowLogger,
  SHADOW_DECISION_EVENT,
} from '../shadow-routing-logger';

describe('SHADOW_DECISION_EVENT', () => {
  it('uses the canonical event name', () => {
    expect(SHADOW_DECISION_EVENT).toBe('semantic_routing_shadow_decision');
  });
});

describe('noopShadowLogger', () => {
  it('does not throw on log()', () => {
    expect(() => noopShadowLogger.log('event', { foo: 'bar' })).not.toThrow();
  });
});

describe('InMemoryShadowLogger', () => {
  it('captures events', () => {
    const logger = new InMemoryShadowLogger();
    logger.log(SHADOW_DECISION_EVENT, { requestId: 'r1', shadowExecuted: true });
    logger.log(SHADOW_DECISION_EVENT, { requestId: 'r2', shadowExecuted: false });
    expect(logger.size()).toBe(2);
    const snapshot = logger.snapshot();
    expect(snapshot[0].event).toBe(SHADOW_DECISION_EVENT);
    expect((snapshot[0].payload as { requestId: string }).requestId).toBe('r1');
  });

  it('redacts forbidden keys at the LOGGER level (defence in depth)', () => {
    const logger = new InMemoryShadowLogger();
    logger.log(SHADOW_DECISION_EVENT, {
      requestId: 'r1',
      prompt: 'SECRET-PROMPT',
      messages: ['SECRET-MSG'],
      rawContext: 'SECRET-CTX',
    });
    const snapshot = logger.snapshot();
    const json = JSON.stringify(snapshot[0].payload);
    expect(json).not.toContain('SECRET-PROMPT');
    expect(json).not.toContain('SECRET-MSG');
    expect(json).not.toContain('SECRET-CTX');
    expect(json).not.toContain('"prompt"');
    expect(json).not.toContain('"messages"');
    expect(json).not.toContain('"rawContext"');
  });

  it('reset() clears captured events', () => {
    const logger = new InMemoryShadowLogger();
    logger.log('e', { a: 1 });
    logger.log('e', { b: 2 });
    expect(logger.size()).toBe(2);
    logger.reset();
    expect(logger.size()).toBe(0);
  });
});
