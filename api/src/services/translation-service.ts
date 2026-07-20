// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Translation Service
 *
 * Dedicated text-to-text translation via NLLB-200 sidecar.
 * Falls back to LLM-based translation when NLLB is unavailable.
 *
 * Latency: ~50ms per sentence (NLLB CTranslate2 int8 on CPU)
 * Languages: 200+ via Flores-200 codes
 */

import { logger } from '@/utils/logger';
import dns from 'node:dns';

// Force Node.js DNS resolver to use Docker's embedded DNS (127.0.0.11)
// and disable result caching to handle dynamic container IPs
dns.setDefaultResultOrder('ipv4first');

const log = logger.child({ module: 'translation-service' });

/** ISO 639-1 → NLLB Flores-200 code mapping */
const LANG_MAP: Record<string, string> = {
  en: 'eng_Latn', pt: 'por_Latn', es: 'spa_Latn', fr: 'fra_Latn',
  de: 'deu_Latn', it: 'ita_Latn', nl: 'nld_Latn', ru: 'rus_Cyrl',
  zh: 'zho_Hans', ja: 'jpn_Jpan', ko: 'kor_Hang', ar: 'arb_Arab',
  hi: 'hin_Deva', tr: 'tur_Latn', pl: 'pol_Latn', uk: 'ukr_Cyrl',
  vi: 'vie_Latn', th: 'tha_Thai', id: 'ind_Latn', ms: 'zsm_Latn',
  sv: 'swe_Latn', da: 'dan_Latn', no: 'nob_Latn', fi: 'fin_Latn',
  el: 'ell_Grek', he: 'heb_Hebr', cs: 'ces_Latn', ro: 'ron_Latn',
  hu: 'hun_Latn', bg: 'bul_Cyrl', hr: 'hrv_Latn', sk: 'slk_Latn',
};

export interface TranslationResult {
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  latencyMs: number;
  model: string;
}

export interface TranslationConfig {
  /** NLLB sidecar URL (e.g., http://nllb-translation:8087) */
  nllbUrl?: string;
  /** Timeout in ms for NLLB requests */
  timeout?: number;
  /** LLM fallback URL for when NLLB is unavailable */
  llmFallbackUrl?: string;
}

export class TranslationService {
  private nllbUrl: string | null;
  private timeout: number;
  private llmFallbackUrl: string | null;
  private healthy = true;
  private lastHealthCheck = 0;

  // The 120s cold timeout exists ONLY for the sidecar's first request (model
  // load). It used to apply to EVERY call, so a wedged-but-listening sidecar
  // stalled every /v1/translation request for up to 2 minutes before the LLM
  // fallback ran. After the first success the service is warm (~200ms typical)
  // and a short deadline is the correct bound.
  private warmed = false;
  private lastNllbFailureAt = 0;
  private readonly warmTimeoutMs = Number(process.env.NLLB_WARM_TIMEOUT_MS) || 5000;
  private readonly unhealthyRetryMs = Number(process.env.NLLB_UNHEALTHY_RETRY_MS) || 30000;

  constructor(config?: TranslationConfig) {
    this.nllbUrl = config?.nllbUrl
      || process.env.LOCAL_NLLB_URL
      || 'http://nllb-translation:8087';  // Default: Swarm service name on gateway-net
    this.timeout = config?.timeout || 120000; // 120s for first request (model loading), warm: ~200ms
    this.llmFallbackUrl = config?.llmFallbackUrl || null;

    log.info({ url: this.nllbUrl, fromEnv: !!process.env.LOCAL_NLLB_URL }, 'TranslationService initialized');
  }

  /** Cold (first-load) timeout until the first success, short deadline after. */
  private nllbTimeoutMs(): number {
    return this.warmed ? this.warmTimeoutMs : this.timeout;
  }

  /**
   * Whether to attempt the NLLB sidecar at all. Healthy → always. Unhealthy →
   * only re-probe every `unhealthyRetryMs` (circuit half-open) so a dead
   * sidecar costs ONE request per window instead of stalling every caller;
   * the rest go straight to the LLM fallback.
   */
  private shouldTryNllb(): boolean {
    if (!this.nllbUrl) return false;
    if (this.healthy) return true;
    return Date.now() - this.lastNllbFailureAt >= this.unhealthyRetryMs;
  }

  /**
   * Translate text from source to target language.
   * Uses NLLB sidecar for speed (~50ms), falls back to LLM if unavailable.
   */
  async translateText(
    text: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<TranslationResult> {
    const start = performance.now();

    // Try NLLB sidecar first (fast path) — gated by the half-open circuit so a
    // dead/wedged sidecar costs one probe per retry window, not a stall per call.
    if (this.shouldTryNllb()) {
      try {
        log.info({ url: this.nllbUrl, sourceLang, targetLang, textLen: text.length }, 'NLLB: attempting translation');
        const result = await this.translateViaNLLB(text, sourceLang, targetLang);
        const latencyMs = Math.round(performance.now() - start);
        this.healthy = true;
        this.warmed = true; // steady-state from now on: short deadline, not the 120s cold budget
        log.info({ sourceLang, targetLang, latencyMs, chars: text.length, translated: result.translatedText.substring(0, 50) }, 'NLLB translation OK');
        return { ...result, latencyMs, model: 'nllb-200-distilled-600M' };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ error: msg, url: this.nllbUrl, sourceLang, targetLang, text: text.substring(0, 50) }, 'NLLB translation FAILED');
        this.markUnhealthy();
      }
    }

    // Fallback: LLM-based translation
    try {
      const result = await this.translateViaLLM(text, sourceLang, targetLang);
      const latencyMs = Math.round(performance.now() - start);
      return { ...result, latencyMs };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ error: msg }, 'All translation methods failed');
      throw new Error(`Translation failed: ${msg}`);
    }
  }

  /**
   * Translate a batch of texts efficiently.
   */
  async translateBatch(
    texts: string[],
    sourceLang: string,
    targetLang: string,
  ): Promise<TranslationResult[]> {
    if (!this.shouldTryNllb()) {
      // No sidecar configured OR circuit open — per-text path (which itself
      // skips NLLB while the circuit is open, going straight to the LLM).
      return Promise.all(texts.map(t => this.translateText(t, sourceLang, targetLang)));
    }

    const start = performance.now();
    try {
      const response = await fetch(`${this.nllbUrl}/v1/translations/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, source_lang: sourceLang, target_lang: targetLang }),
        signal: AbortSignal.timeout(this.nllbTimeoutMs()),
      });

      if (!response.ok) {
        throw new Error(`NLLB batch: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        results: Array<{ text: string; translated_text?: string; error?: string }>;
        latency_ms: number;
      };

      const latencyMs = Math.round(performance.now() - start);
      this.healthy = true;
      this.warmed = true;
      return data.results.map((r) => ({
        translatedText: r.translated_text || r.text,
        sourceLang,
        targetLang,
        latencyMs,
        model: 'nllb-200-distilled-600M',
      }));
    } catch (error) {
      this.markUnhealthy();
      return Promise.all(texts.map(t => this.translateText(t, sourceLang, targetLang)));
    }
  }

  /** Get supported languages */
  async getLanguages(): Promise<Array<{ code: string; name: string; floresCode: string }>> {
    if (this.nllbUrl) {
      try {
        const response = await fetch(`${this.nllbUrl}/v1/translations/languages`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const data = await response.json() as { languages: Array<{ code: string; name: string; flores_code: string }> };
          return data.languages.map(l => ({ code: l.code, name: l.name, floresCode: l.flores_code }));
        }
      } catch {
        // Fall through to static map
      }
    }

    return Object.entries(LANG_MAP).map(([code, floresCode]) => ({
      code,
      name: code,
      floresCode,
    }));
  }

  /** Check if NLLB sidecar is available */
  async healthCheck(): Promise<boolean> {
    if (!this.nllbUrl) return false;

    try {
      const response = await fetch(`${this.nllbUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      this.healthy = response.ok;
      this.lastHealthCheck = Date.now();
      return this.healthy;
    } catch {
      this.healthy = false;
      this.lastHealthCheck = Date.now();
      return false;
    }
  }

  // ── Private methods ──────────────────────────────────

  private async translateViaNLLB(
    text: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<Pick<TranslationResult, 'translatedText' | 'sourceLang' | 'targetLang'>> {
    // Resolve hostname to IP to bypass Node.js DNS cache (stale in Docker overlay networks)
    let fetchUrl = `${this.nllbUrl}/v1/translations`;
    try {
      const url = new URL(this.nllbUrl!);
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        const { address } = await dns.promises.lookup(url.hostname);
        fetchUrl = `http://${address}:${url.port || '8087'}/v1/translations`;
      }
    } catch (dnsErr) {
      log.warn({ error: dnsErr instanceof Error ? dnsErr.message : String(dnsErr), hostname: this.nllbUrl }, 'DNS lookup failed, using original URL');
    }

    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source_lang: sourceLang,
        target_lang: targetLang,
      }),
      // Cold (first-load) budget only until the first success; warm requests
      // get a short deadline so a wedged sidecar fails over to the LLM fast.
      signal: AbortSignal.timeout(this.nllbTimeoutMs()),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`NLLB ${response.status}: ${body}`);
    }

    const data = await response.json() as { translated_text: string };
    return {
      translatedText: data.translated_text,
      sourceLang,
      targetLang,
    };
  }

  private async translateViaLLM(
    text: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<Pick<TranslationResult, 'translatedText' | 'sourceLang' | 'targetLang' | 'model'>> {
    const langNames: Record<string, string> = {
      en: 'English', pt: 'Portuguese', es: 'Spanish', fr: 'French',
      de: 'German', it: 'Italian', ja: 'Japanese', ko: 'Korean',
      zh: 'Chinese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
    };

    const targetName = langNames[targetLang] || targetLang;
    const sourceName = langNames[sourceLang] || sourceLang;

    // Use Ollama for LLM-based translation fallback
    const ollamaUrl = process.env.OLLAMA_URL;
    const chatUrl = this.llmFallbackUrl
      || (ollamaUrl ? ollamaUrl.replace(/\/v1\/?$/, '') : null);

    if (!chatUrl) {
      throw new Error('No LLM fallback URL configured (set OLLAMA_URL or llmFallbackUrl)');
    }

    const response = await fetch(`${chatUrl.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_TRANSLATION_MODEL || 'ailin-fast',
        messages: [
          {
            role: 'system',
            content: `You are a translator. Translate the user's text from ${sourceName} to ${targetName}. Output ONLY the translated text, nothing else.`,
          },
          { role: 'user', content: text },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`LLM translation: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model?: string;
    };

    return {
      translatedText: data.choices[0]?.message?.content?.trim() || text,
      sourceLang,
      targetLang,
      model: data.model || 'llm-fallback',
    };
  }

  private markUnhealthy(): void {
    this.healthy = false;
    this.lastNllbFailureAt = Date.now(); // starts the half-open retry window (shouldTryNllb)
    // Re-check health after 10s (aggressive retry for sidecar startup)
    setTimeout(() => {
      this.healthCheck().catch(() => {});
    }, 10000);
  }
}

// Singleton instance
let translationServiceInstance: TranslationService | null = null;

export function getTranslationService(): TranslationService {
  if (!translationServiceInstance) {
    translationServiceInstance = new TranslationService();
  }
  return translationServiceInstance;
}
