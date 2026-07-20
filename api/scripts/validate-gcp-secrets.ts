// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Validates GCP Secret Manager access and lists expected vs actual secrets.
 * Uses the same project ID and prefix as the API (GCP_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCP_SECRETS_PROJECT_ID; GCP_SECRETS_PREFIX or 'my-app').
 *
 * Run: npx tsx scripts/validate-gcp-secrets.ts
 * Optional: GCP_PROJECT_ID=your-project-id if secrets are in a different project.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const GCP_SECRETS_PREFIX = process.env.GCP_SECRETS_PREFIX || 'my-app';
const PROJECT_ID =
  process.env.GCP_SECRETS_PROJECT_ID ||
  process.env.GCP_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  'your-gcp-project';

/** Expected secret keys (without prefix). Same as in load-secrets-into-env.ts. */
const CRITICAL_SECRET_KEYS = [
  'database-url',
  'jwt-secret',
  'redis-password',
  'smtp-pass',
  'stripe-secret-key',
  'stripe-webhook-secret',
  'stripe-publishable-key',
];

const PROVIDER_SECRET_KEYS = [
  'openai-key',
  'anthropic-key',
  'google-key',
  'deepseek-key',
  'xai-key',
  'mistral-key',
  'cohere-key',
  'nvidia-key',
  'aihubmix-key',
  'novita-key',
  'moonshot-key',
  'minimax-key',
  'jina-key',
  'friendli-key',
  'aiml-key',
  'imagerouter-key',
  'openrouter-key',
  'orqai-key',
  'edenai-key',
  'heliconeai-key',
  'vertex-key',
  'vertex-project-id',
  'qwen-key-2',
  'alibaba-key-id',
  'alibaba-key-secret',
  'baidu-key',
  'baidu-secret',
  'aws-key-id',
  'aws-secret',
  'aws-bearer-token',
];

const PROVIDER_SECRET_KEY_OPTIONS: readonly (readonly string[])[] = [
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
  ['vertex-project-id'],
  ['qwen-key-2'],
  ['alibaba-key-id'],
  ['alibaba-key-secret'],
  ['baidu-key'],
  ['baidu-secret'],
  ['aws-key-id'],
  ['aws-secret'],
  ['aws-bearer-token'],
];

const EXPECTED_KEYS = [...CRITICAL_SECRET_KEYS, ...PROVIDER_SECRET_KEYS];
const EXPECTED_ALLOWED_KEYS = new Set<string>([
  ...CRITICAL_SECRET_KEYS,
  ...PROVIDER_SECRET_KEY_OPTIONS.flat(),
]);

function computeMissingByOptions(existingWithoutPrefix: string[]): string[] {
  const existingSet = new Set(existingWithoutPrefix);
  const missingCritical = CRITICAL_SECRET_KEYS.filter((key) => !existingSet.has(key));
  const missingProvider = PROVIDER_SECRET_KEY_OPTIONS
    .filter((options) => !options.some((key) => existingSet.has(key)))
    .map((options) => options.join(' | '));
  return [...missingCritical, ...missingProvider];
}

function stripPrefix(name: string, prefix: string): string {
  if (!prefix) return name;
  const token = `${prefix}-`;
  return name.startsWith(token) ? name.substring(token.length) : name;
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
}

async function main(): Promise<void> {
  console.log('GCP Secret Manager validation');
  console.log('Project ID:', PROJECT_ID, '(set GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT to use another project)');
  console.log('Secret prefix:', GCP_SECRETS_PREFIX);
  console.log('');

  configureGoogleApiProxyBypass();
  const client = new SecretManagerServiceClient();
  const parent = `projects/${PROJECT_ID}`;

  let existingNames: string[] = [];
  try {
    const [secrets] = await client.listSecrets({ parent });
    existingNames = (secrets || [])
      .map((s) => parseSecretResourceName(s.name || ''))
      .filter((name): name is string => Boolean(name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to list secrets:', message);
    console.error('');
    console.error('Ensure Application Default Credentials are set:');
    console.error('  gcloud auth application-default login');
    console.error('  gcloud config set project', PROJECT_ID);
    process.exit(1);
  }

  const existingWithoutPrefix = existingNames.map((name) => stripPrefix(name, GCP_SECRETS_PREFIX));
  const expectedSet = EXPECTED_ALLOWED_KEYS;
  const existingSet = new Set(existingWithoutPrefix);

  const missing = computeMissingByOptions(existingWithoutPrefix);
  const extra = existingWithoutPrefix.filter((k) => !expectedSet.has(k));

  console.log('Expected required slots (aliases accepted):', CRITICAL_SECRET_KEYS.length + PROVIDER_SECRET_KEY_OPTIONS.length);
  console.log('Accepted key variants:', EXPECTED_ALLOWED_KEYS.size);
  console.log('Found in project (with prefix):', existingNames.length);
  console.log('');
  if (missing.length > 0) {
    console.log('Missing (expected by API):');
    missing.forEach((k) => console.log('  -', GCP_SECRETS_PREFIX + '-' + k));
    console.log('');
  }
  if (extra.length > 0) {
    console.log('Extra (in GCP but not in expected list):');
    extra.forEach((k) => console.log('  -', GCP_SECRETS_PREFIX + '-' + k));
    console.log('');
  }
  if (missing.length === 0) {
    console.log('All expected secrets are present in GCP.');
  } else {
    console.log('Add missing secrets in GCP Secret Manager or set env vars for optional ones.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
