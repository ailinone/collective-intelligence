// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';

async function exists(dir: string): Promise<boolean> {
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
}

async function validateDashboards(rootDir: string): Promise<void> {
  const dashboardsDir = path.join(rootDir, 'observability', 'dashboards');
  if (!(await exists(dashboardsDir))) {
    console.warn(`[observability] Dashboards directory not found: ${dashboardsDir}`);
    return;
  }

  const files = await readdir(dashboardsDir);
  const jsonFiles = files.filter((file) => file.endsWith('.json'));

  if (jsonFiles.length === 0) {
    throw new Error(`No dashboard JSON files found in ${dashboardsDir}`);
  }

  for (const file of jsonFiles) {
    const fullPath = path.join(dashboardsDir, file);
    const payload = await readFile(fullPath, 'utf-8');
    try {
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Parsed dashboard is not an object');
      }
    } catch (error) {
      throw new Error(`Invalid JSON dashboard (${file}): ${(error as Error).message}`);
    }
  }
}

async function validateAlertRules(rootDir: string): Promise<void> {
  const alertsDir = path.join(rootDir, 'observability', 'alerts');
  if (!(await exists(alertsDir))) {
    console.warn(`[observability] Alerts directory not found: ${alertsDir}`);
    return;
  }

  const files = await readdir(alertsDir);
  const yamlFiles = files.filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'));

  if (yamlFiles.length === 0) {
    throw new Error(`No alert rule YAML files found in ${alertsDir}`);
  }

  for (const file of yamlFiles) {
    const fullPath = path.join(alertsDir, file);
    const payload = await readFile(fullPath, 'utf-8');
    try {
      const parsed = parseYaml(payload);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Parsed YAML is not an object');
      }
    } catch (error) {
      throw new Error(`Invalid YAML alert rules (${file}): ${(error as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rootDir = path.resolve(__dirname, '..', '..');

  await validateDashboards(rootDir);
  await validateAlertRules(rootDir);

  console.log('✅ Observability assets validated');
}

main().catch((error) => {
  console.error('❌ Observability asset validation failed:', error);
  process.exit(1);
});

