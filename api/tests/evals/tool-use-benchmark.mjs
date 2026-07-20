// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tool-Use Quality Benchmark
 *
 * Measures tool calling quality with frontier-grade metrics:
 *   - schema adherence: are tool call arguments valid JSON matching the schema?
 *   - tool selection accuracy: is the correct tool chosen for the intent?
 *   - multi-step success: for tasks requiring 2+ tool calls, are all steps correct?
 *
 * Usage:
 *   node tests/evals/tool-use-benchmark.mjs
 *   node tests/evals/tool-use-benchmark.mjs --ci --fail-threshold=0.70
 *
 * Requires: EVAL_BEARER_TOKEN env var
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// ─── CLI flags ───────────────────────────────────────────────────────────────
const isCiMode = process.argv.includes('--ci');
const failThresholdArg = process.argv.find(a => a.startsWith('--fail-threshold='));
const failThreshold = failThresholdArg ? parseFloat(failThresholdArg.split('=')[1]) : 0.70;

// ─── Token ───────────────────────────────────────────────────────────────────
let TOKEN = process.env.EVAL_BEARER_TOKEN;
if (!TOKEN) {
  const tokenFile = join(ROOT, '../../.tmp-eval-bearer-token-runtime.txt');
  if (existsSync(tokenFile)) TOKEN = readFileSync(tokenFile, 'utf8').trim();
}
if (!TOKEN) {
  console.error('ERROR: No token. Set EVAL_BEARER_TOKEN or provide .tmp-eval-bearer-token-runtime.txt');
  process.exit(1);
}

const API_BASE = process.env.EVAL_API_BASE_URL
  ? `${process.env.EVAL_API_BASE_URL}/v1/chat/completions`
  : 'https://api.ailin.one/v1/chat/completions';
const DELAY_MS = 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAPI(messages, tools, extra = {}) {
  const body = {
    model: 'auto',
    strategy: 'single',
    messages,
    tools,
    tool_choice: 'auto',
    ...extra,
  };
  const start = Date.now();
  const resp = await fetch(API_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;
  const json = await resp.json();
  return { latencyMs, status: resp.status, json };
}

function extractToolCalls(json) {
  if (json.error) return [];
  const message = json.choices?.[0]?.message;
  return message?.tool_calls ?? [];
}

// ─── Tool Definitions ────────────────────────────────────────────────────────
const TOOLS = {
  get_weather: {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name or coordinates' },
          units: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature units' },
        },
        required: ['location'],
      },
    },
  },
  search_database: {
    type: 'function',
    function: {
      name: 'search_database',
      description: 'Search records in a database table',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name to search' },
          query: { type: 'string', description: 'Search query or filter expression' },
          limit: { type: 'integer', description: 'Maximum number of results to return' },
        },
        required: ['table', 'query'],
      },
    },
  },
  send_email: {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send an email to a recipient',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Email body content' },
          cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  create_file: {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a new file with the given content',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
          overwrite: { type: 'boolean', description: 'Whether to overwrite if file exists' },
        },
        required: ['path', 'content'],
      },
    },
  },
  run_query: {
    type: 'function',
    function: {
      name: 'run_query',
      description: 'Execute a SQL query against the database',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL query to execute' },
          params: { type: 'array', items: { type: 'string' }, description: 'Parameterized query values' },
        },
        required: ['sql'],
      },
    },
  },
  calculate: {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Perform a mathematical calculation',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Mathematical expression to evaluate' },
        },
        required: ['expression'],
      },
    },
  },
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num_results: { type: 'integer', description: 'Number of results to return' },
        },
        required: ['query'],
      },
    },
  },
  schedule_meeting: {
    type: 'function',
    function: {
      name: 'schedule_meeting',
      description: 'Schedule a calendar meeting',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Meeting title' },
          datetime: { type: 'string', description: 'Meeting date and time in ISO 8601 format' },
          duration_minutes: { type: 'integer', description: 'Meeting duration in minutes' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses' },
        },
        required: ['title', 'datetime', 'duration_minutes', 'attendees'],
      },
    },
  },
};

// ─── Test Cases ──────────────────────────────────────────────────────────────

// Category 1: Single tool selection (10 cases)
const SINGLE_TOOL_CASES = [
  {
    id: 'weather_simple',
    prompt: 'What is the weather in Tokyo right now?',
    tools: [TOOLS.get_weather, TOOLS.search_database, TOOLS.web_search],
    expectedTool: 'get_weather',
    validateArgs: (args) => !!args.location && args.location.toLowerCase().includes('tokyo'),
  },
  {
    id: 'db_search',
    prompt: 'Find all users who signed up in the last 7 days.',
    tools: [TOOLS.search_database, TOOLS.get_weather, TOOLS.send_email],
    expectedTool: 'search_database',
    validateArgs: (args) => args.table === 'users' || args.table?.includes('user'),
  },
  {
    id: 'send_email_simple',
    prompt: 'Send an email to john@example.com with subject "Meeting Tomorrow" and body "Hi John, just a reminder about our meeting tomorrow at 2pm."',
    tools: [TOOLS.send_email, TOOLS.get_weather, TOOLS.create_file],
    expectedTool: 'send_email',
    validateArgs: (args) => args.to === 'john@example.com' && !!args.subject && !!args.body,
  },
  {
    id: 'create_config_file',
    prompt: 'Create a file at /etc/app/config.json with the content {"port": 3000, "host": "localhost"}',
    tools: [TOOLS.create_file, TOOLS.search_database, TOOLS.run_query],
    expectedTool: 'create_file',
    validateArgs: (args) => args.path?.includes('config.json') && !!args.content,
  },
  {
    id: 'sql_query',
    prompt: 'Run this SQL query: SELECT COUNT(*) FROM orders WHERE status = \'completed\'',
    tools: [TOOLS.run_query, TOOLS.search_database, TOOLS.calculate],
    expectedTool: 'run_query',
    validateArgs: (args) => args.sql?.toLowerCase().includes('select') && args.sql?.toLowerCase().includes('orders'),
  },
  {
    id: 'math_calculation',
    prompt: 'Calculate 15% of $2,340.50',
    tools: [TOOLS.calculate, TOOLS.web_search, TOOLS.search_database],
    expectedTool: 'calculate',
    validateArgs: (args) => !!args.expression,
  },
  {
    id: 'web_search_info',
    prompt: 'Search the web for the latest Node.js LTS version.',
    tools: [TOOLS.web_search, TOOLS.search_database, TOOLS.get_weather],
    expectedTool: 'web_search',
    validateArgs: (args) => args.query?.toLowerCase().includes('node'),
  },
  {
    id: 'weather_with_units',
    prompt: 'What is the temperature in Berlin in Fahrenheit?',
    tools: [TOOLS.get_weather, TOOLS.calculate, TOOLS.web_search],
    expectedTool: 'get_weather',
    validateArgs: (args) => args.location?.toLowerCase().includes('berlin') && args.units === 'fahrenheit',
  },
  {
    id: 'schedule_meeting',
    prompt: 'Schedule a meeting titled "Sprint Review" for tomorrow at 3pm for 60 minutes with alice@co.com and bob@co.com.',
    tools: [TOOLS.schedule_meeting, TOOLS.send_email, TOOLS.create_file],
    expectedTool: 'schedule_meeting',
    validateArgs: (args) => args.title?.includes('Sprint') && args.duration_minutes === 60 && args.attendees?.length >= 2,
  },
  {
    id: 'email_with_cc',
    prompt: 'Send an email to team@example.com about the deployment, CC dave@example.com. Subject: "Deploy Complete". Body: "The v2.1 deployment succeeded."',
    tools: [TOOLS.send_email, TOOLS.schedule_meeting, TOOLS.create_file],
    expectedTool: 'send_email',
    validateArgs: (args) => args.to === 'team@example.com' && args.cc?.length >= 1,
  },
];

// Category 2: Schema adherence edge cases (10 cases)
const SCHEMA_ADHERENCE_CASES = [
  {
    id: 'required_fields_only',
    prompt: 'Search the orders table for cancelled orders.',
    tools: [TOOLS.search_database],
    expectedTool: 'search_database',
    validateArgs: (args) => typeof args.table === 'string' && typeof args.query === 'string',
    schemaChecks: (args) => {
      const checks = [];
      checks.push({ field: 'table', valid: typeof args.table === 'string', actual: typeof args.table });
      checks.push({ field: 'query', valid: typeof args.query === 'string', actual: typeof args.query });
      if (args.limit !== undefined) {
        checks.push({ field: 'limit', valid: typeof args.limit === 'number' && Number.isInteger(args.limit), actual: typeof args.limit });
      }
      return checks;
    },
  },
  {
    id: 'enum_compliance',
    prompt: 'Get the weather in London in celsius.',
    tools: [TOOLS.get_weather],
    expectedTool: 'get_weather',
    validateArgs: (args) => args.units === 'celsius' || args.units === 'fahrenheit' || args.units === undefined,
    schemaChecks: (args) => [{
      field: 'units',
      valid: args.units === undefined || ['celsius', 'fahrenheit'].includes(args.units),
      actual: args.units,
    }],
  },
  {
    id: 'array_field',
    prompt: 'Email the quarterly report to finance@co.com, CC the CEO at ceo@co.com and CFO at cfo@co.com.',
    tools: [TOOLS.send_email],
    expectedTool: 'send_email',
    validateArgs: (args) => Array.isArray(args.cc) && args.cc.length >= 2,
    schemaChecks: (args) => [{
      field: 'cc',
      valid: Array.isArray(args.cc) && args.cc.every(item => typeof item === 'string'),
      actual: Array.isArray(args.cc) ? `array[${args.cc.length}]` : typeof args.cc,
    }],
  },
  {
    id: 'integer_field',
    prompt: 'Search the products table for electronics and return at most 5 results.',
    tools: [TOOLS.search_database],
    expectedTool: 'search_database',
    validateArgs: (args) => typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit === 5,
    schemaChecks: (args) => [{
      field: 'limit',
      valid: typeof args.limit === 'number' && Number.isInteger(args.limit),
      actual: `${typeof args.limit}: ${args.limit}`,
    }],
  },
  {
    id: 'boolean_field',
    prompt: 'Create a new file at /tmp/output.txt with content "Hello World" and overwrite if it exists.',
    tools: [TOOLS.create_file],
    expectedTool: 'create_file',
    validateArgs: (args) => args.overwrite === true,
    schemaChecks: (args) => [{
      field: 'overwrite',
      valid: typeof args.overwrite === 'boolean',
      actual: `${typeof args.overwrite}: ${args.overwrite}`,
    }],
  },
  {
    id: 'sql_params',
    prompt: 'Run a parameterized query: SELECT * FROM users WHERE email = $1 with parameter "test@example.com"',
    tools: [TOOLS.run_query],
    expectedTool: 'run_query',
    validateArgs: (args) => !!args.sql && Array.isArray(args.params) && args.params.length >= 1,
    schemaChecks: (args) => [{
      field: 'params',
      valid: Array.isArray(args.params) && args.params.every(p => typeof p === 'string'),
      actual: Array.isArray(args.params) ? `array[${args.params.length}]` : typeof args.params,
    }],
  },
  {
    id: 'no_extra_fields',
    prompt: 'Get weather in Paris.',
    tools: [TOOLS.get_weather],
    expectedTool: 'get_weather',
    validateArgs: (args) => !!args.location,
    schemaChecks: (args) => {
      const allowed = ['location', 'units'];
      const extras = Object.keys(args).filter(k => !allowed.includes(k));
      return [{ field: 'no_extra', valid: extras.length === 0, actual: extras.length ? extras.join(', ') : 'none' }];
    },
  },
  {
    id: 'meeting_all_required',
    prompt: 'Book a 30-minute sync with dev@co.com titled "1:1" at 2026-04-01T10:00:00Z.',
    tools: [TOOLS.schedule_meeting],
    expectedTool: 'schedule_meeting',
    validateArgs: (args) => !!args.title && !!args.datetime && typeof args.duration_minutes === 'number' && Array.isArray(args.attendees),
    schemaChecks: (args) => {
      return ['title', 'datetime', 'duration_minutes', 'attendees'].map(field => ({
        field,
        valid: args[field] !== undefined && args[field] !== null,
        actual: args[field] !== undefined ? typeof args[field] : 'missing',
      }));
    },
  },
  {
    id: 'iso_datetime_format',
    prompt: 'Schedule a meeting called "Standup" at 9am UTC on March 25, 2026 for 15 minutes with team@co.com.',
    tools: [TOOLS.schedule_meeting],
    expectedTool: 'schedule_meeting',
    validateArgs: (args) => !!args.datetime && /\d{4}-\d{2}-\d{2}/.test(args.datetime),
    schemaChecks: (args) => [{
      field: 'datetime_format',
      valid: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(args.datetime ?? ''),
      actual: args.datetime,
    }],
  },
  {
    id: 'nested_json_content',
    prompt: 'Create a file at /config/db.json with this content: {"host":"db.local","port":5432,"ssl":true}',
    tools: [TOOLS.create_file],
    expectedTool: 'create_file',
    validateArgs: (args) => {
      try { JSON.parse(args.content); return true; } catch { return typeof args.content === 'string' && args.content.includes('host'); }
    },
    schemaChecks: (args) => [{
      field: 'content_valid_json',
      valid: (() => { try { JSON.parse(args.content); return true; } catch { return false; } })(),
      actual: args.content?.slice(0, 50),
    }],
  },
];

// Category 3: Multi-step tool chains (10 cases)
const MULTI_STEP_CASES = [
  {
    id: 'search_then_email',
    prompt: 'Find all overdue invoices in the database and email a summary to billing@example.com.',
    tools: [TOOLS.search_database, TOOLS.send_email, TOOLS.get_weather],
    expectedTools: ['search_database', 'send_email'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('search_database') && names.includes('send_email');
    },
  },
  {
    id: 'calculate_then_email',
    prompt: 'Calculate the total of 1250 + 3780 + 945, then email the result to finance@co.com with subject "Monthly Total".',
    tools: [TOOLS.calculate, TOOLS.send_email, TOOLS.web_search],
    expectedTools: ['calculate', 'send_email'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('calculate') && names.includes('send_email');
    },
  },
  {
    id: 'query_then_file',
    prompt: 'Run SELECT * FROM config WHERE env = \'production\' and save the results to /tmp/prod-config.json.',
    tools: [TOOLS.run_query, TOOLS.create_file, TOOLS.send_email],
    expectedTools: ['run_query', 'create_file'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('run_query') && names.includes('create_file');
    },
  },
  {
    id: 'search_calculate_email',
    prompt: 'Search the sales table for Q1 2026 revenue, calculate the 15% tax on the total, and email the tax amount to accounting@co.com.',
    tools: [TOOLS.search_database, TOOLS.calculate, TOOLS.send_email, TOOLS.get_weather],
    expectedTools: ['search_database', 'calculate', 'send_email'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('search_database') && names.includes('calculate') && names.includes('send_email');
    },
  },
  {
    id: 'weather_then_schedule',
    prompt: 'Check the weather in New York and if possible schedule an outdoor team event called "Team Picnic" at 2026-04-15T12:00:00Z for 120 minutes with the team (team@co.com).',
    tools: [TOOLS.get_weather, TOOLS.schedule_meeting, TOOLS.send_email],
    expectedTools: ['get_weather', 'schedule_meeting'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('get_weather') && names.includes('schedule_meeting');
    },
  },
  {
    id: 'web_search_then_file',
    prompt: 'Search the web for "TypeScript 5.4 release notes" and save a summary to /docs/ts54-notes.md.',
    tools: [TOOLS.web_search, TOOLS.create_file, TOOLS.calculate],
    expectedTools: ['web_search', 'create_file'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('web_search') && names.includes('create_file');
    },
  },
  {
    id: 'db_then_email_then_file',
    prompt: 'Get all error logs from the last hour, email a summary to ops@co.com, and save the full dump to /tmp/error-dump.json.',
    tools: [TOOLS.search_database, TOOLS.send_email, TOOLS.create_file, TOOLS.get_weather],
    expectedTools: ['search_database', 'send_email', 'create_file'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('search_database') && names.includes('send_email') && names.includes('create_file');
    },
  },
  {
    id: 'dual_weather',
    prompt: 'Get the weather in both Tokyo (celsius) and New York (fahrenheit) so we can compare them.',
    tools: [TOOLS.get_weather, TOOLS.calculate, TOOLS.web_search],
    expectedTools: ['get_weather', 'get_weather'],
    validateSequence: (calls) => {
      const weatherCalls = calls.filter(c => c.function.name === 'get_weather');
      return weatherCalls.length >= 2;
    },
  },
  {
    id: 'query_and_backup',
    prompt: 'First, run "SELECT version()" to check the database version. Then create a backup note at /tmp/db-check.txt with the query result.',
    tools: [TOOLS.run_query, TOOLS.create_file, TOOLS.send_email],
    expectedTools: ['run_query', 'create_file'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      const queryIdx = names.indexOf('run_query');
      const fileIdx = names.indexOf('create_file');
      return queryIdx >= 0 && fileIdx >= 0;
    },
  },
  {
    id: 'schedule_and_notify',
    prompt: 'Schedule a "Retrospective" meeting for 2026-04-20T14:00:00Z, 90 minutes, with team@co.com and manager@co.com. Then email all attendees a confirmation with the meeting details.',
    tools: [TOOLS.schedule_meeting, TOOLS.send_email, TOOLS.web_search],
    expectedTools: ['schedule_meeting', 'send_email'],
    validateSequence: (calls) => {
      const names = calls.map(c => c.function.name);
      return names.includes('schedule_meeting') && names.includes('send_email');
    },
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────
async function runToolBenchmark() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       TOOL-USE QUALITY BENCHMARK                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  const totalCases = SINGLE_TOOL_CASES.length + SCHEMA_ADHERENCE_CASES.length + MULTI_STEP_CASES.length;
  console.log(`Cases: ${totalCases} | Fail threshold: ${(failThreshold * 100).toFixed(0)}%\n`);

  const results = [];

  // ── Single tool selection ──
  console.log('─── SINGLE TOOL SELECTION ───');
  for (let i = 0; i < SINGLE_TOOL_CASES.length; i++) {
    const tc = SINGLE_TOOL_CASES[i];
    process.stdout.write(`[${i + 1}/${SINGLE_TOOL_CASES.length}] ${tc.id.padEnd(25)} ... `);
    try {
      const { latencyMs, status, json } = await callAPI(
        [{ role: 'user', content: tc.prompt }],
        tc.tools,
      );
      const toolCalls = extractToolCalls(json);
      const firstCall = toolCalls[0];

      const toolSelected = firstCall?.function?.name ?? null;
      const selectionCorrect = toolSelected === tc.expectedTool;

      let argsValid = false;
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(firstCall?.function?.arguments ?? '{}');
        argsValid = tc.validateArgs(parsedArgs);
      } catch { argsValid = false; }

      results.push({
        category: 'single_selection', caseId: tc.id, status, latencyMs,
        toolSelected, expectedTool: tc.expectedTool, selectionCorrect,
        argsValid, parsedArgs,
      });

      const icon = selectionCorrect && argsValid ? '✓' : '✗';
      console.log(`${icon} tool=${toolSelected ?? 'NONE'} correct=${selectionCorrect} args=${argsValid} | ${latencyMs}ms`);
    } catch (e) {
      console.log(`EXCEPTION: ${e.message}`);
      results.push({ category: 'single_selection', caseId: tc.id, status: 0, selectionCorrect: false, argsValid: false });
    }
    await sleep(DELAY_MS);
  }

  // ── Schema adherence ──
  console.log('\n─── SCHEMA ADHERENCE ───');
  for (let i = 0; i < SCHEMA_ADHERENCE_CASES.length; i++) {
    const tc = SCHEMA_ADHERENCE_CASES[i];
    process.stdout.write(`[${i + 1}/${SCHEMA_ADHERENCE_CASES.length}] ${tc.id.padEnd(25)} ... `);
    try {
      const { latencyMs, status, json } = await callAPI(
        [{ role: 'user', content: tc.prompt }],
        tc.tools,
      );
      const toolCalls = extractToolCalls(json);
      const firstCall = toolCalls[0];
      const toolSelected = firstCall?.function?.name ?? null;
      const selectionCorrect = toolSelected === tc.expectedTool;

      let parsedArgs = {};
      let parseSuccess = false;
      try {
        parsedArgs = JSON.parse(firstCall?.function?.arguments ?? '{}');
        parseSuccess = true;
      } catch { parseSuccess = false; }

      const schemaChecks = tc.schemaChecks ? tc.schemaChecks(parsedArgs) : [];
      const allSchemaValid = parseSuccess && schemaChecks.every(c => c.valid);

      results.push({
        category: 'schema_adherence', caseId: tc.id, status, latencyMs,
        toolSelected, selectionCorrect, parseSuccess, allSchemaValid,
        schemaChecks, parsedArgs,
      });

      const icon = selectionCorrect && allSchemaValid ? '✓' : '✗';
      const failedChecks = schemaChecks.filter(c => !c.valid);
      console.log(`${icon} schema=${allSchemaValid} checks=${schemaChecks.length - failedChecks.length}/${schemaChecks.length} | ${latencyMs}ms${failedChecks.length ? ' FAIL: ' + failedChecks.map(c => c.field).join(', ') : ''}`);
    } catch (e) {
      console.log(`EXCEPTION: ${e.message}`);
      results.push({ category: 'schema_adherence', caseId: tc.id, status: 0, allSchemaValid: false, selectionCorrect: false });
    }
    await sleep(DELAY_MS);
  }

  // ── Multi-step ──
  console.log('\n─── MULTI-STEP TOOL CHAINS ───');
  for (let i = 0; i < MULTI_STEP_CASES.length; i++) {
    const tc = MULTI_STEP_CASES[i];
    process.stdout.write(`[${i + 1}/${MULTI_STEP_CASES.length}] ${tc.id.padEnd(25)} ... `);
    try {
      const { latencyMs, status, json } = await callAPI(
        [{ role: 'user', content: tc.prompt }],
        tc.tools,
      );
      const toolCalls = extractToolCalls(json);
      const sequenceValid = tc.validateSequence(toolCalls);
      const callNames = toolCalls.map(c => c.function?.name ?? 'unknown');

      // Check all args parse as valid JSON
      let allArgsParseable = true;
      for (const call of toolCalls) {
        try { JSON.parse(call.function?.arguments ?? '{}'); } catch { allArgsParseable = false; }
      }

      results.push({
        category: 'multi_step', caseId: tc.id, status, latencyMs,
        callCount: toolCalls.length, expectedTools: tc.expectedTools,
        actualTools: callNames, sequenceValid, allArgsParseable,
      });

      const icon = sequenceValid && allArgsParseable ? '✓' : '✗';
      console.log(`${icon} calls=${toolCalls.length} expected=${tc.expectedTools.length} seq=${sequenceValid} tools=[${callNames.join(',')}] | ${latencyMs}ms`);
    } catch (e) {
      console.log(`EXCEPTION: ${e.message}`);
      results.push({ category: 'multi_step', caseId: tc.id, status: 0, sequenceValid: false, allArgsParseable: false, callCount: 0 });
    }
    await sleep(DELAY_MS);
  }

  return results;
}

// ─── Aggregate ───────────────────────────────────────────────────────────────
function aggregate(results) {
  const singleResults = results.filter(r => r.category === 'single_selection');
  const schemaResults = results.filter(r => r.category === 'schema_adherence');
  const multiResults = results.filter(r => r.category === 'multi_step');

  const selectionAccuracy = singleResults.length
    ? singleResults.filter(r => r.selectionCorrect).length / singleResults.length
    : 0;

  const argsAccuracy = singleResults.length
    ? singleResults.filter(r => r.argsValid).length / singleResults.length
    : 0;

  const schemaAdherence = schemaResults.length
    ? schemaResults.filter(r => r.allSchemaValid).length / schemaResults.length
    : 0;

  const multiStepSuccess = multiResults.length
    ? multiResults.filter(r => r.sequenceValid).length / multiResults.length
    : 0;

  const multiStepArgsParseable = multiResults.length
    ? multiResults.filter(r => r.allArgsParseable).length / multiResults.length
    : 0;

  // Composite: 25% selection + 25% schema + 25% args + 25% multi-step
  const compositeScore = 0.25 * selectionAccuracy + 0.25 * schemaAdherence + 0.25 * argsAccuracy + 0.25 * multiStepSuccess;

  return {
    totalCases: results.length,
    selectionAccuracy,
    argsAccuracy,
    schemaAdherence,
    multiStepSuccess,
    multiStepArgsParseable,
    compositeScore,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
const results = await runToolBenchmark();
const summary = aggregate(results);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

// ─── Print summary ───────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log('TOOL-USE QUALITY SUMMARY');
console.log('═'.repeat(60));
console.log(`  Tool Selection Accuracy:   ${(summary.selectionAccuracy * 100).toFixed(1)}%`);
console.log(`  Argument Accuracy:         ${(summary.argsAccuracy * 100).toFixed(1)}%`);
console.log(`  Schema Adherence:          ${(summary.schemaAdherence * 100).toFixed(1)}%`);
console.log(`  Multi-Step Success:        ${(summary.multiStepSuccess * 100).toFixed(1)}%`);
console.log(`  Multi-Step Args Parseable: ${(summary.multiStepArgsParseable * 100).toFixed(1)}%`);
console.log(`  Composite Score:           ${(summary.compositeScore * 100).toFixed(1)}%`);

// ─── Save results ────────────────────────────────────────────────────────────
const outDir = join(ROOT, 'eval-results');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `tool-use-benchmark-${timestamp}.json`);
writeFileSync(outPath, JSON.stringify({ timestamp, summary, cases: results }, null, 2));
console.log(`\nFull results saved to: ${outPath}`);

// ─── CI gate ─────────────────────────────────────────────────────────────────
if (isCiMode) {
  const pass = summary.compositeScore >= failThreshold;
  if (pass) {
    console.log(`\n✅ Tool-use composite score ${(summary.compositeScore * 100).toFixed(1)}% >= threshold ${(failThreshold * 100).toFixed(0)}%`);
    process.exit(0);
  } else {
    console.error(`\n❌ TOOL-USE REGRESSION: Composite score ${(summary.compositeScore * 100).toFixed(1)}% < threshold ${(failThreshold * 100).toFixed(0)}%`);
    process.exit(1);
  }
}
