// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ESLint rule: no-side-effect-imports (SKELETON — NOT ACTIVATED IN MVP 1)
 *
 * Status: this file is created in MVP 1 but is NOT wired into the
 * project's ESLint configuration. No `.eslintrc`, no `package.json`,
 * no CI pipeline references this rule yet.
 *
 * Goal when activated: forbid top-level side effects in modules under
 * `api/src/core/registry/**`, `api/src/core/routing/**`,
 * `api/src/core/selection/**` and `api/src/core/strategy/**`. These
 * modules must remain importable in module-load with zero runtime
 * consequences (no Prisma client, no Redis, no TEI, no fetch, no
 * timer, no admin route registration, no provider probe).
 *
 * Concretely, the rule should flag:
 *
 *   FORBIDDEN at the top level:
 *
 *     const prisma = new PrismaClient();           // ← side effect
 *     await redis.connect();                       // ← side effect
 *     metrics.registerCounter('routing_…');         // ← side effect
 *     setInterval(() => …, 5000);                  // ← side effect
 *     server.get('/v1/admin/routing/…', handler);  // ← side effect
 *     getProviderOperabilityHub().getSummary();    // ← side effect
 *
 *   ALLOWED at the top level:
 *
 *     import type { Foo } from '…';                // ← types disappear at runtime
 *     const internal = new Map();                  // ← in-memory only
 *     export function pure(x) { … }                // ← pure functions
 *     const CONST = 42;                            // ← primitive constants
 *
 * Detection strategy (when activated):
 *
 *   - Walk the top-level program statements.
 *   - For each `CallExpression`, check the callee against an allow-list
 *     of pure builtins (`Object.freeze`, `Symbol`, etc.). Any other
 *     top-level call is suspicious.
 *   - For each `NewExpression`, similarly check the class name against
 *     an allow-list (`Map`, `Set`, `Date` are OK; `PrismaClient`,
 *     `Redis`, `EventEmitter` are NOT).
 *   - For each `AwaitExpression` at the top level, flag immediately.
 *
 *   The rule has an option `{ allowedFactories: string[] }` so callers
 *   can extend the allow-list per-file when needed.
 *
 * Pairs with the `module-load-safety.test.ts` runtime check — the lint
 * is static + cheap, the test is dynamic + thorough. Both together
 * defend the invariant.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'forbid top-level side effects in core/routing core/registry core/selection core/strategy modules',
      recommended: false, // ← intentional: SKELETON, not active
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFactories: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      topLevelCall:
        'Top-level call expression "{{name}}" creates a side effect on module load. ' +
        'Move it inside a factory function gated by RuntimeRoutingConfigProvider.',
      topLevelAwait:
        'Top-level await on module load creates a side effect. ' +
        'Move it inside an async factory function.',
      topLevelNew:
        'Top-level `new {{name}}` creates a side effect on module load. ' +
        'Lazy-init via factory.',
    },
  },
  create(/* context */) {
    // SKELETON: returns no visitors → emits zero diagnostics.
    // Activation will replace this body with real Program-body visitors.
    return {};
  },
};
