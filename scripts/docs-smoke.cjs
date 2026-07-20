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

const REQUIRED_MERMAID_DOCS = [
  'docs/architecture/system-context.md',
  'docs/architecture/container-view.md',
  'docs/architecture/request-sequences.md',
  'docs/architecture/data-flow-memory-cache.md',
  'docs/architecture/resilience-and-rate-limit.md',
];

const REQUIRED_EXAMPLE_DOCS = [
  'docs/getting-started/quickstart.md',
  'docs/integration/typescript-sdk.md',
  'docs/integration/python-sdk.md',
  'docs/use-cases/basic-chat.md',
  'docs/use-cases/streaming-and-tools.md',
  'docs/use-cases/multi-model-consensus.md',
  'docs/use-cases/cost-capped-routing.md',
  'docs/use-cases/realtime-session.md',
  'docs/use-cases/enterprise-governance.md',
  'docs/simulations/local-smoke.md',
  'docs/simulations/staging-smoke.md',
  'docs/simulations/failure-injection.md',
  'docs/simulations/retry-backoff-validation.md',
];

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

function countCodeBlocks(markdown, language) {
  const regex = new RegExp(`\\\`\\\`\\\`${language}[\\s\\S]*?\\\`\\\`\\\``, 'gi');
  const matches = markdown.match(regex);
  return matches ? matches.length : 0;
}

function main() {
  const findings = [];
  const aggregate = { curl: 0, ts: 0, python: 0, mermaid: 0 };

  for (const relativePath of REQUIRED_MERMAID_DOCS) {
    const fullPath = path.resolve(relativePath);
    if (!fs.existsSync(fullPath)) {
      findings.push(`Missing architecture doc: ${relativePath}`);
      continue;
    }
    const markdown = read(relativePath);
    const mermaidBlocks = countCodeBlocks(markdown, 'mermaid');
    aggregate.mermaid += mermaidBlocks;
    if (mermaidBlocks === 0) {
      findings.push(`Architecture doc without Mermaid diagram: ${relativePath}`);
    }
  }

  for (const relativePath of REQUIRED_EXAMPLE_DOCS) {
    const fullPath = path.resolve(relativePath);
    if (!fs.existsSync(fullPath)) {
      findings.push(`Missing example doc: ${relativePath}`);
      continue;
    }
    const markdown = read(relativePath);
    const curlBlocks = countCodeBlocks(markdown, 'bash');
    const tsBlocks = countCodeBlocks(markdown, 'ts') + countCodeBlocks(markdown, 'typescript');
    const pythonBlocks = countCodeBlocks(markdown, 'python');
    aggregate.curl += curlBlocks;
    aggregate.ts += tsBlocks;
    aggregate.python += pythonBlocks;

    if (curlBlocks === 0) findings.push(`Missing curl/bash example in ${relativePath}`);
    if (tsBlocks === 0) findings.push(`Missing TypeScript example in ${relativePath}`);
    if (pythonBlocks === 0) findings.push(`Missing Python example in ${relativePath}`);

    if (markdown.includes('curl') && !markdown.includes('https://api.ailin.one')) {
      findings.push(`curl examples should target production base URL in ${relativePath}`);
    }
  }

  if (aggregate.curl === 0 || aggregate.ts === 0 || aggregate.python === 0) {
    findings.push('Global SDK/code example coverage is incomplete (curl/TypeScript/Python).');
  }

  if (findings.length > 0) {
    console.error('Documentation smoke checks failed.');
    for (const finding of findings) {
      console.error(`- ${finding}`);
    }
    process.exit(1);
  }

  console.log(
    `Documentation smoke checks passed (curl=${aggregate.curl}, ts=${aggregate.ts}, python=${aggregate.python}, mermaid=${aggregate.mermaid}).`
  );
}

main();
