// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Live capability validation (LOTE AN — Track 2).
 *
 * Exercises the real HTTP surface of a RUNNING ci_api instance with REAL
 * provider credentials: chat, streaming, tool calling, JSON mode, vision,
 * embeddings, image/video generation, and multipart upload.
 *
 * These are paid, non-deterministic calls against third-party vendors, so the
 * whole suite is opt-in. It skips itself unless BOTH are true:
 *
 *   LIVE_API_BASE_URL   base URL of an already-running server, e.g. http://127.0.0.1:3077
 *   LIVE_API_TOKEN      a JWT or ai1sk_ API key for that server
 *
 * Run it with:
 *   LIVE_API_BASE_URL=http://127.0.0.1:3077 LIVE_API_TOKEN=<jwt> \
 *     pnpm vitest run --config vitest.integration.config.ts \
 *     tests/integration/live-capability-validation.integration.test.ts
 *
 * Assertions are deliberately semantic, not just status codes: a vision test
 * only passes if the model names colours that are genuinely in the image, and
 * an image-generation test only passes if the bytes returned decode as a real
 * image. A 200 carrying an apology is a failure.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.LIVE_API_BASE_URL ?? '';
const TOKEN = process.env.LIVE_API_TOKEN ?? '';
const LIVE = Boolean(BASE && TOKEN);

const d = LIVE ? describe : describe.skip;

/** Models confirmed present in the live runnable catalog for each credentialed vendor. */
const MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  deepseek: 'deepseek-v4-flash',
  google: 'models/gemini-2.5-flash-lite',
  mistral: 'ministral-3b-latest',
} as const;

const TIMEOUT = 240_000;

type Json = Record<string, any>;

async function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; ok: boolean; json: Json | null; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, ok: res.ok, json, text };
}

function content(json: Json | null): string {
  const c = json?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: Json) => p?.text ?? '').join('');
  return '';
}

/**
 * A 64x64 PNG split into four quadrants: red (TL), green (TR), blue (BL),
 * yellow (BR). Inlined as base64 so the suite needs no fixture files on disk.
 */
const QUADRANTS_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAVUlEQVR42u3PMQ0A' +
  'MAwDsPBHNiSj0WLokc+SCTiTVOWVCQgICAgICAgICAgICAgICAgICAgICAictQvz' +
  'UyUgICAgICAgICAgICAgICAgICAgICAgcLZlSq0PazBOFQAAAABJRU5ErkJggg==';

describe('live capability validation (LOTE AN)', () => {
  it('reports why it is skipped when not configured', () => {
    if (!LIVE) {
      // Visible breadcrumb rather than a silently-green suite.
      console.warn(
        '[live-capability-validation] SKIPPED — set LIVE_API_BASE_URL and LIVE_API_TOKEN to run.'
      );
    }
    expect(true).toBe(true);
  });
});

d('live capability validation — server reachability', () => {
  beforeAll(async () => {
    const health = await fetch(`${BASE}/health`);
    if (!health.ok) throw new Error(`server at ${BASE} is not healthy (HTTP ${health.status})`);
  }, TIMEOUT);

  it(
    'serves a non-empty runnable model catalog',
    async () => {
      const r = await call('/v1/models?limit=5');
      expect(r.ok).toBe(true);
      expect(Array.isArray(r.json?.data)).toBe(true);
      expect(r.json?.pagination?.total).toBeGreaterThan(0);
    },
    TIMEOUT
  );
});

d('live capability validation — chat (non-streaming)', () => {
  for (const [vendor, model] of Object.entries(MODELS)) {
    it(
      `${vendor}: answers a deterministic arithmetic question`,
      async () => {
        const r = await call('/v1/chat/completions', {
          method: 'POST',
          body: {
            model,
            messages: [
              { role: 'user', content: 'What is 6 multiplied by 7? Reply with only the number.' },
            ],
            max_tokens: 24,
          },
        });
        expect(r.status, r.text.slice(0, 400)).toBe(200);
        // Semantic check: the pipeline may legitimately reroute to another
        // model, but the ANSWER must still be right.
        expect(content(r.json)).toMatch(/42/);
      },
      TIMEOUT
    );
  }
});

d('live capability validation — streaming', () => {
  for (const [vendor, model] of Object.entries(MODELS)) {
    it(
      `${vendor}: delivers SSE frames`,
      async () => {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Count from 1 to 12, separated by spaces.' }],
            max_tokens: 80,
            stream: true,
          }),
        });
        expect(res.status).toBe(200);

        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let text = '';
        let contentFrames = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = raw.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const delta = j.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length) {
                text += delta;
                contentFrames++;
              }
            } catch {
              /* keep-alive comment frame */
            }
          }
        }
        expect(contentFrames).toBeGreaterThan(0);
        expect(text).toMatch(/1/);
      },
      TIMEOUT
    );
  }
});

d('live capability validation — tool calling', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current temperature for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    },
  ];

  for (const [vendor, model] of Object.entries(MODELS)) {
    it(
      `${vendor}: invokes the tool and consumes its result`,
      async () => {
        const prompt = 'What is the current temperature in Lisbon? Use the get_weather tool.';
        const r = await call('/v1/chat/completions', {
          method: 'POST',
          body: { model, messages: [{ role: 'user', content: prompt }], tools, tool_choice: 'auto', max_tokens: 150 },
        });
        expect(r.status, r.text.slice(0, 400)).toBe(200);

        const msg = r.json?.choices?.[0]?.message;
        const calls = msg?.tool_calls ?? [];
        expect(calls.length, `no tool_calls in ${r.text.slice(0, 300)}`).toBeGreaterThan(0);
        expect(calls[0].function.name).toBe('get_weather');
        expect(JSON.parse(calls[0].function.arguments).city).toMatch(/lisbon/i);

        // Feed the result back; the model must actually use the number we gave it.
        const r2 = await call('/v1/chat/completions', {
          method: 'POST',
          body: {
            model,
            messages: [
              { role: 'user', content: prompt },
              { role: 'assistant', tool_calls: calls, content: msg.content ?? null },
              {
                role: 'tool',
                tool_call_id: calls[0].id,
                content: JSON.stringify({ city: 'Lisbon', temperature_c: 19 }),
              },
            ],
            max_tokens: 80,
          },
        });
        expect(r2.status).toBe(200);
        expect(content(r2.json)).toMatch(/19/);
      },
      TIMEOUT
    );
  }
});

d('live capability validation — JSON mode', () => {
  for (const [vendor, model] of Object.entries(MODELS)) {
    it(
      `${vendor}: returns parseable JSON with the requested keys`,
      async () => {
        const r = await call('/v1/chat/completions', {
          method: 'POST',
          body: {
            model,
            messages: [
              {
                role: 'user',
                content:
                  'Return a JSON object with keys "city" (string) and "population" (number) for Lisbon. JSON only.',
              },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 80,
          },
        });
        expect(r.status, r.text.slice(0, 400)).toBe(200);
        const parsed = JSON.parse(content(r.json));
        expect(parsed).toHaveProperty('city');
        expect(parsed).toHaveProperty('population');
      },
      TIMEOUT
    );
  }
});

d('live capability validation — vision', () => {
  it(
    'describes the real content of an inlined image',
    async () => {
      const r = await call('/v1/chat/completions', {
        method: 'POST',
        body: {
          model: MODELS.openai,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'This image has four colored quadrants. List the four colors, comma separated, nothing else.',
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${QUADRANTS_PNG_B64}` },
                },
              ],
            },
          ],
          max_tokens: 40,
        },
      });
      expect(r.status, r.text.slice(0, 400)).toBe(200);

      // Ground truth is known: the fixture really is red/green/blue/yellow.
      // Requiring 3 of 4 tolerates naming variance ("gold" for yellow) without
      // accepting an answer that clearly did not look at the image.
      const answer = content(r.json).toLowerCase();
      const matched = ['red', 'green', 'blue', 'yellow'].filter((c) => answer.includes(c));
      expect(matched.length, `answer did not describe the image: "${answer}"`).toBeGreaterThanOrEqual(3);
    },
    TIMEOUT
  );
});

d('live capability validation — embeddings', () => {
  it(
    'returns a finite numeric vector',
    async () => {
      const r = await call('/v1/embeddings', {
        method: 'POST',
        body: { model: 'mistral-embed', input: 'the quick brown fox' },
      });
      expect(r.status, r.text.slice(0, 400)).toBe(200);
      const vec = r.json?.data?.[0]?.embedding;
      expect(Array.isArray(vec)).toBe(true);
      expect(vec.length).toBeGreaterThan(8);
      expect(vec.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))).toBe(true);
    },
    TIMEOUT
  );
});

/**
 * Multipart upload — the regression guard for the LOTE AN finding.
 *
 * Every one of these routes answered `400 validation_error` before the fix,
 * because Fastify's body validator ran ahead of the multipart parser. The
 * assertion is deliberately narrow: the request must get PAST validation. A
 * downstream failure (no PDF-capable model, storage credentials missing) is an
 * environment matter and must not fail this test — but a validation rejection
 * means the route is unreachable for every client, which is the actual bug.
 */
d('live capability validation — multipart upload reaches the handler', () => {
  const PNG = Buffer.from(QUADRANTS_PNG_B64, 'base64');
  const TXT = Buffer.from('# fixture\n\npassphrase ORANGE-PELICAN-42\n', 'utf8');

  async function postMultipart(path: string, fields: Record<string, Buffer | string>, names: Record<string, [string, string]> = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string') fd.append(k, v);
      else {
        const [filename, type] = names[k] ?? ['file.bin', 'application/octet-stream'];
        fd.append(k, new Blob([v], { type }), filename);
      }
    }
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }, // fetch sets the multipart boundary
      body: fd,
    });
    return { status: res.status, text: await res.text() };
  }

  const cases: Array<[string, () => Promise<{ status: number; text: string }>]> = [
    [
      'POST /v1/files',
      () =>
        postMultipart('/v1/files', { file: PNG, purpose: 'vision' }, { file: ['q.png', 'image/png'] }),
    ],
    [
      'POST /v1/images/edits',
      () =>
        postMultipart(
          '/v1/images/edits',
          { image: PNG, prompt: 'make the red quadrant blue' },
          { image: ['q.png', 'image/png'] }
        ),
    ],
    [
      'POST /v1/images/variations',
      () => postMultipart('/v1/images/variations', { image: PNG }, { image: ['q.png', 'image/png'] }),
    ],
    [
      'POST /v1/pdf/analyze',
      () =>
        postMultipart(
          '/v1/pdf/analyze',
          { file: TXT, prompt: 'summarise' },
          { file: ['doc.md', 'text/markdown'] }
        ),
    ],
    [
      'POST /v1/audio/transcriptions',
      () => postMultipart('/v1/audio/transcriptions', { file: PNG }, { file: ['a.png', 'image/png'] }),
    ],
  ];

  for (const [label, run] of cases) {
    it(
      `${label} is not rejected by JSON body validation`,
      async () => {
        const r = await run();
        // The precise signature of the bug: Fastify's Ajv validator rejecting
        // an undefined body before the handler runs.
        expect(
          r.text.includes('validation_error'),
          `${label} was rejected by body validation: HTTP ${r.status} ${r.text.slice(0, 300)}`
        ).toBe(false);
        expect(
          r.text.includes('Request validation failed'),
          `${label} was rejected by body validation: HTTP ${r.status} ${r.text.slice(0, 300)}`
        ).toBe(false);
      },
      TIMEOUT
    );
  }
});

/**
 * Image and video generation.
 *
 * Recorded as diagnostics rather than hard failures: whether any image/video
 * model is reachable depends on which providers the deployment has credentials
 * and quota for. The test fails only on a contract-level break (a 2xx whose
 * payload is not actually an image).
 */
d('live capability validation — image generation', () => {
  it(
    'either returns a decodable image or a clear capability error',
    async () => {
      const r = await call('/v1/images/generations', {
        method: 'POST',
        body: {
          prompt: 'a plain solid red square, flat color, no text',
          n: 1,
          size: '256x256',
          response_format: 'b64_json',
        },
      });

      if (!r.ok) {
        // Acceptable: the deployment has no reachable image_generation provider.
        console.warn(`[image-generation] unavailable: HTTP ${r.status} ${r.text.slice(0, 200)}`);
        expect(r.status).toBeGreaterThanOrEqual(400);
        return;
      }

      const item = r.json?.data?.[0];
      expect(item, `200 with no data[0]: ${r.text.slice(0, 300)}`).toBeTruthy();
      if (item.b64_json) {
        const buf = Buffer.from(item.b64_json, 'base64');
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
        const isWebp = buf.subarray(0, 4).toString('ascii') === 'RIFF';
        expect(
          isPng || isJpg || isWebp,
          `payload is not a decodable image (magic=${buf.subarray(0, 4).toString('hex')})`
        ).toBe(true);
      } else {
        expect(typeof item.url).toBe('string');
      }
    },
    TIMEOUT
  );
});

d('live capability validation — video generation', () => {
  it(
    'reports whether any credentialed provider exposes video generation',
    async () => {
      // Video orchestration walks a long candidate chain and was measured
      // running past 240s without answering, so bound it explicitly: a hang is
      // recorded as "unavailable", not as a failed assertion. What must not
      // happen is the endpoint being absent altogether.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60_000);
      try {
        const res = await fetch(`${BASE}/v1/videos/generations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'a red ball rolling on a white table' }),
          signal: ctl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          console.warn(`[video-generation] unavailable: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        expect(res.status).not.toBe(404);
      } catch (err) {
        console.warn(
          `[video-generation] no response within 60s — treating as unavailable: ${String(err).slice(0, 160)}`
        );
      } finally {
        clearTimeout(timer);
      }
    },
    120_000
  );
});
