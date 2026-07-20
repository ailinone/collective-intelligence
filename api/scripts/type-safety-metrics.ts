// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Type Safety Metrics Script
 * 
 * Generates metrics and reports on type safety across the codebase.
 * Useful for tracking type safety improvements over time.
 * 
 * Usage:
 *   pnpm tsx scripts/type-safety-metrics.ts
 *   pnpm tsx scripts/type-safety-metrics.ts --json  # Output as JSON
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { writeFileSync } from 'fs';

interface Metrics {
  timestamp: string;
  totalFiles: number;
  totalLines: number;
  violations: {
    any: number;
    asUnknownAs: number;
    asAny: number;
    total: number;
  };
  filesWithViolations: number;
  violationRate: number; // violations per 1000 lines
  productionFiles: number;
  testFiles: number;
}

const PRODUCTION_PATHS = [
  'src/routes',
  'src/middleware',
  'src/services',
  'src/providers',
  'src/core',
  'src/utils',
  'src/workers',
  'src/infrastructure',
  'src/runtime',
  'src/database',
  'src/types',
  'src/application',
  'src/domain',
  'src/client',
  'src/cache',
  'src/config',
];

const TEST_PATTERNS = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /__tests__/,
];

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(filePath));
}

function countViolations(filePath: string): { any: number; asUnknownAs: number; asAny: number } {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let anyCount = 0;
  let asUnknownAsCount = 0;
  let asAnyCount = 0;

  lines.forEach((line) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
      return; // Skip comments
    }

    // Count ': any' (but not in comments)
    const anyMatches = line.match(/(:\s*any\b|:\s*any\[|:\s*any\s*[|&])/g);
    if (anyMatches) {
      anyCount += anyMatches.length;
    }

    // Count 'as unknown as'
    const asUnknownAsMatches = line.match(/as\s+unknown\s+as/g);
    if (asUnknownAsMatches) {
      asUnknownAsCount += asUnknownAsMatches.length;
    }

    // Count 'as any'
    const asAnyMatches = line.match(/as\s+any\b/g);
    if (asAnyMatches) {
      asAnyCount += asAnyMatches.length;
    }
  });

  return { any: anyCount, asUnknownAs: asUnknownAsCount, asAny: asAnyCount };
}

function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  return content.split('\n').length;
}

function scanDirectory(dirPath: string, basePath: string): {
  files: Array<{ path: string; isTest: boolean; lines: number; violations: ReturnType<typeof countViolations> }>;
} {
  const files: Array<{ path: string; isTest: boolean; lines: number; violations: ReturnType<typeof countViolations> }> = [];
  const entries = readdirSync(dirPath);

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const relativePath = relative(basePath, fullPath);

    if (relativePath.includes('node_modules') || relativePath.includes('dist') || relativePath.includes('coverage')) {
      continue;
    }

    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const subFiles = scanDirectory(fullPath, basePath);
      files.push(...subFiles.files);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      const isTest = isTestFile(relativePath);
      const lines = countLines(fullPath);
      const violations = countViolations(fullPath);
      files.push({ path: relativePath, isTest, lines, violations });
    }
  }

  return { files };
}

function generateMetrics(): Metrics {
  const basePath = join(__dirname, '..');
  const allFiles: Array<{ path: string; isTest: boolean; lines: number; violations: ReturnType<typeof countViolations> }> = [];

  // Scan production paths
  for (const path of PRODUCTION_PATHS) {
    const fullPath = join(basePath, path);
    try {
      if (statSync(fullPath).isDirectory()) {
        const result = scanDirectory(fullPath, basePath);
        allFiles.push(...result.files);
      }
    } catch (error) {
      // Path doesn't exist, skip
    }
  }

  // Calculate metrics
  const productionFiles = allFiles.filter((f) => !f.isTest);
  const testFiles = allFiles.filter((f) => f.isTest);

  const totalLines = allFiles.reduce((sum, f) => sum + f.lines, 0);
  const totalViolations = {
    any: allFiles.reduce((sum, f) => sum + f.violations.any, 0),
    asUnknownAs: allFiles.reduce((sum, f) => sum + f.violations.asUnknownAs, 0),
    asAny: allFiles.reduce((sum, f) => sum + f.violations.asAny, 0),
  };

  const filesWithViolations = allFiles.filter(
    (f) => f.violations.any > 0 || f.violations.asUnknownAs > 0 || f.violations.asAny > 0
  ).length;

  const violationRate = totalLines > 0 ? ((totalViolations.any + totalViolations.asUnknownAs + totalViolations.asAny) / totalLines) * 1000 : 0;

  return {
    timestamp: new Date().toISOString(),
    totalFiles: allFiles.length,
    totalLines,
    violations: {
      ...totalViolations,
      total: totalViolations.any + totalViolations.asUnknownAs + totalViolations.asAny,
    },
    filesWithViolations,
    violationRate: Math.round(violationRate * 100) / 100,
    productionFiles: productionFiles.length,
    testFiles: testFiles.length,
  };
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  console.log('📊 Generating Type Safety Metrics...\n');

  const metrics = generateMetrics();

  if (jsonOutput) {
    console.log(JSON.stringify(metrics, null, 2));
    // Also save to file
    const outputPath = join(__dirname, '..', 'type-safety-metrics.json');
    writeFileSync(outputPath, JSON.stringify(metrics, null, 2));
    console.error(`\nMetrics saved to: ${outputPath}`);
  } else {
    console.log('📈 Type Safety Metrics\n');
    console.log(`Timestamp: ${metrics.timestamp}`);
    console.log(`Total Files: ${metrics.totalFiles} (${metrics.productionFiles} production, ${metrics.testFiles} test)`);
    console.log(`Total Lines: ${metrics.totalLines.toLocaleString()}`);
    console.log(`\nViolations:`);
    console.log(`  - 'any' types: ${metrics.violations.any}`);
    console.log(`  - 'as unknown as': ${metrics.violations.asUnknownAs}`);
    console.log(`  - 'as any': ${metrics.violations.asAny}`);
    console.log(`  - Total: ${metrics.violations.total}`);
    console.log(`\nFiles with violations: ${metrics.filesWithViolations}`);
    console.log(`Violation rate: ${metrics.violationRate} per 1000 lines\n`);

    // Health status
    if (metrics.violations.total === 0) {
      console.log('✅ Perfect! No type safety violations found.\n');
    } else if (metrics.violationRate < 0.1) {
      console.log('✅ Excellent! Very low violation rate.\n');
    } else if (metrics.violationRate < 1) {
      console.log('⚠️  Good, but there\'s room for improvement.\n');
    } else {
      console.log('❌ High violation rate. Consider reviewing type safety practices.\n');
    }
  }
}

main();
