// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

type BaselineConfig = {
  strictRoutePrefixes: string[];
  legacyAllowedDirectDbAccessRoutes: string[];
};

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(PROJECT_ROOT, 'scripts', 'architecture-boundaries.baseline.json');
const ROUTE_DIRECTORIES = [
  path.join(PROJECT_ROOT, 'src', 'routes'),
  path.join(PROJECT_ROOT, 'src', 'api', 'routes'),
];

const DIRECT_DB_IMPORT_PATTERNS = [
  /from\s+['"][^'"]*database\/client(?:\.js)?['"]/,
  /import\(\s*['"][^'"]*database\/client(?:\.js)?['"]\s*\)/,
];

function normalizeProjectRelative(filePath: string): string {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function isRouteSourceFile(relativePath: string): boolean {
  if (!relativePath.endsWith('.ts')) {
    return false;
  }

  if (relativePath.includes('/__tests__/')) {
    return false;
  }

  if (relativePath.endsWith('.test.ts') || relativePath.endsWith('.spec.ts')) {
    return false;
  }

  return true;
}

async function collectFilesRecursively(directoryPath: string): Promise<string[]> {
  if (!existsSync(directoryPath)) {
    return [];
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(fullPath)));
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

async function loadBaselineConfig(): Promise<BaselineConfig> {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`Architecture baseline file not found: ${BASELINE_PATH}`);
  }

  const raw = await readFile(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Partial<BaselineConfig>;

  return {
    strictRoutePrefixes: parsed.strictRoutePrefixes ?? [],
    legacyAllowedDirectDbAccessRoutes: parsed.legacyAllowedDirectDbAccessRoutes ?? [],
  };
}

function hasDirectDatabaseImport(source: string): boolean {
  return DIRECT_DB_IMPORT_PATTERNS.some((pattern) => pattern.test(source));
}

async function findRouteFilesWithDirectDbImport(): Promise<string[]> {
  const allFilesNested = await Promise.all(
    ROUTE_DIRECTORIES.map((routeDir) => collectFilesRecursively(routeDir))
  );

  const candidateFiles = allFilesNested
    .flat()
    .map((filePath) => normalizeProjectRelative(filePath))
    .filter((relativePath) => isRouteSourceFile(relativePath));

  const violations: string[] = [];

  for (const relativePath of candidateFiles) {
    const absolutePath = path.join(PROJECT_ROOT, relativePath);
    const source = await readFile(absolutePath, 'utf8');
    if (hasDirectDatabaseImport(source)) {
      violations.push(relativePath);
    }
  }

  return violations.sort();
}

function list(prefix: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }
  console.log(prefix);
  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

async function main(): Promise<void> {
  const baseline = await loadBaselineConfig();
  const violationFiles = await findRouteFilesWithDirectDbImport();

  const strictPrefixes = baseline.strictRoutePrefixes.map((prefix) => prefix.replace(/\\/g, '/'));
  const legacyAllowed = new Set(
    baseline.legacyAllowedDirectDbAccessRoutes.map((filePath) => filePath.replace(/\\/g, '/'))
  );

  const strictViolations = violationFiles.filter((filePath) =>
    strictPrefixes.some((prefix) => filePath.startsWith(prefix))
  );

  const newViolations = violationFiles.filter(
    (filePath) => !legacyAllowed.has(filePath) && !strictViolations.includes(filePath)
  );

  const staleLegacyEntries = [...legacyAllowed]
    .filter((filePath) => !violationFiles.includes(filePath))
    .sort();

  console.log('Architecture boundary check: routes must not import @/database/client directly.');
  console.log(`Detected direct DB access in routes: ${violationFiles.length}`);
  list('Strict-area violations (always fail):', strictViolations);
  list('New violations (not in legacy allowlist):', newViolations);
  list('Legacy allowlist entries no longer violating (safe to remove):', staleLegacyEntries);

  if (strictViolations.length > 0 || newViolations.length > 0) {
    console.error('\nArchitecture boundary check failed.');
    process.exitCode = 1;
    return;
  }

  console.log('Architecture boundary check passed.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Architecture boundary check crashed: ${message}`);
  process.exitCode = 1;
});
