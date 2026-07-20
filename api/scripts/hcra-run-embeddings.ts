// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * One-shot embedding worker runner.
 *
 *   HCRA_EMBEDDER_URL=http://localhost:8080 \
 *   HCRA_EMBEDDER_MODEL=BAAI/bge-small-en-v1.5 \
 *   pnpm tsx scripts/hcra-run-embeddings.ts [--limit-cap=N --limit-models=N --skip-models]
 */
import { runEmbeddingWorker } from '../src/capability/embeddings/embedding-worker';
import { prisma } from '../src/database/client';

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split('=', 2)[1];
}

async function main(): Promise<void> {
  const stats = await runEmbeddingWorker({
    capabilityLimit: flag('limit-cap') ? Number(flag('limit-cap')) : undefined,
    modelLimit:      flag('limit-models') ? Number(flag('limit-models')) : undefined,
    chunkSize:       flag('chunk') ? Number(flag('chunk')) : undefined,
    skipCapabilities: process.argv.includes('--skip-cap'),
    skipModels:       process.argv.includes('--skip-models'),
  });
  console.log(JSON.stringify(stats, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
