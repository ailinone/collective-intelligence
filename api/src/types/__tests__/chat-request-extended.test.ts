// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { getUserSpecifiedModelFlag } from '../chat-request-extended';

describe('chat-request-extended', () => {
  it('honors explicit user_specified_model=true flag', () => {
    const request = {
      model: 'auto',
      messages: [],
      user_specified_model: true,
    };
    expect(getUserSpecifiedModelFlag(request)).toBe(true);
  });

  it('infers explicit model pinning when model is non-auto', () => {
    const request = {
      model: 'gpt-4o-mini',
      messages: [],
    };
    expect(getUserSpecifiedModelFlag(request)).toBe(true);
  });

  it('does not treat model=auto as explicit pinning', () => {
    const request = {
      model: 'auto',
      messages: [],
    };
    expect(getUserSpecifiedModelFlag(request)).toBe(false);
  });

  it('returns false when no model is specified', () => {
    const request = {
      messages: [],
    };
    expect(getUserSpecifiedModelFlag(request)).toBe(false);
  });
});

