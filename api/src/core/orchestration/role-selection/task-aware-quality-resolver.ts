// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §12 — Task-aware quality resolver.
 *
 * Maps a request's `taskProfile.taskType` + `expectedFormat` to a
 * `QualityCategory`, then looks up the most relevant per-category score
 * from a model's calibration entry. Falls back to the entry's aggregate
 * `qualityScore` when no category match exists.
 *
 * This is the module that closes the J1G manual-bump anti-pattern: a
 * model with high `chat_text` rank is NOT chosen for `image_edit` just
 * because its (unrelated) rank happens to exceed the catalog placeholder.
 *
 * Pure functions: no I/O. Used by `model-role-resolver.ts` inside
 * `rankPoolForSynthesizer` (and any other scorer that wants task-aware
 * quality routing).
 */
import type { TaskType } from '@/types';
import type {
  ModelQualityCalibrationEntry,
  QualityCategory,
} from './model-quality-calibration';
import { resolveQualityForTask } from './model-quality-calibration';

// ─── Task → category mapping ──────────────────────────────────────────────

/**
 * Maps a TaskType (from @/types) to one or more candidate QualityCategory
 * values. The FIRST matching category that has data wins. Default category
 * is `chat_text` when nothing else applies.
 *
 * Mapping rationale:
 *   - code-* / refactoring / debugging  → code_webdev (LMArena's "Code/Web Dev")
 *   - document-understanding            → chat_document
 *   - reasoning / decision-making /
 *     architecture / qa / factual-qa    → chat_text (general LM ranking)
 *   - creative                          → chat_text
 *   - analysis                          → chat_document (long-form analysis)
 *   - testing                           → code_webdev (codegen quality dominates)
 *   - adversarial                       → chat_text
 *   - caching / general                 → chat_text
 *
 * The mapping is intentionally a list (multi-category) so the resolver
 * tries chat_document THEN falls back to chat_text when a model has only
 * chat_text data. Order = priority.
 */
const TASK_TYPE_CATEGORY_PRIORITY: Readonly<Record<TaskType, readonly QualityCategory[]>> = {
  'code-generation': ['code_webdev', 'chat_text'],
  'code-review': ['code_webdev', 'chat_text'],
  'debugging': ['code_webdev', 'chat_text'],
  'refactoring': ['code_webdev', 'chat_text'],
  'documentation': ['chat_document', 'chat_text'],
  'testing': ['code_webdev', 'chat_text'],
  'analysis': ['chat_document', 'chat_text'],
  'qa': ['chat_text'],
  'general': ['chat_text'],
  'caching': ['chat_text'],
  'reasoning': ['chat_text'],
  'decision-making': ['chat_text'],
  'architecture': ['chat_text', 'chat_document'],
  'creative': ['chat_text'],
  'factual-qa': ['chat_text', 'chat_search'],
  'adversarial': ['chat_text'],
  'document-understanding': ['chat_document', 'chat_text'],
};

/**
 * Optional override from `taskProfile.expectedFormat`. When the task
 * profile indicates a specific output modality (code, json), bias toward
 * the corresponding category.
 *
 * - `code` / `json`   → prepend code_webdev to the priority list
 * - `reasoning`       → ensure chat_text is at front
 * - `free_text`       → default mapping
 */
function applyFormatOverride(
  priority: readonly QualityCategory[],
  expectedFormat: string | undefined,
): readonly QualityCategory[] {
  if (!expectedFormat) return priority;
  switch (expectedFormat) {
    case 'code':
    case 'json':
      if (priority[0] === 'code_webdev') return priority;
      return ['code_webdev', ...priority.filter((c) => c !== 'code_webdev')];
    case 'reasoning':
      if (priority[0] === 'chat_text') return priority;
      return ['chat_text', ...priority.filter((c) => c !== 'chat_text')];
    default:
      return priority;
  }
}

/**
 * Returns the ordered category priority for a given task profile.
 * Unknown task types fall back to `['chat_text']`.
 *
 * Exposed as `categoryPriorityForTask` so tests + the CLI ranking script
 * can inspect the mapping without going through the scorer.
 */
export function categoryPriorityForTask(taskProfile: {
  readonly taskType?: string;
  readonly expectedFormat?: string;
}): readonly QualityCategory[] {
  const knownTaskTypes = Object.keys(TASK_TYPE_CATEGORY_PRIORITY) as TaskType[];
  const tt = (taskProfile.taskType ?? '') as TaskType;
  const base = knownTaskTypes.includes(tt)
    ? TASK_TYPE_CATEGORY_PRIORITY[tt]
    : ['chat_text' as QualityCategory];
  return applyFormatOverride(base, taskProfile.expectedFormat);
}

// ─── Resolution ───────────────────────────────────────────────────────────

export interface TaskAwareQualityResolution {
  /** Final score used by the scorer; undefined when not available. */
  readonly score: number | undefined;
  /** Source of the score: which category matched, or 'aggregate'. */
  readonly resolutionPath: 'task_category' | 'source_category_avg' | 'aggregate' | 'unavailable';
  /** The category that won the lookup (when resolution wasn't aggregate). */
  readonly matchedCategory?: QualityCategory;
  /** The ordered priority list that was considered. */
  readonly priorityConsidered: readonly QualityCategory[];
}

/**
 * Resolves the most task-relevant quality score for a given entry.
 *
 * Walks the category priority list in order: returns the first category
 * whose `resolveQualityForTask()` does NOT return `'aggregate'`. Only
 * when no category yields a per-category match do we fall back to the
 * aggregate `qualityScore`.
 *
 * When `entry` is `undefined`, returns `{ score: undefined, resolutionPath: 'unavailable' }`
 * (the scorer applies an unknown-quality penalty).
 */
export function resolveTaskAwareQuality(
  entry: ModelQualityCalibrationEntry | undefined,
  taskProfile: { readonly taskType?: string; readonly expectedFormat?: string },
): TaskAwareQualityResolution {
  const priority = categoryPriorityForTask(taskProfile);
  if (!entry) {
    return { score: undefined, resolutionPath: 'unavailable', priorityConsidered: priority };
  }
  for (const cat of priority) {
    const r = resolveQualityForTask(entry, cat);
    if (r.resolutionPath === 'task_category' || r.resolutionPath === 'source_category_avg') {
      return {
        score: r.score,
        resolutionPath: r.resolutionPath,
        matchedCategory: cat,
        priorityConsidered: priority,
      };
    }
  }
  // No category match; aggregate fallback
  return {
    score: entry.qualityScore,
    resolutionPath: 'aggregate',
    priorityConsidered: priority,
  };
}
