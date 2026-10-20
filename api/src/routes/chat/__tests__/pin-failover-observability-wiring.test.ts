// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#765 defect 1 — wiring guard: the single/fast streaming path
 * (chat-routes.ts candidate fallback chain) must flag every per-attempt
 * failure log with the explicit-model pin context.
 *
 * Prod evidence (2026-10-04, requestId n-y74gcR8b9UHlPOTTCOe): a pinned
 * `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` routed to
 * cloudflare-workers-ai died with no structured failure line explaining WHY
 * before the failover chain took over. The per-attempt error log exists on
 * this path; this guard pins the pin-correlation fields to it so a refactor
 * cannot silently drop them again.
 *
 * String-grep wiring test — same accepted pattern as
 * streaming-identity-policy-wiring.test.ts / collective-disconnect-abort-wiring.test.ts
 * (the full route handler needs heavy fixture wiring to exercise functionally).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const routesSource = readFileSync(
  join(__dirname, '..', 'chat-routes.ts'),
  'utf8'
);

describe('ci#765 defect 1: pin failover observability wiring (chat-routes streaming chain)', () => {
  it('derives pinnedRequest from the request before the candidate attempt loop', () => {
    const pinnedDerivation = routesSource.indexOf(
      'const pinnedRequest = getUserSpecifiedModelFlag(chatRequest);'
    );
    const attemptLoop = routesSource.indexOf(
      'for (let index = 0; index < candidates.length; index += 1) {'
    );

    expect(pinnedDerivation).toBeGreaterThan(-1);
    expect(attemptLoop).toBeGreaterThan(-1);
    // Must be computed once, upstream of the per-attempt loop that logs it.
    expect(pinnedDerivation).toBeLessThan(attemptLoop);
  });

  it('includes errorCode + pinnedRequest in the per-attempt failure log', () => {
    const failureLog = routesSource.indexOf(
      '`Streaming attempt ${attempt}/${candidates.length} failed - '
    );
    expect(failureLog).toBeGreaterThan(-1);

    // Search backwards from the failure log to its requestLog.error({ opening
    // and assert both fields sit inside the same log call's field object.
    const callStart = routesSource.lastIndexOf('requestLog.error(', failureLog);
    expect(callStart).toBeGreaterThan(-1);
    const fieldsBlock = routesSource.slice(callStart, failureLog);

    expect(fieldsBlock).toContain('errorCode:');
    expect(fieldsBlock).toContain('pinnedRequest');
    expect(fieldsBlock).toContain('latencyMs');
    expect(fieldsBlock).toContain('modelId');
  });
});
