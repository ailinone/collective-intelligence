// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-logger.ts — MVP 8C.0
 *
 * Thin logger adapter. The service emits structured log events under
 * a single event name (`semantic_routing_shadow_decision`) — production
 * wires its own logger; tests use the InMemoryShadowLogger to assert.
 *
 * Every field passed through is run through `redactPayload` before
 * it reaches the logger. This is the LAST line of defence: even if a
 * caller accidentally passes a forbidden key, the logger won't emit it.
 */

import { redactPayload } from './shadow-routing-redaction';

export const SHADOW_DECISION_EVENT = 'semantic_routing_shadow_decision';

export interface ShadowRoutingLogger {
  log(event: string, payload: Record<string, unknown>): void;
}

export const noopShadowLogger: ShadowRoutingLogger = Object.freeze({
  log(): void {
    // no-op
  },
});

/**
 * In-memory logger — captures emitted (event, payload) pairs.
 * Used in tests to assert what would be logged.
 */
export class InMemoryShadowLogger implements ShadowRoutingLogger {
  private readonly events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  log(event: string, payload: Record<string, unknown>): void {
    // Defence in depth — redact again here even if caller already did.
    const safe = redactPayload(payload) as Record<string, unknown>;
    this.events.push({ event, payload: safe });
  }

  snapshot(): readonly { readonly event: string; readonly payload: Record<string, unknown> }[] {
    return this.events.slice();
  }

  reset(): void {
    this.events.length = 0;
  }

  size(): number {
    return this.events.length;
  }
}
