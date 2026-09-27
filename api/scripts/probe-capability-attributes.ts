// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Manual Tier 2 probing trigger (LOTE AZ, 2026-09-23).
 *
 * NEVER run on a schedule. This makes real, paid calls against a real
 * provider. Requires an explicit go-ahead per the spec's testing policy —
 * see the plan's final "Real Tier 2 probing batch" section for the
 * cost-estimate template to fill in before running this for real.
 *
 * Usage:
 *   pnpm tsx scripts/probe-capability-attributes.ts --provider fal-ai --model <id> --candidates 16,12,8
 */
import { probeVideoDurationCeiling } from '../src/services/catalog/capability-probe-job';

function parseArgs(argv: string[]): { provider: string; model: string; candidates: number[] } {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const provider = get('--provider');
  const model = get('--model');
  const candidatesRaw = get('--candidates');
  if (!provider || !model || !candidatesRaw) {
    throw new Error(
      'Usage: probe-capability-attributes.ts --provider <id> --model <id> --candidates <c1,c2,...>'
    );
  }
  return {
    provider,
    model,
    candidates: candidatesRaw.split(',').map((c) => Number(c.trim())),
  };
}

async function main(): Promise<void> {
  const { provider, model, candidates } = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log(
    `[probe] about to make REAL, PAID requests against ${provider}/${model} for candidates: ${candidates.join(', ')}`
  );

  // TODO (fill in per-provider at run time): wire the real adapter call
  // here. Left unimplemented deliberately — this script is a scaffold; the
  // real adapter wiring is provider-specific and must be reviewed alongside
  // the cost estimate before the first real run, per the plan's final
  // "requires user go-ahead" section.
  throw new Error(
    'probe-capability-attributes.ts: real adapter wiring not implemented — see the plan\'s ' +
      'final "Real Tier 2 probing batch" section before wiring a live provider call here.'
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
