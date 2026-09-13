// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PRODUCTION INCIDENT (2026-09-08): a real "Gere um video..." request against
 * ailin.chat production timed out after ~2 minutes with a generic "Server
 * Connection Error". Production logs (both replicas)
 * showed empiriolabs/wan-3-0 polling for the full 300000ms budget with
 * `HTTP 404 {"detail":"Not Found"}` on EVERY single poll (task ids
 * afbf123d-23db-4bda-9484-f55a48718435 and
 * 5bd00840-7c59-42d3-9891-7371138ee963).
 *
 * Root cause, confirmed against EmpirioLabs' own docs
 * (docs.empiriolabs.ai/api-reference/api-reference/jobs/retrieve-job, and its
 * OpenAPI create-video description: "Always async. Returns a job_id and
 * polling URL immediately; poll GET /v1/jobs/<job-id> for the final video
 * URL."): EmpirioLabs polls through a single UNIFIED `/v1/jobs/{id}`
 * endpoint shared by every async capability — never nested under the submit
 * path the way FastRouter's `POST /videos` → `GET /videos/{taskId}` is. The
 * hub adapter's default poll-path fallback (`<videoGenerate>/{taskId}`) is
 * therefore always wrong for this provider: it resolves to
 * `/videos/generations/{taskId}`, a route that 404s unconditionally, no
 * matter how long the poll budget runs.
 *
 * This test pins the catalog-level fix (`paths.videoPoll`) so it cannot
 * silently regress back to relying on the (wrong, for this provider) default.
 * The adapter-level behavior this catalog field drives is covered by
 * openai-compatible-hub-video-protocol.test.ts's "EmpirioLabs unified jobs
 * endpoint contract" suite.
 */
import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../providers.catalog';

describe('providers.catalog — empiriolabs video poll path (Bug 1 fix, 2026-09-08)', () => {
  const entry = PROVIDER_CATALOG.find((e) => e.providerId === 'empiriolabs');

  it('declares the empiriolabs catalog entry', () => {
    expect(entry).toBeDefined();
  });

  it('declares a videoGenerate submit path', () => {
    expect(entry?.paths?.videoGenerate).toBe('/videos/generations');
  });

  it('declares videoPoll pointing at the real unified jobs endpoint, NOT a sub-path of videoGenerate', () => {
    expect(entry?.paths?.videoPoll).toBe('/jobs/{taskId}');
    // The exact wrong path the adapter's default fallback would otherwise
    // construct (`<videoGenerate>/{taskId}`) — this must never be what
    // videoPoll resolves to for this provider.
    expect(entry?.paths?.videoPoll).not.toBe('/videos/generations/{taskId}');
  });
});
