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

const DOCS_ROOT = path.resolve('docs');

const REQUIRED_FILES = [
  'docs/README.md',
  'docs/SUMMARY.md',
  'docs/getting-started/introduction.md',
  'docs/getting-started/overview.md',
  'docs/getting-started/quickstart.md',
  'docs/getting-started/installation.md',
  'docs/getting-started/first-30-minutes.md',
  'docs/guides/migration-guide.md',
  'docs/guides/authentication.md',
  'docs/guides/errors-rate-limits.md',
  'docs/guides/model-aliases-and-routing.md',
  'docs/guides/pricing-billing-margin.md',
  'docs/integration/typescript-sdk.md',
  'docs/integration/python-sdk.md',
  'docs/integration/openai-compatibility-mapping.md',
  'docs/personas/developer.md',
  'docs/personas/platform-sre.md',
  'docs/personas/security-governance.md',
  'docs/personas/product-ops.md',
  'docs/use-cases/basic-chat.md',
  'docs/use-cases/streaming-and-tools.md',
  'docs/use-cases/multi-model-consensus.md',
  'docs/use-cases/cost-capped-routing.md',
  'docs/use-cases/realtime-session.md',
  'docs/use-cases/enterprise-governance.md',
  'docs/architecture/system-context.md',
  'docs/architecture/container-view.md',
  'docs/architecture/request-sequences.md',
  'docs/architecture/data-flow-memory-cache.md',
  'docs/architecture/resilience-and-rate-limit.md',
  'docs/simulations/local-smoke.md',
  'docs/simulations/staging-smoke.md',
  'docs/simulations/failure-injection.md',
  'docs/simulations/retry-backoff-validation.md',
  'docs/reference/endpoints-catalog.md',
  'docs/reference/endpoints/README.md',
];

const ENDPOINT_REQUIRED_HEADINGS = [
  '### Purpose',
  '### Authentication',
  '### Parameters',
  '### Request Body',
  '### Responses',
  '### Error Handling',
  '### Rate Limits',
  '### Observability',
  '### Examples',
];

function walkMarkdownFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function checkRequiredFiles(findings) {
  for (const relativePath of REQUIRED_FILES) {
    const absolutePath = path.resolve(relativePath);
    if (!fs.existsSync(absolutePath)) {
      findings.push(`Missing required documentation file: ${relativePath}`);
    }
  }
}

function checkLinksInFile(filePath, findings) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const regex = /\[[^\]]*?\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const link = match[1].trim();
    if (!link || link.startsWith('http://') || link.startsWith('https://') || link.startsWith('mailto:')) {
      continue;
    }
    if (link.startsWith('#')) continue;

    const [relativeTarget] = link.split('#');
    if (!relativeTarget) continue;
    const target = path.resolve(path.dirname(filePath), relativeTarget);
    if (!fs.existsSync(target)) {
      findings.push(`Broken relative link in ${path.relative(process.cwd(), filePath)} -> ${link}`);
    }
  }
}

function checkEndpointReferenceSections(findings) {
  const endpointDir = path.resolve('docs', 'reference', 'endpoints');
  if (!fs.existsSync(endpointDir)) {
    findings.push('Endpoint reference directory is missing: docs/reference/endpoints');
    return;
  }

  const files = fs
    .readdirSync(endpointDir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md');

  if (files.length === 0) {
    findings.push('No generated endpoint reference files were found in docs/reference/endpoints.');
    return;
  }

  for (const fileName of files) {
    const fullPath = path.join(endpointDir, fileName);
    const content = fs.readFileSync(fullPath, 'utf8');
    if (!/^##\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE)\s+/m.test(content)) {
      findings.push(`Endpoint reference missing operation sections: ${path.relative(process.cwd(), fullPath)}`);
      continue;
    }
    for (const heading of ENDPOINT_REQUIRED_HEADINGS) {
      if (!content.includes(heading)) {
        findings.push(`Endpoint reference missing heading "${heading}": ${path.relative(process.cwd(), fullPath)}`);
      }
    }
  }
}

function main() {
  const findings = [];

  if (!fs.existsSync(DOCS_ROOT)) {
    throw new Error(`Docs directory not found: ${DOCS_ROOT}`);
  }

  checkRequiredFiles(findings);

  const markdownFiles = walkMarkdownFiles(DOCS_ROOT);
  for (const markdownFile of markdownFiles) {
    checkLinksInFile(markdownFile, findings);
  }

  checkEndpointReferenceSections(findings);

  if (findings.length > 0) {
    console.error('Documentation verification failed.');
    for (const finding of findings) {
      console.error(`- ${finding}`);
    }
    process.exit(1);
  }

  console.log(`Documentation verification passed (${markdownFiles.length} markdown files checked).`);
}

main();
