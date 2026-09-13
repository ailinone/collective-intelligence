// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Passed to the worker's own `execArgv: ['--import', <this file as a
// file:// URL>]` (see `manager.ts`'s `resolveWorkerExecArgv()`) — Node loads
// and executes this file BEFORE the worker's real entry module
// (`worker.ts`/`worker.js`), guaranteeing the hook below is active for
// every subsequent import that entry module makes. See
// `dev-alias-resolver-hook.mjs` for what the hook itself does and why it's
// needed at all (DEV/TEST ONLY — never referenced by the compiled
// production build, see `manager.ts`).
import module from 'node:module';

module.register(new URL('./dev-alias-resolver-hook.mjs', import.meta.url));
