// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import fs from 'node:fs';
import path from 'node:path';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;
const CI_ROOT = path.join(__dirname, '..', '..');
const SPEC_PATH = path.join(CI_ROOT, 'openapi-spec.json');

type OpenApiSpec = {
  paths?: Record<string, Record<string, Record<string, unknown> | undefined> | undefined>;
};

type MissingIssue = {
  method: string;
  path: string;
};

function readSpec(): OpenApiSpec {
  if (!fs.existsSync(SPEC_PATH)) {
    throw new Error(`OpenAPI spec not found at ${SPEC_PATH}. Generate it first.`);
  }

  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  return JSON.parse(raw) as OpenApiSpec;
}

function main(): void {
  const spec = readSpec();
  const paths = spec.paths ?? {};

  const missingOperationId: MissingIssue[] = [];
  const missingTags: MissingIssue[] = [];
  const missingCollectiveMetadata: MissingIssue[] = [];

  const operationIds = new Map<string, MissingIssue>();
  const duplicateOperationIds: Array<{ id: string; first: MissingIssue; second: MissingIssue }> = [];

  let totalOperations = 0;

  for (const [routePath, routeNode] of Object.entries(paths)) {
    if (!routeNode) continue;

    for (const method of METHODS) {
      const operation = routeNode[method];
      if (!operation || typeof operation !== 'object') continue;

      totalOperations += 1;
      const typedOperation = operation as Record<string, unknown>;
      const issue = { method: method.toUpperCase(), path: routePath };

      const operationId = typedOperation.operationId;
      if (typeof operationId !== 'string' || operationId.trim().length === 0) {
        missingOperationId.push(issue);
      } else {
        const normalized = operationId.trim();
        const existing = operationIds.get(normalized);
        if (existing) {
          duplicateOperationIds.push({
            id: normalized,
            first: existing,
            second: issue,
          });
        } else {
          operationIds.set(normalized, issue);
        }
      }

      const tags = typedOperation.tags;
      if (!Array.isArray(tags) || tags.length === 0) {
        missingTags.push(issue);
      }

      if (!Object.prototype.hasOwnProperty.call(typedOperation, 'x-collective-intelligence')) {
        missingCollectiveMetadata.push(issue);
      }
    }
  }

  const summary = {
    specPath: path.relative(CI_ROOT, SPEC_PATH),
    totalOperations,
    operationIds: operationIds.size,
    missingOperationId: missingOperationId.length,
    missingTags: missingTags.length,
    missingCollectiveMetadata: missingCollectiveMetadata.length,
    duplicateOperationIds: duplicateOperationIds.length,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    missingOperationId.length > 0
    || missingTags.length > 0
    || missingCollectiveMetadata.length > 0
    || duplicateOperationIds.length > 0
  ) {
    const details = [
      missingOperationId.length > 0
        ? `missing operationId: ${missingOperationId.slice(0, 8).map((item) => `${item.method} ${item.path}`).join(', ')}`
        : null,
      missingTags.length > 0
        ? `missing tags: ${missingTags.slice(0, 8).map((item) => `${item.method} ${item.path}`).join(', ')}`
        : null,
      missingCollectiveMetadata.length > 0
        ? `missing x-collective-intelligence: ${missingCollectiveMetadata.slice(0, 8).map((item) => `${item.method} ${item.path}`).join(', ')}`
        : null,
      duplicateOperationIds.length > 0
        ? `duplicate operationId: ${duplicateOperationIds.slice(0, 8).map((item) => `${item.id} (${item.first.method} ${item.first.path} <> ${item.second.method} ${item.second.path})`).join(', ')}`
        : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join('\n');

    throw new Error(`collective contract validation failed\n${details}`);
  }

  console.log('collective contract validation passed');
}

main();
