// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1E §14.4 — Live-chat audit plan uses resolved aliases.
 *
 * The audit script's `extractRoutesFromDryRunJson(scope='approved')`
 * pulls `apiModelId` straight from the dry-run plan's
 * `routeCandidatesPerRole[r].approvedForExecution[i].apiModelId`.
 *
 * After J1E wiring, the dry-run plan now contains alias-resolved
 * apiModelIds (e.g., `anthropic/claude-3.7-sonnet`, NOT
 * `anthropic/anthropic-claude-3.7-sonnet`). The audit plan therefore
 * inherits the corrected forms. These tests assert that nothing in
 * the audit pipeline transforms the apiModelId back into the bad form.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const auditScriptSource = fs.readFileSync(
  path.resolve(__dirname, '../scripts/run-live-chat-operability-audit.ts'),
  'utf8',
);

describe('01C.1B-J1E §14.4 — audit plan uses resolved aliases', () => {
  it('the audit script does NOT perform its own naive concat', () => {
    // Anti-regression: the audit script must not contain a pattern like
    // `${nativeProviderId}/${logicalModelId}` for building apiModelIds.
    // It only PROBES routes that the dry-run already resolved.
    expect(auditScriptSource).not.toMatch(/\$\{[^}]*native(?:Provider)?Id[^}]*\}\/\$\{[^}]*logicalModelId[^}]*\}/);
  });

  it('extractRoutesFromDryRunJson copies apiModelId verbatim from the plan', () => {
    // The extraction function reads `c.apiModelId` from each candidate.
    // It does NOT re-resolve or normalize.
    expect(auditScriptSource).toMatch(/c\.apiModelId/);
    // It does NOT contain a re-resolution step inside the extraction
    expect(auditScriptSource).not.toMatch(/extractRoutesFromDryRunJson[\s\S]{0,2000}resolveProviderApiModelId/);
  });

  it('PROVIDER_SPECS map does not double-prefix in normalizeModelId', () => {
    // Some specs may have a normalizeModelId hook. They must not
    // prepend `<provider>/` to an already-prefixed id.
    const block = auditScriptSource.slice(
      auditScriptSource.indexOf('PROVIDER_SPECS'),
      auditScriptSource.indexOf('PROVIDER_SPECS') + 6000,
    );
    expect(block).not.toMatch(/normalizeModelId:\s*\(m\)\s*=>\s*['"`]\$\{?provider/i);
  });

  it('audit script accepts --include-route-candidates and defaults to approved scope', () => {
    // From J1D, but pinned again here since J1E depends on it.
    expect(auditScriptSource).toMatch(/'--include-route-candidates'/);
    expect(auditScriptSource).toMatch(/routeScope[\s\S]{0,200}'approved'/);
  });

  it('snapshot-path option carries the route-level evidence (J1E-relevant)', () => {
    expect(auditScriptSource).toMatch(/'--snapshot-path'/);
    expect(auditScriptSource).toMatch(/snapshotPath/);
  });

  it('no provider HTTP call is initiated for unresolved aliases', () => {
    // Routes with `apiModelId === ''` or marked `unresolved` must not
    // hit the wire. The script's `specForRoute(...)` returns undefined
    // and the route is recorded in `unauditableExtracted` instead.
    expect(auditScriptSource).toMatch(/unauditableExtracted/);
    expect(auditScriptSource).toMatch(/no_provider_spec_in_audit_script/);
  });
});
