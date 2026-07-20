// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/evals/**/*.eval.ts'],
        testTimeout: 120_000, // 2 min per eval (LLM calls can be slow)
        hookTimeout: 60_000,
        sequence: {
            concurrent: false,
        },
        pool: 'forks',
        poolOptions: {
            forks: {
                singleFork: true,
                isolate: true,
            },
        },
        fileParallelism: false,
        setupFiles: ['./tests/evals/setup.ts'],
        passWithNoTests: true,
        reporters: ['default'],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@/config': path.resolve(__dirname, './src/config'),
            '@/core': path.resolve(__dirname, './src/core'),
            '@/providers': path.resolve(__dirname, './src/providers'),
            '@/database': path.resolve(__dirname, './src/database'),
            '@/types': path.resolve(__dirname, './src/types'),
            '@/utils': path.resolve(__dirname, './src/utils'),
        },
    },
});
