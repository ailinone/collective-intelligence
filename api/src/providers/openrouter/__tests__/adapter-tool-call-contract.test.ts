// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Adapter response-shape contract.
 *
 * The gateway speaks the OpenAI wire format, where an assistant message carries
 * its tool calls under `tool_calls` (snake_case). Internally the codebase uses
 * camelCase, and there is NO outbound normalizer: every adapter's response
 * object is passed by reference through the strategies, the request processor
 * and the route, and the Fastify schema is `additionalProperties: true`. So the
 * wire contract is enforced by nothing except each adapter getting it right.
 *
 * It did not. `openrouter-adapter.ts` emitted the key as `toolCalls`, which is
 * invisible to every OpenAI-spec consumer. Downstream, `ailinone/chat` has zero
 * references to `toolCalls`, so the tool call was silently dropped and its
 * agents answered from the prompt instead of executing the tool — the worst
 * possible failure mode for a deterministic fiscal reconciliation, because
 * nothing errors.
 *
 * TypeScript did not catch it: the object literal was built inside an
 * `Array.prototype.map` callback with no return annotation, so the literal lost
 * freshness and excess-property checking never fired, while `tool_calls` being
 * optional made its absence legal.
 *
 * These tests need no API keys and no network, deliberately: the live adapter
 * suites skip without provider credentials, which is exactly why this shipped
 * unnoticed since the repo's first commit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROVIDERS_DIR = join(__dirname, '..', '..');

function adapterFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      found.push(...adapterFiles(full));
    } else if (entry.endsWith('-adapter.ts') && !entry.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('adapter response-shape contract', () => {
  const files = adapterFiles(PROVIDERS_DIR);

  it('finds adapters to check (guards against a silently empty sweep)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.slice(PROVIDERS_DIR.length + 1), f]))(
    '%s never emits a camelCase `toolCalls:` object key',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');
      const offenders = source
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        // An object key, not a local variable: `toolCalls:` preceded only by
        // whitespace. `const toolCalls =` and `{ toolCalls }` shorthand reads
        // are fine — the sin is putting it on the wire.
        .filter(([, line]) => /^\s*(\.\.\.\(?\s*)?toolCalls\s*:/.test(line))
        .map(([n, line]) => `${n}: ${line.trim()}`);

      expect(
        offenders,
        `Emit \`tool_calls\` (OpenAI wire format), not \`toolCalls\`. ` +
          `Annotate the enclosing map callback \`: ChatChoice\` so the compiler enforces it.`
      ).toEqual([]);
    }
  );

  // NOTE: there is deliberately no equivalent source sweep for `finishReason`.
  // The identifier is legitimate in several places a regex cannot tell apart
  // from a wire key: Google's upstream SDK genuinely uses `finishReason`
  // (google-adapter.ts:426 types it), aws-sagemaker uses it as an internal
  // helper's return field, and openai-adapter.ts:529 puts it in a log line.
  // A test that fires on correct code gets deleted by the next person, so the
  // stray `finishReason` the OpenRouter adapter emitted alongside its
  // `finish_reason` is asserted behaviourally instead — see
  // `openrouter-tool-calls.test.ts`, which checks the actual response object.
  //
  // `toolCalls` above is different: it has no legitimate use as an object key
  // anywhere in an adapter's response path, so the sweep is sound.
});
