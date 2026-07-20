// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Type Safety Validation Script
 * 
 * This script validates that the codebase maintains strict type safety by:
 * 1. Checking for 'any' and 'as unknown as' usage in production code
 * 2. Running TypeScript compiler checks
 * 3. Generating a report of violations
 * 
 * Usage:
 *   pnpm tsx scripts/validate-type-safety.ts
 *   pnpm tsx scripts/validate-type-safety.ts --strict  # Fail on any violations
 *
 * Suppression: a line containing `ts-safety-ignore` is skipped. Reserve this
 * for FALSE POSITIVES only (e.g. the literal word `any` inside a string/prompt
 * payload, never an actual `any` type) and always pair it with a `--` reason.
 * Reviewers can grep `ts-safety-ignore` to audit every suppression.
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

interface Violation {
  file: string;
  line: number;
  column: number;
  type: 'any' | 'as-unknown-as' | 'as-any';
  code: string;
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

const EXCLUDED_PATTERNS = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /__tests__/,
  /node_modules/,
  /dist/,
  /coverage/,
];

function isExcluded(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath));
}

function findViolations(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    // Explicit, auditable suppression for false positives (see header doc):
    // same-line marker, or `ts-safety-ignore-next-line` on the previous line.
    if (line.includes('ts-safety-ignore')) {
      return;
    }
    if (index > 0 && lines[index - 1].includes('ts-safety-ignore-next-line')) {
      return;
    }

    // Check for ': any' (but not in comments)
    if (!line.trim().startsWith('//') && !line.trim().startsWith('*')) {
      const anyMatch = line.match(/(:\s*any\b|:\s*any\[|:\s*any\s*[|&])/);
      if (anyMatch) {
        violations.push({
          file: filePath,
          line: lineNumber,
          column: (anyMatch.index || 0) + 1,
          type: 'any',
          code: line.trim().substring(0, 100),
        });
      }

      // Check for 'as unknown as'
      const asUnknownAsMatch = line.match(/as\s+unknown\s+as/);
      if (asUnknownAsMatch) {
        violations.push({
          file: filePath,
          line: lineNumber,
          column: (asUnknownAsMatch.index || 0) + 1,
          type: 'as-unknown-as',
          code: line.trim().substring(0, 100),
        });
      }

      // Check for 'as any'
      const asAnyMatch = line.match(/as\s+any\b/);
      if (asAnyMatch) {
        violations.push({
          file: filePath,
          line: lineNumber,
          column: (asAnyMatch.index || 0) + 1,
          type: 'as-any',
          code: line.trim().substring(0, 100),
        });
      }
    }
  });

  return violations;
}

function scanDirectory(dirPath: string, basePath: string): Violation[] {
  const violations: Violation[] = [];
  const entries = readdirSync(dirPath);

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const relativePath = relative(basePath, fullPath);

    if (isExcluded(relativePath)) {
      continue;
    }

    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      violations.push(...scanDirectory(fullPath, basePath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      violations.push(...findViolations(fullPath));
    }
  }

  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const strictMode = args.includes('--strict');

  console.log('🔍 Type Safety Validation\n');
  console.log('Scanning production code for type safety violations...\n');

  const basePath = join(__dirname, '..');
  const violations: Violation[] = [];

  // Scan production paths
  for (const path of PRODUCTION_PATHS) {
    const fullPath = join(basePath, path);
    try {
      if (statSync(fullPath).isDirectory()) {
        violations.push(...scanDirectory(fullPath, basePath));
      }
    } catch (error) {
      // Path doesn't exist, skip
    }
  }

  // Group violations by file
  const violationsByFile = new Map<string, Violation[]>();
  for (const violation of violations) {
    const relativeFile = relative(basePath, violation.file);
    if (!violationsByFile.has(relativeFile)) {
      violationsByFile.set(relativeFile, []);
    }
    violationsByFile.get(relativeFile)!.push(violation);
  }

  // Print report
  if (violations.length === 0) {
    console.log('✅ No type safety violations found in production code!\n');
  } else {
    console.log(`❌ Found ${violations.length} type safety violation(s) in ${violationsByFile.size} file(s):\n`);

    for (const [file, fileViolations] of violationsByFile.entries()) {
      console.log(`📄 ${file}`);
      for (const violation of fileViolations) {
        const typeLabel = violation.type === 'any' ? 'any' : violation.type === 'as-unknown-as' ? 'as unknown as' : 'as any';
        console.log(`   Line ${violation.line}:${violation.column} - ${typeLabel}`);
        console.log(`   ${violation.code}`);
      }
      console.log('');
    }
  }

  // Run TypeScript compiler check
  console.log('🔧 Running TypeScript compiler check...\n');
  try {
    execSync('npx tsc --noEmit', { stdio: 'inherit', cwd: basePath });
    console.log('\n✅ TypeScript compilation successful!\n');
  } catch (error) {
    console.log('\n❌ TypeScript compilation failed!\n');
    if (strictMode) {
      process.exit(1);
    }
  }

  // Exit with error if violations found in strict mode
  if (strictMode && violations.length > 0) {
    console.log('❌ Strict mode: Failing due to type safety violations\n');
    process.exit(1);
  }

  // Summary
  console.log('📊 Summary:');
  console.log(`   Production files scanned: ${PRODUCTION_PATHS.length} directories`);
  console.log(`   Violations found: ${violations.length}`);
  console.log(`   Files with violations: ${violationsByFile.size}`);
  console.log('');
}

main();
