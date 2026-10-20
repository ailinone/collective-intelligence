// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const routesSource = readFileSync(
  join(__dirname, '..', '..', '..', 'routes', 'chat', 'chat-routes.ts'),
  'utf8'
);
const engineSource = readFileSync(join(__dirname, '..', 'orchestration-engine.ts'), 'utf8');

describe('streaming identity policy wiring', () => {
  it('short-circuits the direct-adapter fast path before streaming planning', () => {
    const identityGate = routesSource.indexOf('if (isAilinIdentityQuestion(lastUserTurn)) {');
    const streamingPlan = routesSource.indexOf('orchestrationEngine.createStreamingPlan(');

    expect(identityGate).toBeGreaterThan(-1);
    expect(streamingPlan).toBeGreaterThan(-1);
    expect(identityGate).toBeLessThan(streamingPlan);
    expect(routesSource.slice(identityGate, streamingPlan)).toContain('sendSSEDone(reply);');
    expect(routesSource.slice(identityGate, streamingPlan)).toContain('reply.raw.end();');
  });

  it('makes collective and Responses streaming cost-free for identity questions', () => {
    const streamStart = engineSource.indexOf('async *executeStream(');
    const identityGate = engineSource.indexOf(
      'if (isAilinIdentityQuestion(lastUserTurn)) {',
      streamStart
    );
    const firstContextBuild = engineSource.indexOf('this.buildContext(', streamStart);

    expect(streamStart).toBeGreaterThan(-1);
    expect(identityGate).toBeGreaterThan(streamStart);
    expect(firstContextBuild).toBeGreaterThan(identityGate);
    expect(engineSource.slice(identityGate, firstContextBuild)).toContain('return;');
    expect(engineSource.slice(identityGate, firstContextBuild)).toContain(
      'buildAilinIdentityResponse'
    );
  });
});
