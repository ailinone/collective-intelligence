#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Minimal OpenAI-compatible stub provider server — for isolated-mode runs of
 * phase1-scoring-load-test.js.
 *
 * Purpose: when load-testing the model-selection hot path, real upstream LLM
 * latency (seconds) dwarfs any microsecond-level scoring improvement and
 * costs real money at load-test volumes. This stub returns a canned
 * OpenAI-chat-completions-shaped response instantly, so a k6 run against a
 * staging deployment pointed at this stub measures ONLY the ci/api server's
 * own routing/scoring overhead — which is what "req/s/replica" means in the
 * Phase 1 acceptance criterion.
 *
 * This does not replace real-provider integration testing — it exists
 * solely to isolate one variable (server-side CPU/event-loop overhead) for
 * one specific measurement. No external dependencies (plain node:http).
 *
 * Usage:
 *   node stub-provider-server.js [port]     # default port 9009
 *
 * Then point any OpenAI-compatible provider's *_BASE_URL at it, e.g.:
 *   export OPENAI_BASE_URL=http://localhost:9009/v1
 *   export DEEPSEEK_BASE_URL=http://localhost:9009/v1
 *   export MISTRAL_BASE_URL=http://localhost:9009/v1
 * (any provider whose adapter speaks the OpenAI chat-completions wire
 * format — see api/.env.example for the full *_BASE_URL list)
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || process.env.STUB_PORT || 9009);

function chatCompletionResponse(model) {
  return {
    id: `chatcmpl-stub-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'stub-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'pong' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', data: [] }));
    return;
  }

  if (req.method === 'POST' && req.url && req.url.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let model;
      try { model = JSON.parse(body || '{}').model; } catch { /* ignore malformed body */ }
      const payload = JSON.stringify(chatCompletionResponse(model));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'stub: no route', type: 'not_found' } }));
});

server.listen(PORT, () => {
  console.log(`Stub provider server listening on http://localhost:${PORT}`);
  console.log('Point *_BASE_URL env vars at this for isolated Phase 1 load-test runs.');
});
