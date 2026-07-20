// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * #1 prove-before-admit (2026-07-01): a 404 / model-not-found makes a ROUTE "dead"
 * (the model does not exist at that provider) — a PERMANENT condition, gated so the
 * selector stops re-picking it (the "404 dead-model not gated" cascade). Route-level
 * only: one dead model must NOT kill the whole provider. Self-heals on a real success.
 */
import { describe, it, expect } from 'vitest';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';

describe('operability hub — dead-route gating (404 prove-before-admit)', () => {
  it('marks a 404 model-not-found ROUTE as dead + unusable, but keeps the provider usable', () => {
    const hub = getProviderOperabilityHub();
    const provider = 'aihubmix'; // a hub provider → composite route keys form
    const deadModel = 'openai/gpt-4o-mini';
    hub.recordRouteExecution(provider, deadModel, false, 404, 'model_not_found: no such model');

    expect(hub.getRouteState(provider, deadModel).operabilityState).toBe('dead');
    expect(hub.isRouteUsable(provider, deadModel)).toBe(false);
    // one dead model must NOT gate the whole provider
    expect(hub.isProviderUsable(provider)).toBe(true);
  });

  it('classifies explicit model-not-found wording as dead even without a 404 status', () => {
    const hub = getProviderOperabilityHub();
    const provider = 'cometapi';
    const model = 'anthropic/claude-3-haiku';
    hub.recordRouteExecution(provider, model, false, 400, 'The model does not exist');
    expect(hub.getRouteState(provider, model).operabilityState).toBe('dead');
    expect(hub.isRouteUsable(provider, model)).toBe(false);
  });

  it('self-heals: a later success on the route makes it usable again', () => {
    const hub = getProviderOperabilityHub();
    const provider = 'openrouter';
    const model = 'meta-llama/llama-3.1-70b-instruct';
    hub.recordRouteExecution(provider, model, false, 404, 'model not found');
    expect(hub.isRouteUsable(provider, model)).toBe(false);
    hub.recordRouteExecution(provider, model, true, 200);
    expect(hub.isRouteUsable(provider, model)).toBe(true);
  });
});
