// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The 402 contract of the wallet-gated routes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Since PR #694/#698 the four tiered-cell routes return 402 `insufficient_funds`
 * at runtime, but the OpenAPI contract declared the status on none of them —
 * the gap was already noted in orchestration-gate-wallet-exclusion.test.ts's
 * header while the wallet was still excluded. A client generated from the spec
 * cannot know the top-up retry shape; worse, since Fastify serializes responses
 * through `schema.response` (fast-json-stringify), an UNDECLARED 402 is also the
 * only status these routes can emit that bypasses contract-validated
 * serialization. This file pins both halves:
 *
 *   1. the shared `prepaidWalletResponses` constant matches the body
 *      `gateChatRequest` actually returns (declared-field-for-field — a drift
 *      would silently DROP fields, not just misdocument);
 *   2. the real OpenAPI object, built by registering the actual route modules
 *      in Fastify + @fastify/swagger, declares 402 on every gated route.
 *
 * chat-routes is pinned textually (same anchored-read pattern as
 * orchestration-gate-wallet-exclusion.test.ts): importing it drags the whole
 * orchestration engine, and the assertion is about a literal schema reference —
 * the cost/benefit favors the static pin.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Heavy transitive deps mocked so importing the route modules is cheap and
// side-effect-free (same preamble as responses-streaming.test.ts).
vi.mock('@/database/client', () => ({
  prisma: {
    requestLog: {
      upsert: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));
vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({ executeStream: vi.fn() }),
  isOrchestrationEngineInitialized: () => true,
}));
vi.mock('@/services/billing-usage-tracker', () => ({
  trackChatUsage: vi.fn().mockResolvedValue(undefined),
}));

const { prepaidWalletResponses } = await import('../prepaid-wallet-openapi');
const { registerResponsesRoutes } = await import(
  '../../routes/responses/responses-routes'
);
const { registerExtendedThinkingRoutes } = await import(
  '../../routes/extended-thinking/extended-thinking-routes'
);

const fourOhTwo = () =>
  (prepaidWalletResponses as Record<number, any>)[402];

describe('prepaidWalletResponses constant', () => {
  it('documents exactly the body gateChatRequest returns on 402', () => {
    const schema = fourOhTwo().content['application/json'].schema;
    const error = schema.properties.error;

    // Field-for-field with prepaid-wallet-gate.ts's insufficient_funds body.
    expect(schema.required).toEqual(['error']);
    expect(error.properties.code.enum).toEqual(['insufficient_funds']);
    expect(error.required).toEqual(['code', 'message']);
    expect(error.properties).toHaveProperty('balance_usd');
    expect(error.properties).toHaveProperty('required_usd');
  });

  it('declares exactly one status — the wallet status code', () => {
    expect(Object.keys(prepaidWalletResponses)).toEqual(['402']);
  });
});

describe('OpenAPI object declares 402 on the gated routes', () => {
  it('/v1/responses, /extended-thinking and /ultra-thinking', async () => {
    const { default: Fastify } = await import('fastify');
    const { default: swagger } = await import('@fastify/swagger');

    const app = Fastify();
    await app.register(swagger, {
      openapi: {
        // Same securitySchemes as server.ts — the route schemas reference
        // bearerAuth/apiKeyAuth and swagger() throws on undefined refs.
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            apiKeyAuth: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
          },
        },
      },
    });
    await app.register(registerResponsesRoutes);
    await app.register(registerExtendedThinkingRoutes);
    await app.ready();

    const spec = app.swagger() as any;
    const gated: Array<[string, string]> = [
      ['/v1/responses', 'post'],
      ['/v1/chat/completions/extended-thinking', 'post'],
      ['/v1/chat/completions/ultra-thinking', 'post'],
    ];
    for (const [route, method] of gated) {
      const operation = spec.paths[route]?.[method];
      expect(operation, `${method} ${route} present in the spec`).toBeTruthy();
      const resp402 = operation?.responses?.['402'];
      expect(resp402, `${method} ${route} declares 402`).toBeTruthy();
      expect(resp402.content['application/json'].schema.properties.error.properties.code.enum)
        .toEqual(['insufficient_funds']);
    }
  });
});

describe('/v1/chat/completions — static pin', () => {
  const CHAT_ROUTES_CODE = readFileSync(
    path.resolve(__dirname, '../../routes/chat/chat-routes.ts'),
    'utf8'
  );

  it('is really the flagship route file (positive anchors first)', () => {
    // If the file moved or failed to load, the pin below would pass vacuously.
    expect(CHAT_ROUTES_CODE.length).toBeGreaterThan(1000);
    expect(CHAT_ROUTES_CODE).toContain("'/v1/chat/completions'");
    expect(CHAT_ROUTES_CODE).toContain('gateChatRequest');
  });

  it('declares the wallet 402 response in its schema', () => {
    // Spread form: the route already had a full response map (200/…), so the
    // 402 is merged in — a standalone `response:` key would be dead (later
    // keys win in object literals; found the hard way 2026-09-30).
    expect(CHAT_ROUTES_CODE).toContain('...prepaidWalletResponses,');
  });
});
