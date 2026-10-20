// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OpenAPI contract for the prepaid wallet gate's HTTP surface.
 *
 * Lives NEXT TO prepaid-wallet-gate.ts on purpose: the schema below documents
 * the exact body `gateChatRequest` returns on its 402 path (prepaid-wallet-gate.ts
 * `insufficient_funds`). If that body changes, this file must change in the same
 * commit — the response schemas are wired into Fastify, so a drifted schema would
 * silently DROP undeclared fields during response serialization (fast-json-stringify),
 * not just misdocument them.
 *
 * Until 2026-09-30 these routes returned 402 at runtime with the status declared
 * on NONE of them (the exclusion-test header documented the gap when the wallet
 * was still excluded). The wire is deployed and verified now, so the contract
 * follows the behavior.
 */

/** Status-code → response-schema map for a wallet-gated route. */
export const prepaidWalletResponses: Record<number, unknown> = {
  402: {
    description:
      'Insufficient prepaid wallet balance for a tiered cell (composite strategy presets like consensus:medium). ' +
      'The org wallet could not cover the worst-case hold; purchase credits and retry. ' +
      'Only returned when PREPAID_WALLET_GATE_ENABLED is on and the request carries a SERVER-SET tier carrier.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: ['insufficient_funds'] },
                message: {
                  type: 'string',
                  description:
                    'Human-readable, names the product (alias or tier) with the estimated hold and available balance.',
                },
                balance_usd: {
                  type: 'number',
                  description: 'Wallet balance available at gate time, USD.',
                },
                required_usd: {
                  type: 'number',
                  description: 'Worst-case hold the gate tried to reserve, USD.',
                },
              },
            },
          },
        },
      },
    },
  },
};
