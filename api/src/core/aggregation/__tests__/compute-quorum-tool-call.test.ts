// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `computeQuorumToolCall()` / `toolCallsMatch()` / `normalizeToolArgs()` —
 * media-generation-delegation plan, PR2.
 *
 * `computeQuorumToolCall()` (Elo 3 QUORUM, 2026-06-11) already existed and
 * was already used by `ResponseAggregator.aggregate()` to decide which
 * single tool_call (if any) survives into a collective's synthesized
 * response. PR2 exports it (plus a new `toolCallsMatch()` helper built on
 * the same normalization) so `base-strategy.ts`'s `executeModelWithTools`
 * can reuse the SAME mechanism to authorize a `strategyExecutionMode:
 * 'quorumOnly'` tool call, instead of a parallel implementation.
 *
 * This suite exercises the real, exported functions directly.
 */
import { describe, it, expect } from 'vitest';
import {
  computeQuorumToolCall,
  toolCallsMatch,
  normalizeToolArgs,
  type ModelResponse,
} from '../response-aggregator';
import type { ChatResponse, ToolCall } from '@/types';

function toolCall(name: string, args: string, id = 'call_1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function responseWith(calls: ToolCall[] | undefined): ChatResponse {
  return {
    id: 'r',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '', tool_calls: calls },
        finish_reason: calls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as ChatResponse;
}

function voter(calls: ToolCall[] | undefined, modelId = 'v'): ModelResponse {
  return {
    modelId,
    modelName: modelId,
    response: responseWith(calls),
    cost: 0,
    durationMs: 1,
    success: true,
  };
}

describe('computeQuorumToolCall()', () => {
  it('returns null for an empty voter list', () => {
    expect(computeQuorumToolCall([])).toBeNull();
  });

  it('returns null when no voter proposed a tool call', () => {
    const voters = [voter(undefined, 'v1'), voter(undefined, 'v2')];
    expect(computeQuorumToolCall(voters)).toBeNull();
  });

  it('returns the winning call when a strict majority (2 of 3) agree', () => {
    const args = '{"prompt":"a cat"}';
    const voters = [
      voter([toolCall('generate_video', args)], 'v1'),
      voter([toolCall('generate_video', args)], 'v2'),
      voter([toolCall('generate_video', '{"prompt":"a dog"}')], 'v3'),
    ];
    const winner = computeQuorumToolCall(voters);
    expect(winner?.function.name).toBe('generate_video');
    expect(winner?.function.arguments).toBe(args);
  });

  it('returns null when votes split exactly (no strict majority) across 2 voters', () => {
    const voters = [
      voter([toolCall('generate_video', '{"prompt":"a cat"}')], 'v1'),
      voter([toolCall('generate_video', '{"prompt":"a dog"}')], 'v2'),
    ];
    expect(computeQuorumToolCall(voters)).toBeNull();
  });

  it('requires a STRICT majority — 2 of 4 (exactly half) is not enough', () => {
    const catArgs = '{"prompt":"a cat"}';
    const voters = [
      voter([toolCall('generate_video', catArgs)], 'v1'),
      voter([toolCall('generate_video', catArgs)], 'v2'),
      voter([toolCall('generate_video', '{"prompt":"a dog"}')], 'v3'),
      voter([toolCall('generate_video', '{"prompt":"a bird"}')], 'v4'),
    ];
    expect(computeQuorumToolCall(voters)).toBeNull();
  });

  it('treats semantically-equal args with different key order as the same call', () => {
    const voters = [
      voter([toolCall('generate_video', '{"prompt":"p","duration":5}')], 'v1'),
      voter([toolCall('generate_video', '{"duration":5,"prompt":"p"}')], 'v2'),
    ];
    const winner = computeQuorumToolCall(voters);
    expect(winner).not.toBeNull();
    expect(winner?.function.name).toBe('generate_video');
  });

  it('only considers the PRIMARY (first) tool_call per voter', () => {
    const voters = [
      voter(
        [toolCall('generate_video', '{"prompt":"a cat"}', 'c1'), toolCall('web_search', '{}', 'c2')],
        'v1'
      ),
      voter([toolCall('generate_video', '{"prompt":"a cat"}')], 'v2'),
    ];
    const winner = computeQuorumToolCall(voters);
    expect(winner?.function.name).toBe('generate_video');
  });

  it('ignores unsuccessful/errored voter responses only insofar as the caller filters them — operates on whatever list it is given', () => {
    // computeQuorumToolCall() itself has no `success` filter; the aggregator
    // passes it only `successful` responses. Documented here so a future
    // reader doesn't assume an internal filter exists.
    const voters = [
      voter([toolCall('generate_video', '{"prompt":"a cat"}')], 'v1'),
      voter([toolCall('generate_video', '{"prompt":"a cat"}')], 'v2'),
    ];
    expect(computeQuorumToolCall(voters)).not.toBeNull();
  });
});

describe('toolCallsMatch()', () => {
  it('matches identical name + args', () => {
    const a = toolCall('generate_video', '{"prompt":"p"}');
    const b = toolCall('generate_video', '{"prompt":"p"}', 'call_2');
    expect(toolCallsMatch(a, b)).toBe(true);
  });

  it('matches args with different key order', () => {
    const a = toolCall('generate_video', '{"prompt":"p","duration":5}');
    const b = toolCall('generate_video', '{"duration":5,"prompt":"p"}');
    expect(toolCallsMatch(a, b)).toBe(true);
  });

  it('does not match a different function name', () => {
    const a = toolCall('generate_video', '{"prompt":"p"}');
    const b = toolCall('generate_media', '{"prompt":"p"}');
    expect(toolCallsMatch(a, b)).toBe(false);
  });

  it('does not match different arguments', () => {
    const a = toolCall('generate_video', '{"prompt":"a cat"}');
    const b = toolCall('generate_video', '{"prompt":"a dog"}');
    expect(toolCallsMatch(a, b)).toBe(false);
  });

  it('returns false when either side is null/undefined or has no function name', () => {
    const a = toolCall('generate_video', '{}');
    expect(toolCallsMatch(a, null)).toBe(false);
    expect(toolCallsMatch(undefined, a)).toBe(false);
    expect(toolCallsMatch(null, undefined)).toBe(false);
  });
});

describe('normalizeToolArgs()', () => {
  it('normalizes key order for a JSON object string', () => {
    expect(normalizeToolArgs('{"b":2,"a":1}')).toBe(normalizeToolArgs('{"a":1,"b":2}'));
  });

  it('falls back to the trimmed raw string for invalid JSON', () => {
    expect(normalizeToolArgs('not json')).toBe('not json');
  });

  it('stringifies a non-string value directly', () => {
    expect(normalizeToolArgs(undefined)).toBe(JSON.stringify(null));
  });
});
