// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * W&B (Weights & Biases) Inference Adapter — OpenAI-compatible + `wandb-project`
 * header injection.
 *
 * W&B Inference serves open-weight models from multiple model families via an
 * **OpenAI-compatible** chat/completions surface at
 * `https://api.inference.wandb.ai/v1`. Specific model identifiers live in the
 * catalog / discovery layer — this adapter deliberately carries none. The one
 * thing W&B adds on top of the
 * OAI wire is that **every request must carry a `wandb-project` header** that
 * routes the call to a specific W&B project for usage tracking and billing.
 *
 * Source: https://docs.wandb.ai/weave/quickstart-inference
 *
 * ### Why this needs a dedicated adapter
 *
 * The header is not a per-deploy constant — it's an **operational knob**. The
 * same API key can span many projects. Dropping it in the catalog's static
 * `extraHeaders` would couple catalog config to ops config. Keeping it env-var
 * driven (`WANDB_PROJECT`) means:
 *   - ops swap projects without rebuilding the catalog
 *   - tests can spy on header composition without catalog mutation
 *   - a missing project is a runtime 400, which W&B surfaces clearly, rather
 *     than a silent misroute
 *
 * ### Fallback behavior
 *
 * If `WANDB_PROJECT` is absent we still emit the request (the hub adapter's
 * error surface is better than a client-side throw), but we log a warning so
 * the operator sees the 400 and knows why. Empty string is treated as
 * "absent".
 *
 * ### Auth
 *
 * Standard Bearer via `WANDB_API_KEY`, delegated entirely to the hub.
 */

import {
  OpenAICompatibleHubAdapter,
  type OpenAICompatibleHubAdapterConfig,
} from '../openai-compatible-hub/openai-compatible-hub-adapter';
import { logger } from '@/utils/logger';

/**
 * Source-of-truth for where the project slug is read from. A function (not
 * a captured string) so the value updates if ops rotates the env var mid-run.
 */
type ProjectResolver = () => string | undefined;

export interface WandbAdapterConfig extends OpenAICompatibleHubAdapterConfig {
  /**
   * Override the project resolver. Defaults to reading `process.env.WANDB_PROJECT`
   * at header-build time. Tests use this to inject a deterministic value.
   */
  projectResolver?: ProjectResolver;
}

const defaultProjectResolver: ProjectResolver = () => {
  const v = process.env.WANDB_PROJECT;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
};

export class WandbAdapter extends OpenAICompatibleHubAdapter {
  private readonly projectResolver: ProjectResolver;
  private readonly wlog = logger.child({ provider: 'wandb' });

  constructor(config: WandbAdapterConfig) {
    super({
      ...config,
      providerName: 'wandb',
      displayName: config.displayName || 'Weights & Biases Inference',
    });
    this.projectResolver = config.projectResolver ?? defaultProjectResolver;
  }

  /**
   * Inject `wandb-project` on every request. All of chat, stream, embeddings,
   * discovery, model-list call through this hook, so covering it here covers
   * every W&B-bound HTTP call at once.
   *
   * We intentionally do NOT fold the project into `metadata.extraHeaders`
   * because that field is copied by value at construction time and a
   * mid-run env change would be lost.
   */
  protected override buildRequestHeaders(includeJsonContentType: boolean): Record<string, string> {
    const headers = super.buildRequestHeaders(includeJsonContentType);
    const project = this.projectResolver();
    if (project) {
      headers['wandb-project'] = project;
    } else {
      // Single-shot warn per-process; the hub surfaces the actual 400 cleanly.
      if (!WandbAdapter.warnedOnce) {
        this.wlog.warn(
          'WANDB_PROJECT is not set — requests will fail with HTTP 400 from W&B until it is configured',
        );
        WandbAdapter.warnedOnce = true;
      }
    }
    return headers;
  }

  /** Class-level latch — avoids spamming the log on every request. */
  private static warnedOnce = false;

  /** For tests only. Resets the warn latch so each test case gets one warn. */
  static resetWarnLatchForTests(): void {
    WandbAdapter.warnedOnce = false;
  }
}
