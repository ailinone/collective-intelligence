// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type {
  CodeLanguage,
  CodeLanguageProfile,
  CodeCapabilityProfile,
} from '@/types/code-profile';

import type { ModelRecord } from '@/types/model-client';
import type { Model } from '@/types';

const DEFAULT_LANGUAGE_PROFILE: CodeCapabilityProfile = {
  languages: {
    primary: 'javascript',

    secondary: [],

    level: 'basic',
  },

  multiLanguage: false,

  role: 'general',
};

/**
 * Type guard to check if value is a CodeCapabilityProfile
 */
function isCodeCapabilityProfile(value: unknown): value is CodeCapabilityProfile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    'languages' in obj &&
    typeof obj.languages === 'object' &&
    obj.languages !== null &&
    'primary' in (obj.languages as Record<string, unknown>)
  );
}

/**
 * Type guard to check if value has languageProfile property
 */
function hasLanguageProfile(value: unknown): value is { languageProfile: CodeCapabilityProfile } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return 'languageProfile' in obj && isCodeCapabilityProfile(obj.languageProfile);
}

/**
 * Extract extra config from ModelRecord
 */
function getExtraFromModelRecord(model: ModelRecord): Record<string, unknown> {
  return (model.config?.extra as Record<string, unknown>) ?? {};
}

/**
 * Extract metadata from Model (DB format)
 */
function getMetadataFromModel(model: Model): Record<string, unknown> {
  if (typeof model.metadata === 'object' && model.metadata !== null) {
    return model.metadata as Record<string, unknown>;
  }
  return {};
}

export function getCodeCapabilityProfile(model: ModelRecord | Model): CodeCapabilityProfile {
  let extra: Record<string, unknown> = {};

  // Se for ModelRecord (novo formato)
  if ('config' in model && model.config?.extra) {
    extra = getExtraFromModelRecord(model as ModelRecord);
  }
  // Se for Model (formato da DB)
  else if ('metadata' in model && model.metadata) {
    const metadata = getMetadataFromModel(model as Model);
    if (hasLanguageProfile(metadata)) {
      extra = { languageProfile: metadata.languageProfile };
    }
  }

  // Type-safe extraction of languageProfile
  if (hasLanguageProfile(extra)) {
    return extra.languageProfile;
  }

  return DEFAULT_LANGUAGE_PROFILE;
}

export function getLanguagesToTest(model: ModelRecord): CodeLanguage[] {
  const profile = getCodeCapabilityProfile(model);

  const langs = [profile.languages.primary, ...(profile.languages.secondary ?? [])];

  return profile.multiLanguage ? langs : [profile.languages.primary];
}
