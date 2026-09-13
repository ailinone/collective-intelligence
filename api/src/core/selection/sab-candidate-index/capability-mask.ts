// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-word capability bitmask helpers shared by `encode.ts` (worker) and
 * `reader.ts` (main thread). Both sides MUST agree bit-for-bit on where a
 * capability lives and how a mask is compared, so the arithmetic lives in
 * exactly one place instead of being re-derived on each side.
 *
 * Layout: `masks` is the `capabilityBitmask` Uint32Array from `schema.ts`,
 * row-major with `CAPABILITY_MASK_WORDS` words per model slot. Bit `b` of
 * a model lives at word `b >>> 5`, bit `b & 31` of that word.
 *
 * Every comparison goes through `>>> 0`: `&` and `<<` operate on int32 in
 * JS, so bit 31 of any word is negative on one side and positive (as a
 * Uint32Array element) on the other; comparing without normalizing would
 * silently fail for exactly the last capability of every word.
 */
import { CAPABILITY_MASK_WORDS } from './capacity';

export function setBit(masks: Uint32Array, slot: number, bit: number): void {
  const idx = slot * CAPABILITY_MASK_WORDS + (bit >>> 5);
  masks[idx] = (masks[idx] | (1 << (bit & 31))) >>> 0;
}

export function hasBit(masks: Uint32Array, slot: number, bit: number): boolean {
  const idx = slot * CAPABILITY_MASK_WORDS + (bit >>> 5);
  return ((masks[idx] & (1 << (bit & 31))) >>> 0) !== 0;
}

export function clearRow(masks: Uint32Array, slot: number): void {
  masks.fill(0, slot * CAPABILITY_MASK_WORDS, (slot + 1) * CAPABILITY_MASK_WORDS);
}

/** Copies one model's words out of the shared array (used to collect the
 *  distinct-mask set at encode time). */
export function rowWords(masks: Uint32Array, slot: number): number[] {
  const base = slot * CAPABILITY_MASK_WORDS;
  const words: number[] = new Array<number>(CAPABILITY_MASK_WORDS);
  for (let w = 0; w < CAPABILITY_MASK_WORDS; w++) words[w] = masks[base + w] >>> 0;
  return words;
}

export function maskKey(words: readonly number[]): string {
  return words.join(',');
}

export function requiredFromBits(bits: readonly number[]): Uint32Array {
  const required = new Uint32Array(CAPABILITY_MASK_WORDS);
  for (const bit of bits) {
    const w = bit >>> 5;
    required[w] = (required[w] | (1 << (bit & 31))) >>> 0;
  }
  return required;
}

export function isZero(required: Uint32Array): boolean {
  for (let w = 0; w < CAPABILITY_MASK_WORDS; w++) if (required[w] !== 0) return false;
  return true;
}

/** Superset test: every bit set in `required` is also set in the model's
 *  row (the model may have more). */
export function rowHasAll(masks: Uint32Array, slot: number, required: Uint32Array): boolean {
  const base = slot * CAPABILITY_MASK_WORDS;
  for (let w = 0; w < CAPABILITY_MASK_WORDS; w++) {
    const r = required[w];
    if (r !== 0 && ((masks[base + w] & r) >>> 0) !== r) return false;
  }
  return true;
}

/** Same superset test against a flat list of distinct masks
 *  (`GenerationMeta.distinctMasks`, `CAPABILITY_MASK_WORDS` entries each). */
export function anyMaskHasAll(flatMasks: readonly number[], required: Uint32Array): boolean {
  for (let base = 0; base + CAPABILITY_MASK_WORDS <= flatMasks.length; base += CAPABILITY_MASK_WORDS) {
    let ok = true;
    for (let w = 0; w < CAPABILITY_MASK_WORDS; w++) {
      const r = required[w];
      if (r !== 0 && ((flatMasks[base + w] & r) >>> 0) !== r) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
