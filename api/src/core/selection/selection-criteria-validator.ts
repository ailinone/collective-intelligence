// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Selection Criteria Validator
 *
 * Validates SelectionCriteria input to prevent runtime errors
 */

import type { SelectionCriteria } from './dynamic-model-selector';
import { MODEL_CAPABILITIES, type TaskType, type ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'selection-criteria-validator' });

/**
 * Valid task types
 */
const VALID_TASK_TYPES: TaskType[] = [
  'code-generation',
  'code-review',
  'debugging',
  'refactoring',
  'documentation',
  'testing',
  'analysis',
  'qa',
  'general',
];

/**
 * Valid complexity levels
 */
const VALID_COMPLEXITY_LEVELS = ['low', 'medium', 'high'] as const;

/**
 * Valid model capabilities
 */
const VALID_CAPABILITIES: ModelCapability[] = [...MODEL_CAPABILITIES];

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: SelectionCriteria;
}

/**
 * Validate SelectionCriteria
 */
export function validateSelectionCriteria(criteria: SelectionCriteria): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sanitized: Partial<SelectionCriteria> = {};

  // Validate taskType
  if (!criteria.taskType) {
    errors.push('taskType is required');
  } else if (!VALID_TASK_TYPES.includes(criteria.taskType)) {
    errors.push(
      `Invalid taskType: ${criteria.taskType}. Must be one of: ${VALID_TASK_TYPES.join(', ')}`
    );
  } else {
    sanitized.taskType = criteria.taskType;
  }

  // Validate complexity
  if (!criteria.complexity) {
    errors.push('complexity is required');
  } else if (!VALID_COMPLEXITY_LEVELS.includes(criteria.complexity)) {
    errors.push(
      `Invalid complexity: ${criteria.complexity}. Must be one of: ${VALID_COMPLEXITY_LEVELS.join(', ')}`
    );
  } else {
    sanitized.complexity = criteria.complexity;
  }

  // Validate contextSize
  if (criteria.contextSize === undefined || criteria.contextSize === null) {
    errors.push('contextSize is required');
  } else {
    const contextSize = Number(criteria.contextSize);
    if (isNaN(contextSize) || contextSize < 0) {
      errors.push(`Invalid contextSize: ${criteria.contextSize}. Must be a non-negative number`);
    } else {
      // 10M-token windows are a supported input size (long-context models).
      // Above that, warn — but ALWAYS keep the value: the old code dropped
      // sanitized.contextSize on the warning branch, silently disabling the
      // contextWindow >= contextSize selection gate for huge requests (bug).
      if (contextSize > 10_000_000) {
        warnings.push(`contextSize is very large: ${contextSize}. This may cause performance issues`);
      }
      sanitized.contextSize = contextSize;
    }
  }

  // Validate maxCost (optional)
  if (criteria.maxCost !== undefined && criteria.maxCost !== null) {
    const maxCost = Number(criteria.maxCost);
    if (isNaN(maxCost) || maxCost < 0) {
      errors.push(`Invalid maxCost: ${criteria.maxCost}. Must be a non-negative number`);
    } else {
      sanitized.maxCost = maxCost;
    }
  }

  // Validate qualityTarget (optional)
  if (criteria.qualityTarget !== undefined && criteria.qualityTarget !== null) {
    const qualityTarget = Number(criteria.qualityTarget);
    if (isNaN(qualityTarget) || qualityTarget < 0 || qualityTarget > 1) {
      errors.push(`Invalid qualityTarget: ${criteria.qualityTarget}. Must be between 0 and 1`);
    } else {
      sanitized.qualityTarget = qualityTarget;
    }
  }

  // Validate preferSpeed (optional)
  if (criteria.preferSpeed !== undefined && criteria.preferSpeed !== null) {
    if (typeof criteria.preferSpeed !== 'boolean') {
      errors.push(`Invalid preferSpeed: ${criteria.preferSpeed}. Must be a boolean`);
    } else {
      sanitized.preferSpeed = criteria.preferSpeed;
    }
  }

  // Validate requiredCapabilities (optional)
  if (criteria.requiredCapabilities) {
    if (!Array.isArray(criteria.requiredCapabilities)) {
      errors.push('requiredCapabilities must be an array');
    } else {
      const invalidCapabilities = criteria.requiredCapabilities.filter(
        (cap: ModelCapability) => !VALID_CAPABILITIES.includes(cap)
      );
      if (invalidCapabilities.length > 0) {
        warnings.push(`Invalid capabilities: ${invalidCapabilities.join(', ')}. Will be ignored`);
      }
      sanitized.requiredCapabilities = criteria.requiredCapabilities.filter((cap: ModelCapability) =>
        VALID_CAPABILITIES.includes(cap)
      );
    }
  }

  // Validate requiredTools (optional)
  if (criteria.requiredTools) {
    if (!Array.isArray(criteria.requiredTools)) {
      errors.push('requiredTools must be an array');
    } else {
      sanitized.requiredTools = criteria.requiredTools.filter(
        (tool: string) => typeof tool === 'string' && tool.length > 0
      );
    }
  }

  // Validate requiredEndpoint (optional)
  if (criteria.requiredEndpoint) {
    if (typeof criteria.requiredEndpoint !== 'string') {
      errors.push('requiredEndpoint must be a string');
    } else {
      sanitized.requiredEndpoint = criteria.requiredEndpoint;
    }
  }

  // Validate excludeProviders (optional)
  if (criteria.excludeProviders) {
    if (!Array.isArray(criteria.excludeProviders)) {
      errors.push('excludeProviders must be an array');
    } else {
      sanitized.excludeProviders = criteria.excludeProviders.filter(
        (provider: string) => typeof provider === 'string' && provider.length > 0
      );
    }
  }

  // Validate preferredProviders (optional)
  if (criteria.preferredProviders) {
    if (!Array.isArray(criteria.preferredProviders)) {
      errors.push('preferredProviders must be an array');
    } else {
      sanitized.preferredProviders = criteria.preferredProviders.filter(
        (provider: string) => typeof provider === 'string' && provider.length > 0
      );
    }
  }

  // Validate maxInputCostPer1k (optional)
  if (criteria.maxInputCostPer1k !== undefined && criteria.maxInputCostPer1k !== null) {
    const value = Number(criteria.maxInputCostPer1k);
    if (isNaN(value) || value < 0) {
      errors.push(
        `Invalid maxInputCostPer1k: ${criteria.maxInputCostPer1k}. Must be a non-negative number`
      );
    } else {
      sanitized.maxInputCostPer1k = value;
    }
  }

  // Validate maxOutputCostPer1k (optional)
  if (criteria.maxOutputCostPer1k !== undefined && criteria.maxOutputCostPer1k !== null) {
    const value = Number(criteria.maxOutputCostPer1k);
    if (isNaN(value) || value < 0) {
      errors.push(
        `Invalid maxOutputCostPer1k: ${criteria.maxOutputCostPer1k}. Must be a non-negative number`
      );
    } else {
      sanitized.maxOutputCostPer1k = value;
    }
  }

  // Validate maxAverageCostPer1k (optional)
  if (criteria.maxAverageCostPer1k !== undefined && criteria.maxAverageCostPer1k !== null) {
    const value = Number(criteria.maxAverageCostPer1k);
    if (isNaN(value) || value < 0) {
      errors.push(
        `Invalid maxAverageCostPer1k: ${criteria.maxAverageCostPer1k}. Must be a non-negative number`
      );
    } else {
      sanitized.maxAverageCostPer1k = value;
    }
  }

  // Log validation results
  if (errors.length > 0) {
    log.warn({ errors, criteria }, 'SelectionCriteria validation failed');
  }
  if (warnings.length > 0) {
    log.warn({ warnings, criteria }, 'SelectionCriteria validation warnings');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sanitized: errors.length === 0 ? (sanitized as SelectionCriteria) : undefined,
  };
}
