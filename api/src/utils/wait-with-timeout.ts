// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bounded wait on a promise that cannot itself be cancelled.
 *
 * The caller stops waiting after `ms`; the underlying work keeps running and
 * still settles its own promise. That is the property single-flight loaders
 * need: a waiter that gives up must not start a second copy of the work, and
 * the in-flight work must stay shared by the next caller that joins it.
 *
 * Dependency-free on purpose (no logger, no config) so hot-path modules and
 * worker-thread code can import it without pulling a heavier module graph.
 */

export class WaitTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(what: string, timeoutMs: number) {
    super(`${what} timed out after ${timeoutMs}ms`);
    this.name = 'WaitTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export async function waitWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WaitTimeoutError(what, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
