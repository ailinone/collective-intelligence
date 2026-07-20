// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import {
  OUTPUT_DIR,
  ensureOutputDir,
  getApiKey,
  getApiBaseUrl,
  getBearerToken,
  requestJsonWithTimeout,
  writeJsonFile,
} from './enterprise-eval-shared';

interface PreflightCheck {
  name: string;
  pass: boolean;
  details: Record<string, unknown>;
}

interface SafeHttpResult {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
  error?: string;
}

const execFile = promisify(execFileCb);

const REQUIRED_SECRET_OPTIONS: readonly (readonly string[])[] = [
  ['database-url'],
  ['jwt-secret'],
  ['redis-password'],
  ['openai-key', 'openai-api-key'],
  ['anthropic-key', 'anthropic-api-key'],
  ['google-key', 'google-api-key'],
  ['deepseek-key', 'deepseek-api-key'],
  ['xai-key', 'xai-api-key'],
  ['mistral-key', 'mistral-api-key'],
  ['cohere-key', 'cohere-api-key'],
  ['nvidia-key', 'nvidia-api-key', 'nvidia-hub-key', 'nvidia-hub-api-key'],
  ['aihubmix-key', 'aihubmix-api-key'],
  ['novita-key', 'novita-api-key'],
  ['moonshot-key', 'moonshot-api-key'],
  ['minimax-key', 'minimax-api-key'],
  ['jina-key', 'jina-api-key'],
  ['friendli-key', 'friendli-api-key'],
  ['aiml-key', 'aiml-api-key'],
  ['imagerouter-key', 'imagerouter-api-key'],
  ['openrouter-key', 'openrouter-api-key'],
  ['orqai-key', 'orqai-api-key'],
  ['edenai-key', 'edenai-api-key'],
  ['heliconeai-key', 'heliconeai-api-key'],
  ['vertex-key', 'vertex-ai-api-key'],
];
const PRODUCTION_SAFE_GCP_CREDENTIAL_TYPES = ['service_account', 'external_account'] as const;

function configureGoogleApiProxyBypass(): void {
  const noProxyHosts = [
    '127.0.0.1',
    'localhost',
    '.googleapis.com',
    'googleapis.com',
    '.google.com',
    'metadata.google.internal',
  ];
  const existingNoProxy = [process.env.NO_PROXY, process.env.no_proxy]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const mergedNoProxy = Array.from(new Set([...existingNoProxy, ...noProxyHosts])).join(',');
  process.env.NO_PROXY = mergedNoProxy;
  process.env.no_proxy = mergedNoProxy;

  const proxyVars = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'GRPC_PROXY',
    'grpc_proxy',
  ] as const;

  for (const key of proxyVars) {
    const raw = process.env[key];
    if (!raw) {
      continue;
    }
    const parsed = parseProxyUrl(raw);
    if (!parsed) {
      continue;
    }
    const host = parsed.hostname.trim().toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')) {
      delete process.env[key];
    }
  }
}

function parseProxyUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed);
    }
    return new URL(`http://${trimmed}`);
  } catch {
    return null;
  }
}

function parseSecretResourceName(rawName: string): string | null {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return null;
  }

  const marker = '/secrets/';
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex === -1) {
    return trimmed;
  }

  const secretAndSuffix = trimmed.slice(markerIndex + marker.length);
  return secretAndSuffix.replace(/\/versions\/[^/]+$/, '');
}

function computeMissingRequiredSecrets(normalizedExisting: string[]): string[] {
  const existingSet = new Set(normalizedExisting);
  return REQUIRED_SECRET_OPTIONS
    .filter((options) => !options.some((name) => existingSet.has(name)))
    .map((options) => options.join(' | '));
}

async function checkGcpCredentialMode(): Promise<PreflightCheck> {
  const inspected = await inspectGcpCredentialSource();
  const allowAuthorizedUserRuntime =
    (process.env.GCP_ALLOW_AUTHORIZED_USER_RUNTIME || '').trim().toLowerCase() === 'true';
  if (!inspected.type) {
    return {
      name: 'gcp_credentials_mode',
      pass: true,
      details: {
        credentialType: 'unknown',
        source: inspected.source || 'ambient-adc',
        note:
          'No explicit credentials file/json was detected. Runtime may rely on ambient ADC metadata (WIF/service account).',
        supportedProductionTypes: PRODUCTION_SAFE_GCP_CREDENTIAL_TYPES,
      },
    };
  }

  const normalized = inspected.type.trim().toLowerCase();
  const productionSafeType = PRODUCTION_SAFE_GCP_CREDENTIAL_TYPES.includes(
    normalized as (typeof PRODUCTION_SAFE_GCP_CREDENTIAL_TYPES)[number]
  );
  const authorizedUserWithOverride =
    normalized === 'authorized_user' && allowAuthorizedUserRuntime;
  const pass = productionSafeType || authorizedUserWithOverride;

  return {
    name: 'gcp_credentials_mode',
    pass,
    details: {
      source: inspected.source || 'unknown',
      credentialType: normalized,
      supportedProductionTypes: PRODUCTION_SAFE_GCP_CREDENTIAL_TYPES,
      reason: pass
        ? authorizedUserWithOverride
          ? 'Credential type is authorized_user with explicit runtime override enabled (temporary mode).'
          : 'Credential type is compatible with production non-interactive execution.'
        : 'Credential type is interactive-only and is not reliable for production runtimes.',
      temporaryOverrideActive: authorizedUserWithOverride || undefined,
      guidance: pass
        ? authorizedUserWithOverride
          ? 'Rotate to service_account or external_account (WIF) when org policy allows it.'
          : undefined
        : 'Use service_account JSON or external_account (WIF). Avoid authorized_user in production.',
      parseError: inspected.error,
    },
  };
}

async function inspectGcpCredentialSource(): Promise<{
  source?: string;
  type?: string;
  error?: string;
}> {
  const credentialsJson = process.env.GCP_SECRETS_CREDENTIALS_JSON;
  if (credentialsJson) {
    try {
      const parsed = JSON.parse(credentialsJson) as { type?: string };
      return { source: 'GCP_SECRETS_CREDENTIALS_JSON', type: parsed.type };
    } catch (error) {
      return {
        source: 'GCP_SECRETS_CREDENTIALS_JSON',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const candidates = getCredentialFileCandidates();
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate.path, 'utf8');
      const parsed = JSON.parse(raw) as { type?: string };
      return { source: candidate.source, type: parsed.type };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT') || message.includes('no such file')) {
        continue;
      }
      return { source: candidate.source, error: message };
    }
  }

  return {};
}

function getCredentialFileCandidates(): Array<{ source: string; path: string }> {
  const configured = [
    ['GCP_SECRETS_CREDENTIALS_FILE', process.env.GCP_SECRETS_CREDENTIALS_FILE],
    ['GCP_CREDENTIALS_PATH', process.env.GCP_CREDENTIALS_PATH],
    ['GOOGLE_APPLICATION_CREDENTIALS', process.env.GOOGLE_APPLICATION_CREDENTIALS],
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([source, value]) => ({ source, path: path.resolve(value) }));

  const defaultAdcPath =
    process.platform === 'win32'
      ? path.resolve(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
      : path.resolve(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');

  const unique = new Map<string, { source: string; path: string }>();
  for (const candidate of [...configured, { source: 'ADC_DEFAULT_PATH', path: defaultAdcPath }]) {
    if (!unique.has(candidate.path)) {
      unique.set(candidate.path, candidate);
    }
  }
  return Array.from(unique.values());
}

function expectedResolvedCanonicalStrategy(
  strategy: string
): string | undefined {
  switch (strategy) {
    case 'single':
      return 'single';
    case 'cost':
      return 'cost';
    case 'quality':
      return 'quality_multipass';
    case 'parallel':
      return 'parallel';
    case 'debate':
      return 'debate';
    default:
      return undefined;
  }
}

async function safeRequestJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<SafeHttpResult> {
  try {
    const response = await requestJsonWithTimeout(url, init, timeoutMs);
    return {
      ok: true,
      status: response.status,
      json: response.json,
      text: response.text,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildAuthHeaders(token: string, apiKey: string): Record<string, string> {
  if (apiKey) {
    return { 'x-api-key': apiKey };
  }
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function checkAuthCredential(
  baseUrl: string,
  token: string,
  apiKey: string
): Promise<PreflightCheck> {
  const validResponse = await safeRequestJsonWithTimeout(
    `${baseUrl}/v1/auth/api-keys`,
    {
      method: 'GET',
      headers: buildAuthHeaders(token, apiKey),
    },
    10_000
  );

  const invalidHeaders = apiKey
    ? { 'x-api-key': 'ak_live_invalid_preflight' }
    : { Authorization: 'Bearer invalid-preflight-token' };
  const invalidResponse = await safeRequestJsonWithTimeout(
    `${baseUrl}/v1/auth/api-keys`,
    {
      method: 'GET',
      headers: invalidHeaders,
    },
    10_000
  );

  const validPass =
    validResponse.ok &&
    validResponse.status >= 200 &&
    validResponse.status < 300;
  const invalidPass =
    invalidResponse.ok &&
    (invalidResponse.status === 401 || invalidResponse.status === 403);

  return {
    name: 'eval_auth_credential_validation',
    pass: validPass && invalidPass,
    details: {
      authMode: apiKey ? 'api_key' : 'bearer',
      validStatus: validResponse.status,
      invalidStatus: invalidResponse.status,
      validError: validResponse.error,
      invalidError: invalidResponse.error,
      validBodySample:
        validResponse.text.length > 200
          ? `${validResponse.text.slice(0, 200)}...`
          : validResponse.text,
    },
  };
}

async function checkGcpSecretsInventory(): Promise<PreflightCheck> {
  const projectId =
    process.env.GCP_SECRETS_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    '';
  const prefix = process.env.GCP_SECRETS_PREFIX || 'app';

  if (!projectId) {
    return {
      name: 'gcp_secrets_inventory',
      pass: false,
      details: {
        reason: 'Missing GCP project configuration (GCP_SECRETS_PROJECT_ID/GCP_PROJECT_ID/GOOGLE_CLOUD_PROJECT).',
      },
    };
  }

  try {
    configureGoogleApiProxyBypass();
    const client = new SecretManagerServiceClient();
    const parent = `projects/${projectId}`;
    const [secrets] = await client.listSecrets({ parent });
    let existing = (secrets || [])
      .map((entry) => parseSecretResourceName(entry.name || ''))
      .filter((name): name is string => Boolean(name));

    if (existing.length === 0) {
      const gcloudFallback = await listSecretsWithGcloud(projectId);
      if (gcloudFallback && gcloudFallback.length > 0) {
        existing = gcloudFallback;
      }
    }

    const normalizedExisting = existing.map((name) =>
      name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name
    );
    const missing = computeMissingRequiredSecrets(normalizedExisting);

    return {
      name: 'gcp_secrets_inventory',
      pass: missing.length === 0,
      details: {
        projectId,
        prefix,
        expectedCount: REQUIRED_SECRET_OPTIONS.length,
        foundCount: existing.length,
        source: existing.length > 0 ? 'gcp-sdk-or-gcloud-fallback' : 'gcp-sdk',
        missing,
      },
    };
  } catch (error) {
    const gcloudFallback = await listSecretsWithGcloud(projectId);
    if (gcloudFallback && gcloudFallback.length > 0) {
      const normalizedExisting = gcloudFallback.map((name) =>
        name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name
      );
      const missing = computeMissingRequiredSecrets(normalizedExisting);

      return {
        name: 'gcp_secrets_inventory',
        pass: missing.length === 0,
        details: {
          projectId,
          prefix,
          expectedCount: REQUIRED_SECRET_OPTIONS.length,
          foundCount: gcloudFallback.length,
          source: 'gcloud-cli-fallback',
          missing,
          sdkError: error instanceof Error ? error.message : String(error),
        },
      };
    }

    return {
      name: 'gcp_secrets_inventory',
      pass: false,
      details: {
        projectId,
        error: error instanceof Error ? error.message : String(error),
        hint:
          error instanceof Error &&
          /invalid_rapt|invalid_grant|reauth/i.test(error.message)
            ? 'Detected interactive ADC token (reauth required). Use service_account/external_account credentials for production.'
            : undefined,
      },
    };
  }
}

async function listSecretsWithGcloud(projectId: string): Promise<string[] | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFile('cmd.exe', [
        '/d',
        '/s',
        '/c',
        `gcloud secrets list --project=${projectId} --format=value(name)`,
      ]);
      const names = stdout
        .split(/\r?\n/)
        .map((line) => parseSecretResourceName(line))
        .filter((line): line is string => Boolean(line))
        .filter((line) => line.length > 0);
      if (names.length > 0) {
        return names;
      }
    } catch {
      // Continue to direct executable variants.
    }
  }

  const commands = process.platform === 'win32' ? ['gcloud.cmd', 'gcloud'] : ['gcloud'];

  for (const command of commands) {
    try {
      const { stdout } = await execFile(command, [
        'secrets',
        'list',
        `--project=${projectId}`,
        '--format=value(name)',
      ]);

      const names = stdout
        .split(/\r?\n/)
        .map((line) => parseSecretResourceName(line))
        .filter((line): line is string => Boolean(line))
        .filter((line) => line.length > 0);

      return names;
    } catch {
      // Try next executable variant.
    }
  }

  return null;
}

async function checkCatalogSample(
  baseUrl: string,
  token: string,
  apiKey: string
): Promise<PreflightCheck> {
  const modelsResponse = await safeRequestJsonWithTimeout(
    `${baseUrl}/v1/models`,
    {
      method: 'GET',
      headers: buildAuthHeaders(token, apiKey),
    },
    20_000
  );

  if (!modelsResponse.ok) {
    return {
      name: 'catalog_sample_runtime_validation',
      pass: false,
      details: {
        reason: 'Failed to fetch /v1/models due to transport timeout/error',
        error: modelsResponse.error,
      },
    };
  }

  if (modelsResponse.status < 200 || modelsResponse.status >= 300) {
    return {
      name: 'catalog_sample_runtime_validation',
      pass: false,
      details: {
        reason: 'Failed to fetch /v1/models',
        status: modelsResponse.status,
        body: modelsResponse.text,
      },
    };
  }

  const payload = modelsResponse.json as { data?: Array<Record<string, unknown>> };
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const sampleCandidates = models
    .filter((model) => {
      const capabilities = Array.isArray(model.capabilities)
        ? model.capabilities.map((capability) => String(capability))
        : [];
      return capabilities.includes('chat');
    })
    .slice(0, 10);

  if (sampleCandidates.length === 0) {
    return {
      name: 'catalog_sample_runtime_validation',
      pass: false,
      details: {
        reason: 'No chat-capable models were returned by /v1/models for sampling.',
      },
    };
  }

  const checks: Array<{
    model: string;
    statusCode: number;
    pass: boolean;
    provider404: boolean;
    validationError: boolean;
    unauthorized: boolean;
    timeoutOrTransportError: boolean;
    errorMessage?: string;
  }> = [];

  for (const model of sampleCandidates) {
    const modelName = String(model.name || model.id || 'unknown');
    let completionResponse: SafeHttpResult = {
      ok: false,
      status: 0,
      json: null,
      text: '',
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      completionResponse = await safeRequestJsonWithTimeout(
        `${baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildAuthHeaders(token, apiKey),
          },
          body: JSON.stringify({
            model: modelName,
            strategy: 'single',
            temperature: 0,
            messages: [{ role: 'user', content: 'Reply with the word OK.' }],
          }),
        },
        35_000
      );

      const shouldRetry =
        completionResponse.status === 429 ||
        completionResponse.status === 503 ||
        completionResponse.status === 504 ||
        completionResponse.status === 0;
      if (!shouldRetry || attempt === 3) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }

    const body = completionResponse.ok
      ? (completionResponse.json as { error?: { message?: string } })?.error?.message || ''
      : completionResponse.error || '';
    const provider404 =
      body.toLowerCase().includes('not found') ||
      body.toLowerCase().includes('404') ||
      completionResponse.status === 404;
    const validationError = body.toLowerCase().includes('validation failed');
    const unauthorized =
      completionResponse.status === 401 || completionResponse.status === 403;
    const timeoutOrTransportError = !completionResponse.ok || completionResponse.status === 0;

    checks.push({
      model: modelName,
      statusCode: completionResponse.status,
      pass:
        completionResponse.ok &&
        completionResponse.status >= 200 &&
        completionResponse.status < 300,
      provider404,
      validationError,
      unauthorized,
      timeoutOrTransportError,
      errorMessage: body || undefined,
    });
  }

  const provider404Count = checks.filter((entry) => entry.provider404).length;
  const validationErrorCount = checks.filter((entry) => entry.validationError).length;
  const unauthorizedCount = checks.filter((entry) => entry.unauthorized).length;
  const timeoutOrTransportErrorCount = checks.filter((entry) => entry.timeoutOrTransportError).length;
  const successCount = checks.filter((entry) => entry.pass).length;
  const successRate = checks.length > 0 ? successCount / checks.length : 0;
  const pass =
    provider404Count === 0 &&
    validationErrorCount === 0 &&
    unauthorizedCount === 0 &&
    successRate >= 0.8 &&
    timeoutOrTransportErrorCount <= 2;

  return {
    name: 'catalog_sample_runtime_validation',
    pass,
    details: {
      sampledModels: checks.length,
      successfulRuntimeChecks: successCount,
      successfulRuntimeRate: Number(successRate.toFixed(4)),
      provider404Count,
      validationErrorCount,
      unauthorizedCount,
      timeoutOrTransportErrorCount,
      checks,
    },
  };
}

async function checkResponsesStrategyConformance(
  baseUrl: string,
  token: string,
  apiKey: string
): Promise<PreflightCheck> {
  const responseModel = process.env.EVAL_RESPONSES_MODEL || 'auto';
  const strategies = ['single', 'cost', 'quality', 'parallel', 'debate'] as const;
  const checks: Array<{
    strategy: string;
    expected: string;
    status: number;
    pass: boolean;
    resolved?: string;
    error?: string;
  }> = [];

  for (const strategy of strategies) {
    const expected = expectedResolvedCanonicalStrategy(strategy);
    if (!expected) continue;

    let run: SafeHttpResult = {
      ok: false,
      status: 0,
      json: null,
      text: '',
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      run = await safeRequestJsonWithTimeout(
        `${baseUrl}/v1/responses`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildAuthHeaders(token, apiKey),
          },
          body: JSON.stringify({
            model: responseModel,
            input: 'Reply only with OK.',
            strategy,
            max_output_tokens: 32,
            temperature: 0,
          }),
        },
        35_000
      );

      const shouldRetry =
        run.status === 429 ||
        run.status === 503 ||
        run.status === 504 ||
        run.status === 0;
      if (!shouldRetry || attempt === 3) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }

    const payload = run.json as {
      ailin_metadata?: { resolved_strategy?: string };
      error?: { message?: string };
    };
    const resolved = payload?.ailin_metadata?.resolved_strategy;
    const pass = run.ok && run.status >= 200 && run.status < 300 && resolved === expected;
    checks.push({
      strategy,
      expected,
      status: run.status,
      pass,
      resolved,
      error: run.ok ? undefined : payload?.error?.message || run.error || run.text || undefined,
    });

    // Small pacing between strategy probes to reduce user-scoped burst rate limiting.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const passCount = checks.filter((entry) => entry.pass).length;
  const passRate = checks.length > 0 ? passCount / checks.length : 0;

  return {
    name: 'responses_strategy_conformance',
    pass: checks.length > 0 && passRate >= 0.95,
    details: {
      model: responseModel,
      sampledStrategies: checks.length,
      passCount,
      passRate: Number(passRate.toFixed(4)),
      checks,
    },
  };
}

async function main(): Promise<void> {
  await ensureOutputDir();

  const baseUrl = getApiBaseUrl();
  const token = getBearerToken();
  const apiKey = getApiKey();
  const generatedAt = new Date().toISOString();

  const checks: PreflightCheck[] = [];

  if (!token && !apiKey) {
    checks.push({
      name: 'eval_auth_credential_present',
      pass: false,
      details: {
        reason:
          'No eval credential configured. Set EVAL_API_KEY (recommended) or EVAL_BEARER_TOKEN.',
      },
    });
  } else {
    checks.push(await checkAuthCredential(baseUrl, token, apiKey));
  }

  checks.push(await checkGcpSecretsInventory());
  checks.push(await checkGcpCredentialMode());
  if (token || apiKey) {
    checks.push(await checkCatalogSample(baseUrl, token, apiKey));
    checks.push(await checkResponsesStrategyConformance(baseUrl, token, apiKey));
  }

  const report = {
    generatedAt,
    baseUrl,
    overallPass: checks.every((check) => check.pass),
    checks,
  };

  const targetPath = path.resolve(OUTPUT_DIR, 'preflight-report.json');
  await writeJsonFile(targetPath, report);

  const failed = checks.filter((check) => !check.pass).map((check) => check.name);
  console.log(
    JSON.stringify(
      {
        report: targetPath,
        overallPass: report.overallPass,
        failedChecks: failed,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('run-enterprise-preflight failed:', error);
  process.exit(1);
});
