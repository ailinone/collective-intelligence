// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/* eslint-disable @typescript-eslint/no-var-requires */
// This file is a CommonJS entry point that must use require() to set up module aliases
// before any ES modules are loaded. This is intentional.
require('module-alias/register');
const { addAliases } = require('module-alias');

// Configure path aliases
addAliases({
  '@': __dirname,
  '@/core': __dirname + '/core',
  '@/providers': __dirname + '/providers',
  '@/database': __dirname + '/database',
  '@/types': __dirname + '/types',
  '@/utils': __dirname + '/utils',
  '@/config': __dirname + '/config'
});

// Now require the main application
require('./index.js');
