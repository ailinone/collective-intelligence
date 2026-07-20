// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Observer/Narrator Types
 *
 * The Observer is a local reasoning model (e.g. deepseek-r1:1.5b via Ollama)
 * that watches collective strategy execution in real-time and generates
 * insightful narration of the process for the user.
 */

import type { ObserverEvent, ObserverNarration } from '@/types';

/** Configuration for the Observer service. */
export interface ObserverConfig {
  /** Whether the observer is enabled for this request. */
  enabled: boolean;
  /** The model ID to use for local narration (e.g. 'deepseek-r1:1.5b'). */
  modelId?: string;
  /** The provider to use (default: 'ollama'). */
  provider?: string;
  /** Base URL for the local provider (default: from env OLLAMA_URL). */
  baseUrl?: string;
  /**
   * Cloud model ID to use when local Ollama is unavailable
   * (env: OBSERVER_CLOUD_MODEL). Operators can declare additional fallback
   * candidates with the comma-separated env var
   * OBSERVER_CLOUD_MODEL_FALLBACKS — there are no hardcoded defaults.
   */
  cloudModel?: string;
  /** Maximum tokens for each narration (~100-200 is typical). */
  maxNarrationTokens?: number;
  /** Language for narrations (auto-detected from user message). */
  language?: string;
}

/** Feed that strategies emit events to. The ObserverService consumes from this feed. */
export interface ObserverFeed {
  /** Emit an event for the observer to narrate. Non-blocking. */
  emit(event: ObserverEvent): void;
  /** Get all narrations generated so far (for final metadata). */
  getNarrations(): ObserverNarration[];
  /** Whether the observer is active (has a model loaded). */
  isActive(): boolean;
  /** Drain narrations that are ready. Returns and removes from queue. Non-blocking. */
  drainReadyNarrations(): ObserverNarration[];
  /** Wait for in-flight narrations to complete (with timeout). */
  flushPending(timeoutMs?: number): Promise<void>;
}

/** SSE chunk type for observer narrations streamed to the client. */
export interface ObserverSSEChunk {
  type: 'observer';
  event: ObserverEvent['type'];
  narration: string;
  reasoning?: string;
  timestamp: number;
}

export type { ObserverEvent, ObserverNarration };
