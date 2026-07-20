// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const resolveModule = createRequire(__dirname);
const prismaCLI = resolveModule.resolve('prisma/build/index.js');

export const projectRoot = path.resolve(__dirname, '..', '..');
export const prismaSchemaPath = path.resolve(projectRoot, 'prisma', 'schema.prisma');

export async function runPrismaCommand(args: string[]): Promise<void> {
  await runPrismaCommandWithInput(args);
}

export async function runPrismaCommandWithInput(args: string[], input?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCLI, ...args], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: 'inherit',
    });

    if (typeof input === 'string') {
      child.stdin?.write(input);
      child.stdin?.end();
    }

    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Prisma CLI exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}
