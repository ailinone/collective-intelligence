// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

const fs = require('node:fs');
const path = require('node:path');

const SPEC_PATH = path.join('openapi-spec.json');
const OUTPUT_PATH = path.join('docs', 'reference', 'endpoints-catalog.md');
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

function escapeCell(value = '') {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function getEffectiveSecurity(operation, pathItem, globalSecurity) {
  if (Object.prototype.hasOwnProperty.call(operation, 'security')) {
    return operation.security;
  }
  if (Object.prototype.hasOwnProperty.call(pathItem, 'security')) {
    return pathItem.security;
  }
  return globalSecurity;
}

function schemeLabel(schemeName) {
  if (schemeName === 'bearerAuth') return 'Bearer';
  if (schemeName === 'apiKeyAuth') return 'API Key';
  return schemeName;
}

function describeRequirement(requirement) {
  if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
    return '';
  }
  const schemes = Object.keys(requirement);
  if (schemes.length === 0) return 'Public';
  if (schemes.length === 1) return schemeLabel(schemes[0]);
  return `${schemes.map(schemeLabel).join(' + ')} (AND)`;
}

function getSecurityProfile(operation, pathItem, globalSecurity) {
  const security = getEffectiveSecurity(operation, pathItem, globalSecurity);

  if (!Array.isArray(security) || security.length === 0) {
    return { label: 'Public', isPublic: true };
  }

  const alternatives = [];
  for (const requirement of security) {
    const description = describeRequirement(requirement);
    if (!description || description === 'Public') continue;
    if (!alternatives.includes(description)) alternatives.push(description);
  }

  if (alternatives.length === 0) {
    return { label: 'Public', isPublic: true };
  }

  return {
    label: alternatives.join(' or '),
    isPublic: false,
  };
}

function groupByTag(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.tag)) groups.set(row.tag, []);
    groups.get(row.tag).push(row);
  }
  return groups;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function renderTable(rows, includeAuth) {
  let block = '';
  if (includeAuth) {
    block += '| Method | Path | Summary | Auth | Operation ID |\n';
    block += '|---|---|---|---|---|\n';
    for (const row of rows) {
      block += `| ${escapeCell(row.method)} | \`${escapeCell(row.path)}\` | ${escapeCell(row.summary)} | ${escapeCell(row.auth)} | \`${escapeCell(row.operationId)}\` |\n`;
    }
    return block;
  }

  block += '| Method | Path | Summary | Operation ID |\n';
  block += '|---|---|---|---|\n';
  for (const row of rows) {
    block += `| ${escapeCell(row.method)} | \`${escapeCell(row.path)}\` | ${escapeCell(row.summary)} | \`${escapeCell(row.operationId)}\` |\n`;
  }
  return block;
}

function renderSections(title, rows, includeAuth) {
  let block = `## ${title} (${rows.length})\n\n`;
  if (rows.length === 0) {
    block += 'No operations in this section.\n\n';
    return block;
  }

  const groups = groupByTag(rows);
  const sortedTags = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  for (const tag of sortedTags) {
    const tagRows = sortRows(groups.get(tag));
    block += `### ${tag} (${tagRows.length})\n\n`;
    block += renderTable(tagRows, includeAuth);
    block += '\n';
  }

  return block;
}

function main() {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const paths = spec.paths || {};
  const globalSecurity = Array.isArray(spec.security) ? spec.security : [];

  const rows = [];
  let operationCount = 0;

  for (const [routePath, pathItem] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      operationCount += 1;
      const tag = Array.isArray(operation.tags) && operation.tags.length > 0
        ? operation.tags[0]
        : 'Uncategorized';
      const security = getSecurityProfile(operation, pathItem, globalSecurity);

      rows.push({
        method: method.toUpperCase(),
        path: routePath,
        tag,
        summary: operation.summary || '',
        operationId: operation.operationId || '',
        auth: security.label,
        isPublic: security.isPublic,
      });
    }
  }

  const publicRows = rows.filter((row) => row.isPublic);
  const authenticatedRows = rows.filter((row) => !row.isPublic);

  let output = '';
  output += '# Endpoints Catalog (OpenAPI)\n\n';
  output += 'This page is generated from `ci/openapi-spec.json`.\n\n';
  output += `- Total paths: ${Object.keys(paths).length}\n`;
  output += `- Total operations: ${operationCount}\n\n`;
  output += '## Auth Semantics\n\n';
  output += '- OpenAPI `security` array means **OR** between entries.\n';
  output += '- Multiple schemes in one security object mean **AND**.\n';
  output += '- Canonical API key header is `X-API-Key`.\n\n';
  output += '## Surface Split\n\n';
  output += `- Public operations (` + '`security: []`' + `): ${publicRows.length}\n`;
  output += `- Authenticated operations: ${authenticatedRows.length}\n\n`;

  output += renderSections('Public API (No Auth Required)', publicRows, false);
  output += renderSections('Authenticated API', authenticatedRows, true);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');
  process.stdout.write(`Generated ${OUTPUT_PATH}\n`);
}

main();
