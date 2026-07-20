// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const REPORTS_DIR = path.resolve(ROOT, 'reports');
const BASE_URL = process.env.API_BASE_URL || 'https://api.ailin.one';
const AUTH_BEARER_TOKEN =
  process.env.ENDPOINT_SWEEP_BEARER_TOKEN ||
  process.env.AILIN_EVAL_BEARER_TOKEN ||
  process.env.AILIN_TOKEN ||
  '';
const AUTH_API_KEY =
  process.env.ENDPOINT_SWEEP_API_KEY || process.env.AILIN_EVAL_API_KEY || process.env.AILIN_API_KEY || '';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO4BCuEAAAAASUVORK5CYII=';
const WAV_BASE64 =
  'UklGRmQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAAAAAAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8=';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function headers() {
  const out = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (AUTH_BEARER_TOKEN) out.Authorization = `Bearer ${AUTH_BEARER_TOKEN}`;
  if (AUTH_API_KEY) out['X-API-Key'] = AUTH_API_KEY;
  return out;
}

async function requestJson(method, urlPath, body) {
  const response = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    body: json,
    rawText: text,
    requestId: response.headers.get('x-request-id') || null,
  };
}

function capabilityPayload(capability) {
  if (capability === 'embeddings' || capability === 'embedding') {
    return { input: 'capability matrix probe sentence' };
  }
  if (
    capability === 'speech_to_text' ||
    capability === 'transcription' ||
    capability === 'audio_input' ||
    capability === 'listen' ||
    capability === 'diarization' ||
    capability === 'video_to_text' ||
    capability === 'video_transcription'
  ) {
    return { audio_base64: WAV_BASE64, filename: 'probe.wav' };
  }
  if (capability === 'text_to_speech' || capability === 'tts' || capability === 'audio_generation') {
    return { input: 'Ailin capability matrix probe.' };
  }
  if (capability === 'image_generation') {
    return { prompt: 'Minimal blue geometric icon on white background.' };
  }
  if (capability === 'image_editing') {
    return { prompt: 'Increase contrast and sharpen edges.', image_base64: PNG_1X1_BASE64 };
  }
  if (
    capability === 'code_generation' ||
    capability === 'code_completion' ||
    capability === 'coding' ||
    capability === 'code_review' ||
    capability === 'debugging' ||
    capability === 'refactoring' ||
    capability === 'testing' ||
    capability === 'code_interpreter' ||
    capability === 'computer_use' ||
    capability === 'agents' ||
    capability === 'mcp'
  ) {
    return {
      code: 'def add(a, b):\n    return a + b',
      language: 'python',
      functionName: 'add',
      tests: [{ args: [2, 3], expected: 5 }],
    };
  }
  if (
    capability === 'web_search' ||
    capability === 'deep_search' ||
    capability === 'deep_research' ||
    capability === 'file_search' ||
    capability === 'research'
  ) {
    return { query: 'Ailin Collective Intelligence platform capabilities' };
  }
  return {
    messages: [{ role: 'user', content: 'Respond only with: capability_probe_ok' }],
  };
}

function markdownReport(summary, rows) {
  const lines = [];
  lines.push('# Capability Matrix Evidence');
  lines.push('');
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Base URL: ${summary.baseUrl}`);
  lines.push(`- Total capabilities: ${summary.total}`);
  lines.push(`- Execute pass: ${summary.executePass}/${summary.executeTotal}`);
  lines.push(`- Health operational: ${summary.healthOperational}/${summary.total}`);
  lines.push(`- Stream pass: ${summary.streamPass}/${summary.streamTotal}`);
  lines.push('');
  lines.push('| Capability | Execute | Stream | Health | Provider | Model | Request ID |');
  lines.push('|---|---:|---:|---:|---|---|---|');
  for (const row of rows) {
    lines.push(
      `| ${row.capability} | ${row.executeStatus} | ${row.streamStatus} | ${row.healthStatus} | ${row.provider || '-'} | ${row.model || '-'} | ${row.requestId || '-'} |`
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  if (!AUTH_BEARER_TOKEN && !AUTH_API_KEY) {
    throw new Error('Missing auth credentials. Set ENDPOINT_SWEEP_BEARER_TOKEN and/or ENDPOINT_SWEEP_API_KEY');
  }

  const listResponse = await requestJson('GET', '/v1/capabilities');
  if (!listResponse.ok || !listResponse.body || !Array.isArray(listResponse.body.data)) {
    throw new Error(`Failed to list capabilities: HTTP ${listResponse.status}`);
  }

  const capabilities = listResponse.body.data;
  const rows = [];

  for (const item of capabilities) {
    const capability = item.id;
    const supportsExecute = item.supportsExecute !== false;
    const supportsStream = item.supportsStream === true;
    const payload = capabilityPayload(capability);

    let executeStatus = 0;
    let streamStatus = 0;
    let healthStatus = 0;
    let provider = null;
    let model = null;
    let requestId = null;

    if (supportsExecute) {
      const executeResponse = await requestJson('POST', `/v1/capabilities/${encodeURIComponent(capability)}/execute`, payload);
      executeStatus = executeResponse.status;
      provider = executeResponse.body?._ailin?.resolved_provider || null;
      model = executeResponse.body?._ailin?.resolved_model || null;
      requestId = executeResponse.body?._ailin?.request_id || executeResponse.requestId;
    }

    if (supportsStream) {
      const streamPayload = {
        messages: [{ role: 'user', content: 'Stream test: output exactly OK' }],
      };
      const streamResponse = await requestJson('POST', `/v1/capabilities/${encodeURIComponent(capability)}/stream`, streamPayload);
      streamStatus = streamResponse.status;
    }

    const healthResponse = await requestJson('GET', `/v1/capabilities/${encodeURIComponent(capability)}/health`);
    healthStatus = healthResponse.status;

    rows.push({
      capability,
      executeStatus: supportsExecute ? executeStatus : 0,
      streamStatus: supportsStream ? streamStatus : 0,
      healthStatus,
      operational: Boolean(healthResponse.body?.operational),
      provider,
      model,
      requestId,
      supportsExecute,
      supportsStream,
    });
  }

  const executeRows = rows.filter((row) => row.supportsExecute);
  const streamRows = rows.filter((row) => row.supportsStream);
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    total: rows.length,
    executeTotal: executeRows.length,
    executePass: executeRows.filter((row) => row.executeStatus >= 200 && row.executeStatus < 300).length,
    streamTotal: streamRows.length,
    streamPass: streamRows.filter((row) => row.streamStatus >= 200 && row.streamStatus < 300).length,
    healthOperational: rows.filter((row) => row.operational).length,
  };

  const report = {
    summary,
    rows,
  };

  ensureDir(REPORTS_DIR);
  const timestamp = summary.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(REPORTS_DIR, `capability-matrix-${timestamp}.json`);
  const latestJsonPath = path.join(REPORTS_DIR, 'capability-matrix-latest.json');
  const mdPath = path.join(REPORTS_DIR, `capability-evidence-${timestamp}.md`);
  const latestMdPath = path.join(REPORTS_DIR, 'capability-evidence-latest.md');

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, markdownReport(summary, rows), 'utf8');
  fs.writeFileSync(latestMdPath, markdownReport(summary, rows), 'utf8');

  console.log(
    JSON.stringify(
      {
        generated: true,
        summary,
        latestJson: path.relative(ROOT, latestJsonPath),
        latestMd: path.relative(ROOT, latestMdPath),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    total: 0,
    executeTotal: 0,
    executePass: 0,
    streamTotal: 0,
    streamPass: 0,
    healthOperational: 0,
    error: message,
  };
  const report = { summary, rows: [] };

  ensureDir(REPORTS_DIR);
  const timestamp = summary.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(REPORTS_DIR, `capability-matrix-${timestamp}.json`);
  const latestJsonPath = path.join(REPORTS_DIR, 'capability-matrix-latest.json');
  const mdPath = path.join(REPORTS_DIR, `capability-evidence-${timestamp}.md`);
  const latestMdPath = path.join(REPORTS_DIR, 'capability-evidence-latest.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    mdPath,
    `# Capability Matrix Evidence\n\n- Generated: ${summary.generatedAt}\n- Base URL: ${summary.baseUrl}\n- Error: ${summary.error}\n`,
    'utf8'
  );
  fs.writeFileSync(
    latestMdPath,
    `# Capability Matrix Evidence\n\n- Generated: ${summary.generatedAt}\n- Base URL: ${summary.baseUrl}\n- Error: ${summary.error}\n`,
    'utf8'
  );

  console.error(message);
  process.exitCode = 1;
});
