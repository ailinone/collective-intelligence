// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Realtime feedback loop repair iterations must carry the language-mirror
 * directive (audit finding F-06): the corrected response has to stay in the
 * user's language, matching the execution system prompt (which places the same
 * directive LAST as the strongest signal).
 */
import { describe, it, expect } from 'vitest';
import { RealtimeFeedbackLoop } from '../realtime-feedback-loop';
import { LANGUAGE_MIRROR_DIRECTIVE } from '@/core/orchestration/prompts/language-directive';
import type { ChatRequest } from '@/types';

describe('RealtimeFeedbackLoop.augmentRequestWithFeedback — language mirror (F-06)', () => {
  it('appends LANGUAGE_MIRROR_DIRECTIVE after the feedback content', () => {
    const loop = new RealtimeFeedbackLoop();
    const augment = (
      loop as unknown as {
        augmentRequestWithFeedback(request: ChatRequest, feedback: string): ChatRequest;
      }
    ).augmentRequestWithFeedback.bind(loop);

    const request: ChatRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'olá' }],
    };
    const augmented = augment(request, 'Iteration 1 did not meet quality requirements.');

    expect(augmented.messages).toHaveLength(2);
    const last = augmented.messages[1];
    expect(last.role).toBe('system');
    expect(typeof last.content === 'string').toBe(true);
    const content = last.content as string;
    expect(content.startsWith('Iteration 1 did not meet quality requirements.')).toBe(true);
    expect(content.endsWith(LANGUAGE_MIRROR_DIRECTIVE)).toBe(true);
  });
});
