// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Fixed capacity constants for the SharedArrayBuffer layout. Real production
// catalog today: 111,666 rows (37,629 curated / 73,782 aggregated / 255
// orphan — see full-cache-index-benchmark.test.ts). Capacities below are
// sized with real headroom over that, not tuned to the exact current count,
// since a fixed-layout SharedArrayBuffer (the simplest-correct design, see
// README.md's "why fixed capacity" note) must survive catalog growth between
// deploys without a resize.
export const MAX_MODELS = 200_000;
export const CURATED_CAP = 120_000; // curatedOrder capacity (today: 37,629)
export const AGGREGATED_CAP = 200_000; // aggregatedOrder capacity (today: 73,782)
export const MAX_PROVIDERS = 1024; // today: 95 distinct curated providers
export const ID_BLOB_BYTES = 12 * 1024 * 1024; // model-id UTF-8 bytes (today: ~2.3MB measured)
export const PROVIDER_BLOB_BYTES = 256 * 1024; // provider id+name UTF-8 bytes
export const MAX_CAPABILITIES = 32; // bitmask width (legacy capability enum today: ~17 known strings)
