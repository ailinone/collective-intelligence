// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ESLint rule: no-model-name-regex (SKELETON — NOT ACTIVATED IN MVP 1)
 *
 * Status: this file is created in MVP 1 but is NOT wired into the
 * project's ESLint configuration. No `.eslintrc`, no `package.json`,
 * no CI pipeline references this rule yet. Activation is deferred to
 * a later MVP, after the SemanticRoutingEngine is in place to
 * mechanically guarantee that the rule does not break existing code.
 *
 * Goal when activated: forbid decisional name-based detection of model
 * families inside the production hot path. The audit identified these
 * as the anti-pattern that distinguishes "discovery dynamic but routing
 * structural" from "routing semantically dynamic":
 *
 *   model.id.includes('gpt')
 *   /gpt|claude|gemini/i.test(model.name)
 *   modelName.startsWith('claude-')
 *
 * Scope (intended once activated):
 *
 *   FORBIDDEN in:
 *     - api/src/core/orchestration/**
 *     - api/src/core/pool/**
 *     - api/src/core/selection/**
 *     - api/src/core/routing/**
 *     - api/src/core/registry/**
 *     - api/src/core/strategy/**
 *
 *   ALLOWED (with rationale comment) in:
 *     - api/src/core/experiment/** (C3 / experiment scope)
 *     - api/src/services/model-fetchers/** (per-provider parsing)
 *     - api/src/capability/** (capability inference)
 *     - api/src/providers/catalog/** (catalog metadata)
 *
 * Banned name tokens (initial draft):
 *
 *   gpt, claude, gemini, grok, kimi, deepseek, mistral, llama, qwen,
 *   o1, o3, o4, opus, sonnet, haiku, k2 (and equivalents)
 *
 * Reporting strategy:
 *
 *   Report a violation when ANY of the following expressions, in a
 *   file under a FORBIDDEN scope, mentions a banned token:
 *
 *     - String literal in `.includes(...)` on a `modelId | modelName | id` identifier
 *     - RegExp literal in `.test(...)` on the same identifiers
 *     - `.startsWith(...)`, `.endsWith(...)`, `.match(...)` likewise
 *
 *   Suggest an autofix that replaces the regex with a structural check
 *   against `model.capabilityUris` or `canonicalModel.family` once the
 *   registry is in place.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'forbid decisional name-based model-family detection in the production hot path',
      recommended: false, // ← intentional: SKELETON, not active
    },
    schema: [], // no options yet
    messages: {
      modelNameRegex:
        'Decisional name-based detection of model family is forbidden in this scope. ' +
        'Use `canonicalModel.family` or `model.capabilityUris` via the RuntimeModelRegistry.',
    },
  },
  create(/* context */) {
    // SKELETON: returns no visitors → emits zero diagnostics.
    // Activation will replace this body with real CallExpression /
    // BinaryExpression visitors.
    return {};
  },
};
