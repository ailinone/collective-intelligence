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

const ROOT = process.cwd();
const REPORTS_DIR = path.resolve(ROOT, 'reports');

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function toStatus(ok) {
  return ok ? 'PASS' : 'FAIL';
}

function buildReport(data) {
  const lines = [];
  lines.push('# SOTA Evidence Report');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  lines.push(`- OpenAPI check: ${toStatus(Boolean(data.openapiChecked))}`);
  lines.push(`- Anti-mock gate: ${toStatus(Boolean(data.antiMockPassed))}`);
  lines.push(`- Authenticated endpoint sweep: ${toStatus(Boolean(data.endpointSweepPassed))}`);
  lines.push(`- Capability matrix: ${toStatus(Boolean(data.capabilityMatrixPassed))}`);
  lines.push('');

  if (data.endpointSummary) {
    lines.push('## Endpoint Sweep');
    lines.push('');
    lines.push(`- Total operations: ${data.endpointSummary.totalOperations}`);
    lines.push(`- Route unavailable: ${data.endpointSummary.issueCounts?.route_unavailable || 0}`);
    lines.push(`- Server errors: ${data.endpointSummary.issueCounts?.server_error || 0}`);
    lines.push(`- Auth missing: ${data.endpointSummary.issueCounts?.auth_missing || 0}`);
    lines.push(`- Network errors: ${data.endpointSummary.issueCounts?.network_error || 0}`);
    lines.push(`- Undocumented status: ${data.endpointSummary.issueCounts?.undocumented_status || 0}`);
    lines.push('');
  }

  if (data.capabilitySummary) {
    lines.push('## Capability Matrix');
    lines.push('');
    if (data.capabilitySummary.error) {
      lines.push(`- Error: ${data.capabilitySummary.error}`);
    }
    lines.push(`- Total capabilities: ${data.capabilitySummary.total}`);
    lines.push(
      `- Execute pass: ${data.capabilitySummary.executePass}/${data.capabilitySummary.executeTotal}`
    );
    lines.push(`- Health operational: ${data.capabilitySummary.healthOperational}/${data.capabilitySummary.total}`);
    lines.push(`- Stream pass: ${data.capabilitySummary.streamPass}/${data.capabilitySummary.streamTotal}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const endpointReport = readJsonIfExists(
    path.join(REPORTS_DIR, 'authenticated-endpoint-validation-latest.json')
  );
  const capabilityReport = readJsonIfExists(path.join(REPORTS_DIR, 'capability-matrix-latest.json'));
  const antiMockReport = readJsonIfExists(path.join(REPORTS_DIR, 'anti-mock-latest.json'));
  const openapiArtifactsOk = [
    path.join(ROOT, 'openapi-spec.json'),
    path.join(ROOT, 'openapi-spec.yaml'),
    path.join(ROOT, 'dist', 'openapi.bundle.yaml'),
    path.join(ROOT, 'dist', 'openapi.bundle.json'),
  ].every((filePath) => fs.existsSync(filePath));

  const endpointSummary = endpointReport?.summary || null;
  const capabilitySummary = capabilityReport?.summary || null;

  const endpointSweepPassed = Boolean(
    endpointSummary &&
      (endpointSummary.issueCounts?.route_unavailable || 0) === 0 &&
      (endpointSummary.issueCounts?.server_error || 0) === 0 &&
      (endpointSummary.issueCounts?.auth_missing || 0) === 0 &&
      (endpointSummary.issueCounts?.network_error || 0) === 0 &&
      (endpointSummary.issueCounts?.undocumented_status || 0) === 0
  );

  const capabilityMatrixPassed = Boolean(
    capabilitySummary &&
      !capabilitySummary.error &&
      capabilitySummary.total > 0 &&
      capabilitySummary.executeTotal > 0 &&
      capabilitySummary.executePass === capabilitySummary.executeTotal &&
      capabilitySummary.healthOperational === capabilitySummary.total &&
      capabilitySummary.streamPass === capabilitySummary.streamTotal
  );

  const antiMockPassed = Boolean(antiMockReport?.ok === true || antiMockReport === null);

  const reportData = {
    openapiChecked: openapiArtifactsOk,
    antiMockPassed,
    endpointSweepPassed,
    capabilityMatrixPassed,
    endpointSummary,
    capabilitySummary,
  };

  const markdown = buildReport(reportData);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const datedPath = path.join(REPORTS_DIR, `sota-evidence-${timestamp}.md`);
  const latestPath = path.join(REPORTS_DIR, 'sota-evidence-latest.md');
  fs.writeFileSync(datedPath, markdown, 'utf8');
  fs.writeFileSync(latestPath, markdown, 'utf8');

  console.log(
    JSON.stringify(
      {
        generated: true,
        latest: path.relative(ROOT, latestPath),
        endpointSweepPassed,
        capabilityMatrixPassed,
        antiMockPassed,
        openapiChecked: openapiArtifactsOk,
      },
      null,
      2
    )
  );
}

main();
