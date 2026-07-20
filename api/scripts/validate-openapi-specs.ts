// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

type OpenApiSpec = {
  openapi?: string;
  info?: Record<string, unknown>;
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CI_ROOT = path.resolve(__dirname, '..', '..');
const JSON_SPEC_PATH = path.join(CI_ROOT, 'openapi-spec.json');
const YAML_SPEC_PATH = path.join(CI_ROOT, 'openapi-spec.yaml');
const CONTRACT_CHECK_SCRIPT = path.join(CI_ROOT, 'contract-tests', 'openapi-contract-check.js');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalize(value[key]);
    }
    return output;
  }
  return value;
}

function safeParseJson(filePath: string): OpenApiSpec {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain a JSON object`);
  }
  return parsed as OpenApiSpec;
}

function safeParseYaml(filePath: string): OpenApiSpec {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = yaml.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain a YAML object`);
  }
  return parsed as OpenApiSpec;
}

function assertBasicOpenApiShape(spec: OpenApiSpec, label: string): void {
  if (typeof spec.openapi !== 'string' || spec.openapi.length === 0) {
    throw new Error(`${label}: missing/invalid openapi version`);
  }

  if (!isRecord(spec.info)) {
    throw new Error(`${label}: missing info block`);
  }

  if (!isRecord(spec.paths) || Object.keys(spec.paths).length === 0) {
    throw new Error(`${label}: missing paths block`);
  }
}

function assertJsonAndYamlAreConsistent(jsonSpec: OpenApiSpec, yamlSpec: OpenApiSpec): void {
  const normalizedJson = JSON.stringify(canonicalize(jsonSpec));
  const normalizedYaml = JSON.stringify(canonicalize(yamlSpec));

  if (normalizedJson !== normalizedYaml) {
    const jsonPathCount = Object.keys(jsonSpec.paths ?? {}).length;
    const yamlPathCount = Object.keys(yamlSpec.paths ?? {}).length;
    const jsonSchemaCount = Object.keys((jsonSpec.components?.schemas as Record<string, unknown>) ?? {}).length;
    const yamlSchemaCount = Object.keys((yamlSpec.components?.schemas as Record<string, unknown>) ?? {}).length;

    throw new Error(
      [
        'openapi-spec.json and openapi-spec.yaml are not semantically equivalent.',
        `JSON paths: ${jsonPathCount}, YAML paths: ${yamlPathCount}`,
        `JSON schemas: ${jsonSchemaCount}, YAML schemas: ${yamlSchemaCount}`,
      ].join('\n')
    );
  }
}

function runContractCheck(specJsonPath: string): void {
  const result = spawnSync(process.execPath, [CONTRACT_CHECK_SCRIPT, specJsonPath], {
    cwd: CI_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error(`Contract check failed for ${path.basename(specJsonPath)}`);
  }
}

function main(): void {
  if (!existsSync(JSON_SPEC_PATH)) {
    throw new Error(`Missing OpenAPI JSON spec at ${JSON_SPEC_PATH}`);
  }
  if (!existsSync(YAML_SPEC_PATH)) {
    throw new Error(`Missing OpenAPI YAML spec at ${YAML_SPEC_PATH}`);
  }
  if (!existsSync(CONTRACT_CHECK_SCRIPT)) {
    throw new Error(`Missing contract checker script at ${CONTRACT_CHECK_SCRIPT}`);
  }

  const jsonSpec = safeParseJson(JSON_SPEC_PATH);
  const yamlSpec = safeParseYaml(YAML_SPEC_PATH);

  assertBasicOpenApiShape(jsonSpec, 'openapi-spec.json');
  assertBasicOpenApiShape(yamlSpec, 'openapi-spec.yaml');
  assertJsonAndYamlAreConsistent(jsonSpec, yamlSpec);

  console.log('OpenAPI consistency check passed between JSON and YAML specs.');

  runContractCheck(JSON_SPEC_PATH);

  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'openapi-yaml-contract-'));
  const tempJsonPath = path.join(tempDirectory, 'openapi-spec-from-yaml.json');
  try {
    writeFileSync(tempJsonPath, JSON.stringify(yamlSpec, null, 2), 'utf8');
    runContractCheck(tempJsonPath);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }

  console.log('OpenAPI validation passed for both root specs.');
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`OpenAPI validation failed: ${message}`);
  process.exitCode = 1;
}
