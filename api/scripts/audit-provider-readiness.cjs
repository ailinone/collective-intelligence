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
 * Provider Readiness Audit
 *
 * For every catalog row with an `apiKeyEnvVar` (mandatory at runtime),
 * cross-reference the 4 gates that determine whether the provider can
 * actually surface models at boot:
 *
 *   1. PROVIDER_SECRETS tuple  — loader knows which GCP secret to fetch
 *   2. GCP secret exists       — operator has provisioned the credential
 *   3. Discovery surface       — fetcher exists (dedicated source OR generic
 *                                hub fetcher via CatalogProviderPlugin OR
 *                                fallback addRegisteredAdapterSources)
 *   4. Adapter buildable       — dedicated factory OR CatalogProviderPlugin
 *                                generic OAI-compat path
 *
 * Output buckets:
 *   ✅ READY              — all 4 gates pass
 *   🔑 SECRET-MISSING     — gates 1,3,4 pass; only GCP provisioning needed
 *   🔌 DISCOVERY-GAP      — secret + adapter present; no clear discovery path
 *   🛠️  ADAPTER-GAP       — secret present; adapterClass declared but no factory
 *   ❌ CATALOG-GAP        — apiKeyEnvVar set but no PROVIDER_SECRETS tuple
 *   ⏸️  DISABLED-DEFAULT   — `enabledByDefault: false` AND not in env at preflight
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LOADER = path.join(ROOT, 'src/config/load-secrets-into-env.ts');
const CATALOG = path.join(ROOT, 'src/providers/catalog/providers.catalog.ts');
const DISCOVERY = path.join(ROOT, 'src/services/central-model-discovery-service.ts');
const FACTORIES = path.join(ROOT, 'src/providers/catalog/default-adapter-factories.ts');
// Operator-supplied inventory of GCP secret names (one per line); not shipped with the repo.
const GCP_LIST = process.env.GCP_SECRETS_LIST_FILE || path.join(__dirname, '.gcp-secrets-list.txt');
// Prefix used when naming secrets in GCP Secret Manager (e.g. "<prefix>-openai-api-key").
const GCP_SECRETS_PREFIX = (process.env.GCP_SECRETS_PREFIX || 'app') + '-';

const gcpSecrets = new Set(
  fs.readFileSync(GCP_LIST, 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => (s.startsWith(GCP_SECRETS_PREFIX) ? s.slice(GCP_SECRETS_PREFIX.length) : s))
);

// ── Parse PROVIDER_SECRETS ─────────────────────────────────────────────
const loaderSrc = fs.readFileSync(LOADER, 'utf8');
const tupleRe = /\{\s*envVar:\s*'([A-Z_][A-Z0-9_]*)'\s*,\s*secretKeys:\s*\[([^\]]+)\]\s*\}/g;
const envToTuple = new Map();
let m;
while ((m = tupleRe.exec(loaderSrc)) !== null) {
  const candidates = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  envToTuple.set(m[1], candidates);
}

// ── Parse ENV_VAR_TO_PROVIDER ──────────────────────────────────────────
const envToProvider = new Map();
const envBlock = loaderSrc.match(/const\s+ENV_VAR_TO_PROVIDER[^{]*\{([\s\S]*?)\};/);
if (envBlock) {
  const re = /(?:'([A-Z_][A-Z0-9_]*)'|([A-Z_][A-Z0-9_]*))\s*:\s*'([a-z0-9-]+)'/g;
  let mm;
  while ((mm = re.exec(envBlock[1])) !== null) {
    envToProvider.set(mm[1] ?? mm[2], mm[3]);
  }
}

// ── Parse PROVIDER_CATALOG (block-based, then per-block fields) ────────
const catalogSrc = fs.readFileSync(CATALOG, 'utf8');
// Find PROVIDER_CATALOG array body
const catBlockMatch = catalogSrc.match(/export\s+const\s+PROVIDER_CATALOG[^=]*=\s*\[([\s\S]*?)\n\] as const/);
if (!catBlockMatch) {
  throw new Error('Could not locate PROVIDER_CATALOG declaration');
}
const catBody = catBlockMatch[1];

// Walk top-level objects: { ... }, separated by `,\n  {`
const entries = [];
let depth = 0;
let start = -1;
for (let i = 0; i < catBody.length; i++) {
  const ch = catBody[i];
  if (ch === '{') {
    if (depth === 0) start = i;
    depth++;
  } else if (ch === '}') {
    depth--;
    if (depth === 0 && start !== -1) {
      entries.push(catBody.slice(start, i + 1));
      start = -1;
    }
  }
}

const catalog = [];
for (const block of entries) {
  const get = (key) => {
    const r = new RegExp(`\\b${key}:\\s*'([^']+)'`);
    const mm = r.exec(block);
    return mm ? mm[1] : null;
  };
  const getBool = (key) => {
    const r = new RegExp(`\\b${key}:\\s*(true|false)`);
    const mm = r.exec(block);
    return mm ? mm[1] === 'true' : null;
  };
  const supports = {};
  const supportsBlock = block.match(/supports:\s*\{([\s\S]*?)\}/);
  if (supportsBlock) {
    const sb = supportsBlock[1];
    for (const cap of ['chat', 'embeddings', 'streaming', 'tools', 'jsonMode',
                        'speechToText', 'textToSpeech', 'speechToSpeech',
                        'imageGenerate', 'imageEdit', 'videoGenerate']) {
      if (new RegExp(`\\b${cap}:\\s*true`).test(sb)) supports[cap] = true;
    }
  }
  const providerId = get('providerId');
  if (!providerId) continue;
  catalog.push({
    providerId,
    displayName: get('displayName'),
    apiKeyEnvVar: get('apiKeyEnvVar'),
    apiKeyOptional: getBool('apiKeyOptional'),
    enabledByDefault: getBool('enabledByDefault'),
    denyByDefault: getBool('denyByDefault'),
    integrationClass: get('integrationClass'),
    integrationMode: get('integrationMode'),
    adapterClass: get('adapterClass'),
    supports,
    hasStaticModels: /\bstaticModels:\s*\[/.test(block),
    raw: block,
  });
}

// ── Parse discovery sources: name + providers[] ────────────────────────
const discoverySrc = fs.readFileSync(DISCOVERY, 'utf8');
const sourceRe = /\{\s*name:\s*'([a-z][a-z0-9-]+)',[\s\S]*?providers:\s*\[([^\]]+)\]/g;
const dedicatedSources = []; // { name, providers: [...] }
const wildcardSources = []; // sources with providers: ['*']
while ((m = sourceRe.exec(discoverySrc)) !== null) {
  const providers = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  dedicatedSources.push({ name: m[1], providers });
  if (providers.includes('*')) wildcardSources.push(m[1]);
}
// Aliases: discovery source provider list != ENV_VAR_TO_PROVIDER providerId
// (aws-bedrock is the runtime providerId; the discovery source lists ['amazon','aws','bedrock'])
const providerAliases = {
  'aws-bedrock': ['amazon', 'aws', 'bedrock'],
  'aws-sagemaker': ['amazon', 'aws', 'sagemaker'],
  'oci': ['oracle', 'oci'],
  'azure-openai': ['microsoft', 'azure'],
  // openrouter intentionally omitted — it's its own native source name
};
// Build providerId -> source name map (dedicated)
const providerToDedicatedSource = new Map();
for (const src of dedicatedSources) {
  for (const p of src.providers) {
    if (p === '*') continue;
    if (!providerToDedicatedSource.has(p)) providerToDedicatedSource.set(p, []);
    providerToDedicatedSource.get(p).push(src.name);
  }
}
// Apply aliases — also populate native providerId entries
for (const [pid, aliases] of Object.entries(providerAliases)) {
  for (const a of aliases) {
    if (providerToDedicatedSource.has(a)) {
      const src = providerToDedicatedSource.get(a);
      if (!providerToDedicatedSource.has(pid)) providerToDedicatedSource.set(pid, [...src]);
    }
  }
}
// openrouter has its own source by name (the source NAME contains 'openrouter')
// not by providers array (which is wildcard). Treat any source whose name
// starts with the providerId as a dedicated source for that providerId.
for (const src of dedicatedSources) {
  // Names like 'openrouter-aggregator' → providerId 'openrouter'
  const candidates = ['openrouter', 'aws-bedrock', 'aws-sagemaker', 'azure-openai',
    'vertex-ai', 'oci'];
  for (const pid of candidates) {
    if (src.name.startsWith(pid)) {
      if (!providerToDedicatedSource.has(pid)) providerToDedicatedSource.set(pid, []);
      if (!providerToDedicatedSource.get(pid).includes(src.name)) {
        providerToDedicatedSource.get(pid).push(src.name);
      }
    }
  }
}

// ── Parse registered adapter factories ─────────────────────────────────
const factoriesSrc = fs.readFileSync(FACTORIES, 'utf8');
const factoryRe = /registerAdapterFactory\(\s*'([A-Z][A-Za-z]+)'/g;
const registeredFactories = new Set();
while ((m = factoryRe.exec(factoriesSrc)) !== null) {
  registeredFactories.add(m[1]);
}

// ── Classify each catalog row ──────────────────────────────────────────
const isLlmClass = (e) => Boolean(
  e.supports.chat || e.supports.embeddings || e.supports.streaming ||
  e.supports.tools || e.supports.jsonMode || e.supports.speechToText ||
  e.supports.textToSpeech || e.supports.speechToSpeech
);

const buckets = {
  READY: [],
  SECRET_MISSING: [],
  DISCOVERY_GAP: [],
  ADAPTER_GAP: [],
  CATALOG_GAP: [],
  DISABLED_DEFAULT: [],
  OPTIONAL_OR_SELF_HOSTED: [],
  NATIVE_READY: [],
  NATIVE_SECRET_MISSING: [],
  NATIVE_NO_DISCOVERY: [],
};
const catalogProviderIds = new Set(catalog.map(e => e.providerId));

for (const e of catalog) {
  if (!e.apiKeyEnvVar) {
    buckets.OPTIONAL_OR_SELF_HOSTED.push({ ...e, reason: 'no apiKeyEnvVar' });
    continue;
  }
  if (e.apiKeyOptional) {
    buckets.OPTIONAL_OR_SELF_HOSTED.push({ ...e, reason: 'apiKeyOptional=true' });
    continue;
  }

  const tuple = envToTuple.get(e.apiKeyEnvVar);
  const hasTuple = !!tuple;
  const gcpHit = tuple ? tuple.find(c => gcpSecrets.has(c)) : null;
  const hasGcpSecret = !!gcpHit;
  const hasDedicatedSource = providerToDedicatedSource.has(e.providerId);
  // OAI-compat catalog plugin path implicitly provides a fetcher via
  // OpenAICompatibleHubModelFetcher for these integration classes:
  const isOAICompat = ['oai-compat-pure', 'oai-compat-quirks', 'gateway',
                        'self-hosted-oai-compat'].includes(e.integrationClass);
  // adapter buildable:
  const hasFactory = e.adapterClass && registeredFactories.has(e.adapterClass);
  // adapter is buildable via CatalogProviderPlugin generic path if isOAICompat,
  // OR via dedicated factory.
  const adapterBuildable = hasFactory || isOAICompat;

  if (!hasTuple) {
    buckets.CATALOG_GAP.push({ ...e, reason: 'no PROVIDER_SECRETS tuple' });
    continue;
  }

  if (!hasGcpSecret) {
    buckets.SECRET_MISSING.push({ ...e, expectedSecrets: tuple.map(c => `${GCP_SECRETS_PREFIX}${c}`) });
    continue;
  }

  if (!adapterBuildable) {
    buckets.ADAPTER_GAP.push({
      ...e,
      reason: `adapterClass='${e.adapterClass}' has no factory; integrationClass='${e.integrationClass}' not OAI-compat`,
    });
    continue;
  }

  // disabled-by-default but might still discover if process.env set at boot
  if (e.enabledByDefault === false) {
    buckets.DISABLED_DEFAULT.push({
      ...e,
      gcpHit,
      hasDedicatedSource,
      adapterPath: hasFactory ? `factory(${e.adapterClass})` : 'oai-compat-hub',
    });
    continue;
  }

  // discovery path:
  // - hasDedicatedSource OR
  // - isOAICompat (catalog-plugin builds hub fetcher) OR
  // - falls back to addRegisteredAdapterSources (works only if adapter has getModels)
  if (!hasDedicatedSource && !isOAICompat && !hasFactory) {
    buckets.DISCOVERY_GAP.push({ ...e, reason: 'no fetcher path' });
    continue;
  }

  buckets.READY.push({
    ...e,
    gcpHit,
    discoveryPath: hasDedicatedSource
      ? `dedicated:${providerToDedicatedSource.get(e.providerId).join(',')}`
      : isOAICompat ? 'catalog-plugin/hub-fetcher' : 'adapter.getModels()',
    adapterPath: hasFactory ? `factory(${e.adapterClass})` : 'oai-compat-hub',
    isLlm: isLlmClass(e),
  });
}

// ── Pass 2: Native (non-catalog) providers via PROVIDER_SECRETS ────────
// Side-cars (PROJECT_ID, REGION, BASE_URL, etc.) are treated as such if
// the env var name doesn't end with _API_KEY/_TOKEN/_KEY/_PAT or starts
// with a credential-shape prefix. We focus on auth credentials only.
const isAuthEnvVar = (v) =>
  /_API_KEY$|_TOKEN$|_PAT$|_APIKEY$|_KEY$|_SECRET$|_ID$/.test(v) &&
  !/_PROJECT_ID$|_TEAM_ID$|_TENANCY_ID$|_USER_ID$|_ACCOUNT_ID$|_ENDPOINT_NAME$|_PROJECT$/.test(v);

const nativeAuthOnly = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY',
  'JINA_API_KEY', 'QWEN_API_KEY', 'ERNIE_API_KEY', 'NVIDIA_API_KEY',
  'VERTEX_AI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK',
  'AZURE_OPENAI_API_KEY', 'OCI_USER_ID', 'DEEPGRAM_API_KEY',
  'CARTESIA_API_KEY', 'ELEVENLABS_API_KEY', 'PALABRAAI_CLIENT_ID',
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'GROQ_API_KEY',
  'PERPLEXITY_API_KEY', 'CEREBRAS_API_KEY', 'WANDB_API_KEY', 'VOYAGE_API_KEY',
  'BYTEZ_API_KEY', 'FEATHERLESS_AI_API_KEY', 'CLOUDFLARE_API_TOKEN',
  'GITHUB_TOKEN', 'DATABRICKS_TOKEN', 'INWORLD_API_KEY', 'WRITER_API_KEY',
  'UPSTAGE_API_KEY', 'REKA_API_KEY', 'AIHUBMIX_API_KEY'];

for (const [envVar, candidates] of envToTuple) {
  if (!isAuthEnvVar(envVar)) continue;
  // Skip envVars that map to catalog providers (handled in pass 1)
  const providerId = envToProvider.get(envVar);
  if (!providerId) continue;
  if (catalogProviderIds.has(providerId)) continue;
  // Native providers only
  const gcpHit = candidates.find(c => gcpSecrets.has(c));
  const hasDedicatedSource = providerToDedicatedSource.has(providerId);

  if (!gcpHit) {
    buckets.NATIVE_SECRET_MISSING.push({
      providerId, envVar,
      expectedSecrets: candidates.map(c => `${GCP_SECRETS_PREFIX}${c}`),
      hasDedicatedSource,
    });
  } else if (!hasDedicatedSource) {
    buckets.NATIVE_NO_DISCOVERY.push({ providerId, envVar, gcpHit });
  } else {
    buckets.NATIVE_READY.push({
      providerId, envVar, gcpHit,
      sources: providerToDedicatedSource.get(providerId),
    });
  }
}

// ── Report ─────────────────────────────────────────────────────────────
const total = catalog.length;
const evalCount = total - buckets.OPTIONAL_OR_SELF_HOSTED.length;

console.log('═══════════════════════════════════════════════════════════');
console.log(`Catalog rows: ${total} (evaluated: ${evalCount}, optional/self-hosted: ${buckets.OPTIONAL_OR_SELF_HOSTED.length})`);
console.log(`Dedicated discovery sources: ${dedicatedSources.length}`);
console.log(`Registered adapter factories: ${registeredFactories.size}`);
console.log(`PROVIDER_SECRETS tuples: ${envToTuple.size}`);
console.log(`Real GCP secrets: ${gcpSecrets.size}`);
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`✅ READY (${buckets.READY.length}) — secret wired + GCP exists + discovery + adapter all in place`);
for (const e of buckets.READY) {
  const tag = e.isLlm ? '[LLM]' : '[non-LLM]';
  console.log(`   ${e.providerId.padEnd(28)} ${tag.padEnd(9)} disc=${e.discoveryPath.padEnd(35)} adapter=${e.adapterPath}`);
}

console.log(`\n🔑 SECRET-MISSING (${buckets.SECRET_MISSING.length}) — wired correctly, only GCP provisioning required`);
for (const e of buckets.SECRET_MISSING) {
  const tag = isLlmClass(e) ? '[LLM]' : '[non-LLM]';
  console.log(`   ${e.providerId.padEnd(28)} ${tag.padEnd(9)} expects: ${e.expectedSecrets.join(' OR ')}`);
}

console.log(`\n⏸️  DISABLED-DEFAULT (${buckets.DISABLED_DEFAULT.length}) — wired AND GCP exists, but enabledByDefault=false`);
console.log('    (will activate IF env override at boot OR catalog flag flipped)');
for (const e of buckets.DISABLED_DEFAULT) {
  console.log(`   ${e.providerId.padEnd(28)} → ${GCP_SECRETS_PREFIX}${e.gcpHit}  (adapter=${e.adapterPath}, dedicated-discovery=${e.hasDedicatedSource})`);
}

console.log(`\n🔌 DISCOVERY-GAP (${buckets.DISCOVERY_GAP.length}) — secret + adapter present; no clear fetcher path`);
for (const e of buckets.DISCOVERY_GAP) {
  console.log(`   ${e.providerId.padEnd(28)} integrationClass=${e.integrationClass} adapterClass=${e.adapterClass ?? '<unset>'}`);
}

console.log(`\n🛠️  ADAPTER-GAP (${buckets.ADAPTER_GAP.length}) — secret present; adapter not buildable`);
for (const e of buckets.ADAPTER_GAP) {
  console.log(`   ${e.providerId.padEnd(28)} ${e.reason}`);
}

console.log(`\n❌ CATALOG-GAP (${buckets.CATALOG_GAP.length}) — apiKeyEnvVar declared but no PROVIDER_SECRETS tuple`);
for (const e of buckets.CATALOG_GAP) {
  console.log(`   ${e.providerId.padEnd(28)} apiKeyEnvVar=${e.apiKeyEnvVar} (J6 invariant should fire)`);
}

// ── Native (non-catalog) providers ─────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('NATIVE PROVIDERS (coded directly in registry, not in catalog)');
console.log('═══════════════════════════════════════════════════════════');

console.log(`\n✅ NATIVE-READY (${buckets.NATIVE_READY.length}) — secret + GCP + dedicated discovery source`);
for (const e of buckets.NATIVE_READY) {
  console.log(`   ${e.providerId.padEnd(28)} env=${e.envVar.padEnd(28)} → ${GCP_SECRETS_PREFIX}${e.gcpHit.padEnd(28)} sources=${e.sources.join(',')}`);
}

console.log(`\n🔑 NATIVE-SECRET-MISSING (${buckets.NATIVE_SECRET_MISSING.length}) — wired but no GCP secret`);
for (const e of buckets.NATIVE_SECRET_MISSING) {
  console.log(`   ${e.providerId.padEnd(28)} env=${e.envVar.padEnd(28)} expects: ${e.expectedSecrets.join(' OR ')}  (discovery=${e.hasDedicatedSource})`);
}

console.log(`\n🔌 NATIVE-NO-DISCOVERY (${buckets.NATIVE_NO_DISCOVERY.length}) — secret + GCP present, but no dedicated discovery source`);
for (const e of buckets.NATIVE_NO_DISCOVERY) {
  console.log(`   ${e.providerId.padEnd(28)} env=${e.envVar.padEnd(28)} → ${GCP_SECRETS_PREFIX}${e.gcpHit}`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Summary:`);
console.log(`  ✅ READY:                 ${buckets.READY.length}`);
console.log(`  🔑 SECRET-MISSING:        ${buckets.SECRET_MISSING.length}`);
console.log(`  ⏸️  DISABLED-DEFAULT:      ${buckets.DISABLED_DEFAULT.length}`);
console.log(`  🔌 DISCOVERY-GAP:         ${buckets.DISCOVERY_GAP.length}`);
console.log(`  🛠️  ADAPTER-GAP:          ${buckets.ADAPTER_GAP.length}`);
console.log(`  ❌ CATALOG-GAP:           ${buckets.CATALOG_GAP.length}`);
console.log(`  ⏭️  optional/self-host:    ${buckets.OPTIONAL_OR_SELF_HOSTED.length}`);
console.log(`  ─── native ───`);
console.log(`  ✅ NATIVE-READY:          ${buckets.NATIVE_READY.length}`);
console.log(`  🔑 NATIVE-SECRET-MISSING: ${buckets.NATIVE_SECRET_MISSING.length}`);
console.log(`  🔌 NATIVE-NO-DISCOVERY:   ${buckets.NATIVE_NO_DISCOVERY.length}`);
console.log('═══════════════════════════════════════════════════════════');
