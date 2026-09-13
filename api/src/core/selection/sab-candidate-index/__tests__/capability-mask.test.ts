// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bit-exact checks for the multi-word capability mask helpers. The word
 * boundaries (bits 31/32, 63/64, 95/96, 127) are where a sign-extension
 * mistake would hide: `1 << 31` is negative as an int32, so any comparison
 * that forgets `>>> 0` on one side passes for bits 0..30 and silently fails
 * for the last bit of every word.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITY_MASK_WORDS, MAX_CAPABILITIES } from '../capacity';
import {
  anyMaskHasAll,
  clearRow,
  hasBit,
  isZero,
  maskKey,
  requiredFromBits,
  rowHasAll,
  rowWords,
  setBit,
} from '../capability-mask';

const BOUNDARY_BITS = [0, 1, 30, 31, 32, 33, 62, 63, 64, 65, 94, 95, 96, 97, 126, 127];

describe('capability-mask', () => {
  it('MAX_CAPABILITIES is 32 bits per word', () => {
    expect(MAX_CAPABILITIES).toBe(CAPABILITY_MASK_WORDS * 32);
    expect(MAX_CAPABILITIES).toBeGreaterThanOrEqual(128);
  });

  it('setBit/hasBit round-trip every boundary bit on several slots without bleeding into neighbours', () => {
    const slots = 5;
    const masks = new Uint32Array(slots * CAPABILITY_MASK_WORDS);
    for (let slot = 0; slot < slots; slot++) {
      for (const bit of BOUNDARY_BITS) {
        if ((bit + slot) % 2 === 0) setBit(masks, slot, bit);
      }
    }
    for (let slot = 0; slot < slots; slot++) {
      for (let bit = 0; bit < MAX_CAPABILITIES; bit++) {
        const expected = BOUNDARY_BITS.includes(bit) && (bit + slot) % 2 === 0;
        expect(hasBit(masks, slot, bit), `slot ${slot} bit ${bit}`).toBe(expected);
      }
    }
  });

  it('rowHasAll is a superset test that survives bit 31 of every word', () => {
    const masks = new Uint32Array(CAPABILITY_MASK_WORDS);
    for (const bit of [31, 63, 95, 127, 5]) setBit(masks, 0, bit);

    expect(rowHasAll(masks, 0, requiredFromBits([31]))).toBe(true);
    expect(rowHasAll(masks, 0, requiredFromBits([63, 95]))).toBe(true);
    expect(rowHasAll(masks, 0, requiredFromBits([31, 63, 95, 127, 5]))).toBe(true);
    expect(rowHasAll(masks, 0, requiredFromBits([30]))).toBe(false);
    expect(rowHasAll(masks, 0, requiredFromBits([31, 32]))).toBe(false);
    expect(rowHasAll(masks, 0, requiredFromBits([]))).toBe(true);
  });

  it('requiredFromBits stores unsigned words and isZero only for the empty set', () => {
    const r = requiredFromBits([31, 127]);
    expect(r.length).toBe(CAPABILITY_MASK_WORDS);
    expect(r[0]).toBe(0x80000000);
    expect(r[CAPABILITY_MASK_WORDS - 1]).toBe(0x80000000);
    expect(isZero(r)).toBe(false);
    expect(isZero(requiredFromBits([]))).toBe(true);
  });

  it('anyMaskHasAll scans a flat distinct-mask list word by word', () => {
    const a = new Uint32Array(CAPABILITY_MASK_WORDS);
    setBit(a, 0, 3);
    setBit(a, 0, 40);
    const b = new Uint32Array(CAPABILITY_MASK_WORDS);
    setBit(b, 0, 127);
    const flat = [...rowWords(a, 0), ...rowWords(b, 0)];

    expect(anyMaskHasAll(flat, requiredFromBits([3, 40]))).toBe(true);
    expect(anyMaskHasAll(flat, requiredFromBits([127]))).toBe(true);
    expect(anyMaskHasAll(flat, requiredFromBits([3, 127]))).toBe(false);
    expect(anyMaskHasAll([], requiredFromBits([3]))).toBe(false);
  });

  it('clearRow zeroes only the target slot; maskKey distinguishes masks that differ only in a high word', () => {
    const masks = new Uint32Array(2 * CAPABILITY_MASK_WORDS);
    setBit(masks, 0, 127);
    setBit(masks, 1, 127);
    clearRow(masks, 0);
    expect(hasBit(masks, 0, 127)).toBe(false);
    expect(hasBit(masks, 1, 127)).toBe(true);

    const low = new Uint32Array(CAPABILITY_MASK_WORDS);
    setBit(low, 0, 0);
    const high = new Uint32Array(CAPABILITY_MASK_WORDS);
    setBit(high, 0, 0);
    setBit(high, 0, 96);
    expect(maskKey(rowWords(low, 0))).not.toBe(maskKey(rowWords(high, 0)));
  });
});
