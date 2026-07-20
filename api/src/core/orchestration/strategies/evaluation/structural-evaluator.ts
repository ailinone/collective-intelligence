// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * StructuralOutputEvaluator
 *
 * Cheap, deterministic checks. NEVER emits a quality score — only a
 * pass/fail verdict plus structural facts. Use this as a sanity gate
 * before a more expensive evaluator (LLM judge, task-specific) when one
 * exists, OR on its own when the operator wants outlier filtering with
 * no quality signal.
 *
 * Checks performed (all configurable via `StrategyEvaluationTask`):
 *   - nonEmpty
 *   - meetsMinLength (default 50 chars, or `task.minLength`)
 *   - jsonValid (only when `task.expectedFormat === 'json'`)
 *   - codeBlockPresent (only when `task.expectedFormat === 'code'`)
 *   - executionError (forwarded from caller)
 */
import type {
  EvaluationResult,
  EvaluatorInput,
  StrategyOutputEvaluator,
} from './strategy-output-evaluator';

export interface StructuralOutputEvaluatorOptions {
  readonly defaultMinLength?: number;
}

export class StructuralOutputEvaluator implements StrategyOutputEvaluator {
  readonly mode = 'structural' as const;
  readonly id = 'structural-default-v1';

  constructor(private readonly opts: StructuralOutputEvaluatorOptions = {}) {}

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const executionError = input.executionFailed === true;
    const text = input.output ?? '';
    const trimmed = text.trim();
    const nonEmpty = trimmed.length > 0;
    const minLength = input.task.minLength ?? this.opts.defaultMinLength ?? 50;
    const meetsMinLength = trimmed.length >= minLength;

    let jsonValid: boolean | undefined;
    let codeBlockPresent: boolean | undefined;

    if (input.task.expectedFormat === 'json') {
      jsonValid = isJsonParseable(trimmed);
    }
    if (input.task.expectedFormat === 'code') {
      codeBlockPresent = /```[\s\S]*?```/.test(trimmed);
    }

    const fail =
      executionError ||
      !nonEmpty ||
      !meetsMinLength ||
      jsonValid === false ||
      codeBlockPresent === false;

    return {
      scoringMode: this.mode,
      evaluatorId: this.id,
      score: undefined,
      verdict: fail ? 'fail' : 'pass',
      structural: {
        nonEmpty,
        meetsMinLength,
        executionError,
        jsonValid,
        codeBlockPresent,
      },
      notes:
        'Structural verdict only — no quality score. ' +
        'Strategy artifacts will record validationStatus = "structurally_validated_only".',
    };
  }
}

function isJsonParseable(s: string): boolean {
  if (s.length === 0) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
