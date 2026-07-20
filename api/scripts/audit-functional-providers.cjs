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
 * Audit functional providers (those with auth secret WIRED + EXISTS in GCP)
 * to validate discovery and adapter wiring is structurally correct.
 *
 * For each functional provider, surface:
 *   - catalog row metadata (integrationMode, adapterClass, supports.*)
 *   - PROVIDER_SECRETS tuple status
 *   - ENV_VAR_TO_PROVIDER attribution
 *   - LLM_PROVIDER_ENV_VARS membership (LLM-class only)
 *   - DISCOVERY_COMPLIANCE_REGISTRY classification
 *   - fetcher file presence in api/src/services/model-fetchers/
 *   - adapter directory presence in api/src/providers/
 *   - flagged structural mismatches (e.g., catalog says native fetcher
 *     should exist but file is missing; integrationMode says hub but
 *     adapterClass says custom; etc.)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'src/providers/catalog/providers.catalog.ts');
const LOADER = path.join(ROOT, 'src/config/load-secrets-into-env.ts');
const COMPLIANCE = path.join(ROOT, 'src/providers/catalog/consolidation-matrix.ts');
const FETCHERS_DIR = path.join(ROOT, 'src/services/model-fetchers');
const ADAPTERS_DIR = path.join(ROOT, 'src/providers');
// Operator-supplied inventory of GCP secret names (one per line); not shipped with the repo.
const GCP_LIST = process.env.GCP_SECRETS_LIST_FILE || path.join(__dirname, '.gcp-secrets-list.txt');
// Prefix used when naming secrets in GCP Secret Manager (e.g. "<prefix>-openai-api-key").
const GCP_SECRETS_PREFIX = (process.env.GCP_SECRETS_PREFIX || 'app') + '-';

const gcpSecrets = new Set(
  fs.readFileSync(GCP_LIST, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith(GCP_SECRETS_PREFIX) ? s.slice(GCP_SECRETS_PREFIX.length) : s)),
);

const loaderSrc = fs.readFileSync(LOADER, 'utf8');
const catalogSrc = fs.readFileSync(CATALOG, 'utf8');
const complianceSrc = fs.readFileSync(COMPLIANCE, 'utf8');

// ── Parse PROVIDER_SECRETS ────────────────────────────────────────────
const providerSecrets = new Map(); // envVar → candidates[]
{
  const re = /\{\s*envVar:\s*'([A-Z_][A-Z0-9_]*)'\s*,\s*secretKeys:\s*\[([^\]]+)\]\s*\}/g;
  let m;
  while ((m = re.exec(loaderSrc)) !== null) {
    const envVar = m[1];
    const candidates = m[2]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    providerSecrets.set(envVar, candidates);
  }
}

// ── Parse ENV_VAR_TO_PROVIDER ─────────────────────────────────────────
const envToProvider = new Map();
{
  const block = loaderSrc.match(
    /const\s+ENV_VAR_TO_PROVIDER\s*:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\};/,
  );
  if (block) {
    const re = /(?:^|\n)\s*([A-Z_][A-Z0-9_]*)\s*:\s*'([a-z0-9-]+)'/g;
    let m;
    while ((m = re.exec(block[1])) !== null) {
      envToProvider.set(m[1], m[2]);
    }
  }
}

// ── Parse LLM_PROVIDER_ENV_VARS ───────────────────────────────────────
const llmEnvVars = new Set();
{
  const block = loaderSrc.match(
    /const\s+LLM_PROVIDER_ENV_VARS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
  );
  if (block) {
    const re = /'([A-Z_][A-Z0-9_]*)'/g;
    let m;
    while ((m = re.exec(block[1])) !== null) llmEnvVars.add(m[1]);
  }
}

// ── Parse PROVIDER_CATALOG (lightweight) ──────────────────────────────
const catalogRows = new Map(); // providerId → metadata
{
  // Locate every "providerId: 'xxx'" line, then walk forward to find the
  // matching closing brace at the same indent depth.
  const idRe = /^(\s*)providerId:\s*'([a-z0-9-]+)'/gm;
  const lines = catalogSrc.split('\n');
  const matches = [];
  let m;
  while ((m = idRe.exec(catalogSrc)) !== null) {
    const before = catalogSrc.slice(0, m.index);
    const lineNo = before.split('\n').length - 1;
    matches.push({ providerId: m[2], startLine: lineNo });
  }
  for (let i = 0; i < matches.length; i++) {
    const { providerId, startLine } = matches[i];
    const endLine = i + 1 < matches.length ? matches[i + 1].startLine : lines.length;
    const body = lines.slice(Math.max(0, startLine - 2), endLine).join('\n');
    const adapterClass = (body.match(/adapterClass:\s*'([^']+)'/) || [])[1] ?? null;
    const integrationMode = (body.match(/integrationMode:\s*'([^']+)'/) || [])[1] ?? null;
    const apiKeyEnvVar = (body.match(/apiKeyEnvVar:\s*'([A-Z_][A-Z0-9_]*)'/) || [])[1] ?? null;
    const apiKeyOptional = /apiKeyOptional:\s*true/.test(body);
    const enabledByDefault = !/enabledByDefault:\s*false/.test(body);
    const hasStaticModels = /staticModels:\s*\[/.test(body);
    const supports = {};
    for (const key of [
      'chat',
      'streaming',
      'tools',
      'embeddings',
      'jsonMode',
      'speechToText',
      'textToSpeech',
      'speechToSpeech',
      'image',
      'video',
    ]) {
      supports[key] = new RegExp(`${key}:\\s*true`).test(body);
    }
    catalogRows.set(providerId, {
      providerId,
      adapterClass,
      integrationMode,
      apiKeyEnvVar,
      apiKeyOptional,
      enabledByDefault,
      hasStaticModels,
      supports,
    });
  }
}

// ── Parse DISCOVERY_COMPLIANCE_REGISTRY ───────────────────────────────
// Structure: bucket-name: [provider1, provider2, ...]
//
// Phase 6 Fix 7 follow-up (2026-04-30): the bucket character class was
// `[a-z-]+`, which silently dropped the new `pinnedFallback-by-design`
// entry (camelCase F in 'Fallback'). The bucket name follows the
// inventoryClass Zod enum convention (camelCase + kebab) and cannot be
// renamed to all-lowercase without breaking the public API; widening the
// regex to `[a-zA-Z-]+` is the right fix.
const complianceRegistry = new Map();
{
  const block = complianceSrc.match(
    /DISCOVERY_COMPLIANCE_REGISTRY[\s\S]*?=\s*\{([\s\S]*?)\n\}\s*as\s+const/,
  );
  if (block) {
    const bucketRe = /'([a-zA-Z-]+)':\s*\[([\s\S]*?)\]/g;
    let bm;
    while ((bm = bucketRe.exec(block[1])) !== null) {
      const bucket = bm[1];
      const providerRe = /'([a-z0-9-]+)'/g;
      let pm;
      while ((pm = providerRe.exec(bm[2])) !== null) {
        complianceRegistry.set(pm[1], bucket);
      }
    }
  }
}

// ── Inventory fetcher files ───────────────────────────────────────────
const fetcherFiles = new Set(
  fs.readdirSync(FETCHERS_DIR)
    .filter((f) => f.endsWith('-model-fetcher.ts'))
    .map((f) => f.replace('-model-fetcher.ts', '')),
);

// ── Inventory adapter dirs ────────────────────────────────────────────
const adapterDirs = new Set(
  fs.readdirSync(ADAPTERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name),
);

// ── Build the inventory ───────────────────────────────────────────────
const universe = new Set([
  ...envToProvider.values(),
  ...catalogRows.keys(),
]);

const rows = [];
for (const providerId of universe) {
  const catalog = catalogRows.get(providerId);
  const envVar = catalog?.apiKeyEnvVar ?? [...envToProvider.entries()].find(([, v]) => v === providerId)?.[0] ?? null;
  const tuple = envVar ? providerSecrets.get(envVar) : null;
  const gcpMatch = tuple ? tuple.find((c) => gcpSecrets.has(c)) ?? null : null;

  const isAttributed = envVar ? envToProvider.has(envVar) : false;
  const isInLlmGate = envVar ? llmEnvVars.has(envVar) : false;
  const compliance = complianceRegistry.get(providerId) ?? 'unclassified';
  const fetcherExists = fetcherFiles.has(providerId);
  const adapterDirExists = adapterDirs.has(providerId);

  // Heuristic functional check
  let functional = 'unknown';
  if (catalog?.apiKeyOptional) {
    functional = 'self-hosted-or-optional';
  } else if (!envVar) {
    functional = 'missing-envVar';
  } else if (!tuple) {
    functional = 'no-loader-tuple';
  } else if (!gcpMatch) {
    functional = 'no-gcp-secret';
  } else if (!isAttributed) {
    functional = 'no-attribution';
  } else {
    functional = 'wired';
  }

  rows.push({
    providerId,
    envVar,
    functional,
    gcpMatch: gcpMatch ? `${GCP_SECRETS_PREFIX}${gcpMatch}` : null,
    catalogPresent: !!catalog,
    integrationMode: catalog?.integrationMode ?? null,
    adapterClass: catalog?.adapterClass ?? null,
    enabledByDefault: catalog?.enabledByDefault ?? null,
    hasStaticModels: catalog?.hasStaticModels ?? false,
    inLlmGate: isInLlmGate,
    isLlmClass: catalog ? (
      catalog.supports.chat || catalog.supports.streaming || catalog.supports.tools ||
      catalog.supports.embeddings || catalog.supports.jsonMode ||
      catalog.supports.speechToText || catalog.supports.textToSpeech ||
      catalog.supports.speechToSpeech
    ) : null,
    isImageOrVideoOnly: catalog ? (
      (catalog.supports.image || catalog.supports.video) &&
      !catalog.supports.chat && !catalog.supports.embeddings && !catalog.supports.streaming
    ) : null,
    compliance,
    fetcherExists,
    adapterDirExists,
  });
}

// ── Filter to functional providers ────────────────────────────────────
const functional = rows.filter((r) => r.functional === 'wired');
functional.sort((a, b) => a.providerId.localeCompare(b.providerId));

// ── Identify structural mismatches ────────────────────────────────────
const flags = [];
for (const r of functional) {
  // Flag 1: no catalog row but env mapping exists
  if (!r.catalogPresent) {
    flags.push({ severity: 'high', providerId: r.providerId, issue: 'env mapping exists but NO catalog row' });
  }
  // Flag 2: native fetcher missing for compliant-dynamic-discovery providers
  if (
    r.compliance === 'compliant-dynamic-discovery' &&
    r.integrationMode === 'native' &&
    !r.fetcherExists
  ) {
    flags.push({ severity: 'high', providerId: r.providerId, issue: `native+compliant-dynamic-discovery but no fetcher in model-fetchers/ (expected ${r.providerId}-model-fetcher.ts)` });
  }
  // Flag 3: hardcoded inventory
  if (r.compliance === 'non-compliant-hardcoded-inventory') {
    flags.push({ severity: 'medium', providerId: r.providerId, issue: 'has staticModels (hardcoded inventory)' });
  }
  // Flag 4: runtime not materialized
  if (r.compliance === 'non-compliant-runtime-not-materialized') {
    flags.push({ severity: 'medium', providerId: r.providerId, issue: 'classified runtime-not-materialized — discovery output never stored' });
  }
  // Flag 5: no machine-readable discovery
  if (r.compliance === 'non-compliant-no-machine-readable-discovery') {
    flags.push({ severity: 'medium', providerId: r.providerId, issue: 'no machine-readable discovery surface' });
  }
  // Flag 6: LLM-class but missing from boot gate
  if (r.isLlmClass && !r.inLlmGate && !r.isImageOrVideoOnly) {
    flags.push({ severity: 'high', providerId: r.providerId, issue: 'LLM-class but env var not in LLM_PROVIDER_ENV_VARS (J8 violation pending)' });
  }
  // Flag 7: enabledByDefault false but functional
  if (r.enabledByDefault === false) {
    flags.push({ severity: 'low', providerId: r.providerId, issue: `enabledByDefault: false (won't materialize at boot unless ${r.envVar} is in env)` });
  }
}

// ── Output ────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log(`FUNCTIONAL PROVIDERS — auth secret wired AND exists in GCP`);
console.log(`Total wired: ${functional.length}`);
console.log('═══════════════════════════════════════════════════════════\n');

// Group by integration mode
const byMode = {};
for (const r of functional) {
  const k = r.integrationMode ?? 'unknown';
  byMode[k] = byMode[k] || [];
  byMode[k].push(r);
}
for (const mode of Object.keys(byMode).sort()) {
  console.log(`── integrationMode: ${mode} (${byMode[mode].length}) ──`);
  for (const r of byMode[mode]) {
    const fetcher = r.fetcherExists ? '✓' : '✗';
    const adapter = r.adapterDirExists ? '✓' : '✗';
    const llm = r.inLlmGate ? 'L' : (r.isImageOrVideoOnly ? 'I/V' : '-');
    const en = r.enabledByDefault ? 'on' : 'off';
    console.log(
      `  ${r.providerId.padEnd(22)} env=${(r.envVar ?? '-').padEnd(28)} cls=${(r.adapterClass ?? '-').padEnd(28)} fetcher=${fetcher} adapter=${adapter} gate=${llm} default=${en} compliance=${r.compliance}`
    );
  }
  console.log('');
}

// Flags
console.log('═══════════════════════════════════════════════════════════');
console.log(`STRUCTURAL FLAGS (${flags.length})`);
console.log('═══════════════════════════════════════════════════════════');
flags.sort((a, b) => {
  const order = { high: 0, medium: 1, low: 2 };
  return (order[a.severity] - order[b.severity]) || a.providerId.localeCompare(b.providerId);
});
for (const f of flags) {
  const tag = f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🟢';
  console.log(`  ${tag} ${f.severity.padEnd(7)} ${f.providerId.padEnd(22)} ${f.issue}`);
}

// Summary
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`SUMMARY`);
console.log('═══════════════════════════════════════════════════════════');
console.log(`functional providers:           ${functional.length}`);
console.log(`  with native fetcher file:     ${functional.filter((r) => r.fetcherExists).length}`);
console.log(`  with adapter dir:             ${functional.filter((r) => r.adapterDirExists).length}`);
console.log(`  in LLM boot gate:             ${functional.filter((r) => r.inLlmGate).length}`);
console.log(`  enabledByDefault=true:        ${functional.filter((r) => r.enabledByDefault === true).length}`);
console.log(`  compliant-dynamic-discovery:  ${functional.filter((r) => r.compliance === 'compliant-dynamic-discovery').length}`);
console.log(`  pinnedFallback-by-design:     ${functional.filter((r) => r.compliance === 'pinnedFallback-by-design').length}`);
console.log(`  hardcoded-inventory:          ${functional.filter((r) => r.compliance === 'non-compliant-hardcoded-inventory').length}`);
console.log(`  runtime-not-materialized:     ${functional.filter((r) => r.compliance === 'non-compliant-runtime-not-materialized').length}`);
console.log(`structural flags:               ${flags.length}`);
console.log(`  high:                         ${flags.filter((f) => f.severity === 'high').length}`);
console.log(`  medium:                       ${flags.filter((f) => f.severity === 'medium').length}`);
console.log(`  low:                          ${flags.filter((f) => f.severity === 'low').length}`);
