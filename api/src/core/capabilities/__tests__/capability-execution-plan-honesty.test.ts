// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Execution-plan honesty for the capabilities audited in LOTE AP.
 *
 * Two distinct defects motivated this suite, both caused by
 * `defaultExecutionPath()` guessing from substrings:
 *
 *   1. `diarization` contains none of `audio` / `speech` / `image` / `video`,
 *      so it defaulted to `['orchestration']`. The dispatcher's native-adapter
 *      branch for it was unreachable and every request for speaker labels was
 *      answered by a chat model that had never heard the audio.
 *
 *   2. The video-input ids defaulted to `['native_adapter','orchestration']`.
 *      The orchestration fallback meant "ffmpeg is missing, so hand the base64
 *      container to a chat model as text" — a request that cannot succeed and,
 *      if it appeared to, would describe a video nobody decoded.
 *
 * The invariant: a capability whose only truthful implementation is a real
 * pipeline must NOT list `orchestration` as a fallback, because a generic chat
 * model can always produce plausible-looking output for these prompts.
 */

import { describe, expect, it } from 'vitest';
import {
  getCapabilityExecutionPlan,
  normalizeCapabilityName,
} from '@/core/capabilities/capability-registry';
import { capabilityOntology } from '@/core/capabilities/capability-ontology';

/**
 * Capabilities that would be FABRICATED by a plain chat model. Each must have
 * exactly one execution path: the pipeline that does the real work.
 */
const NO_CHAT_FALLBACK = [
  'diarization',
  'video_understanding',
  'video_to_text',
  'video_transcription',
] as const;

describe('capabilities that must never fall back to a chat model', () => {
  it.each(NO_CHAT_FALLBACK)('%s executes only via native_adapter', (capability) => {
    const plan = getCapabilityExecutionPlan(capability);

    expect(plan).toBeDefined();
    expect(plan!.executionPath).toEqual(['native_adapter']);
    expect(plan!.executionPath).not.toContain('orchestration');
  });

  it.each(NO_CHAT_FALLBACK)('%s declares the dependency that actually gates it', (capability) => {
    const plan = getCapabilityExecutionPlan(capability)!;

    if (capability === 'diarization') {
      expect(plan.dependencies).toContain('native_diarization_provider');
      expect(plan.requiredCapabilities).toEqual(['speech_to_text']);
    } else {
      expect(plan.dependencies).toContain('ffmpeg_media_toolkit');
      expect(plan.dependencies).toContain('speech_to_text_pipeline');
    }
  });
});

describe('video-input family', () => {
  it('binds video_understanding to vision, and transcription to speech_to_text', () => {
    // These are COMPOSED capabilities spanning several models, and the health
    // endpoint tests every required capability against ONE model. Listing both
    // would demand a single model that does both and report 0 runnable, so
    // each id names its BINDING constraint and declares the rest as
    // non-model dependencies.
    expect(getCapabilityExecutionPlan('video_understanding')!.requiredCapabilities).toEqual([
      'vision',
    ]);
    expect(getCapabilityExecutionPlan('video_to_text')!.requiredCapabilities).toEqual([
      'speech_to_text',
    ]);
    expect(getCapabilityExecutionPlan('video_transcription')!.requiredCapabilities).toEqual([
      'speech_to_text',
    ]);
  });

  it('declares the vision pipeline only for video_understanding', () => {
    expect(getCapabilityExecutionPlan('video_understanding')!.dependencies).toContain(
      'vision_pipeline'
    );
    expect(getCapabilityExecutionPlan('video_to_text')!.dependencies).not.toContain(
      'vision_pipeline'
    );
  });

  it('resolves the ontology alias video_input to video_understanding', () => {
    expect(capabilityOntology.normalize('video_input')).toBe('video_understanding');
    expect(normalizeCapabilityName('video_input')).toBe('video_understanding');
  });
});

describe('realtime family stays stream-only', () => {
  // These three legitimately have no HTTP execute path: a bidirectional audio
  // session is a WebSocket, and pretending otherwise is how `audio_to_audio`
  // would end up answered by a text round-trip.
  it.each(['realtime', 'realtime_audio', 'audio_to_audio'] as const)(
    '%s supports stream but not execute',
    (capability) => {
      const plan = getCapabilityExecutionPlan(capability)!;

      expect(plan.supportsExecute).toBe(false);
      expect(plan.supportsStream).toBe(true);
      expect(plan.dependencies).toContain('realtime_ws');
    }
  );

  it('keeps audio_to_audio anchored on realtime_audio, which is anchored on realtime', () => {
    expect(getCapabilityExecutionPlan('audio_to_audio')!.requiredCapabilities).toEqual([
      'realtime_audio',
    ]);
    expect(getCapabilityExecutionPlan('realtime_audio')!.requiredCapabilities).toEqual(['realtime']);
  });

  it('resolves the speech-to-speech aliases the ontology defines', () => {
    expect(capabilityOntology.normalize('speech_to_speech')).toBe('audio_to_audio');
    expect(capabilityOntology.normalize('sts')).toBe('audio_to_audio');
    expect(capabilityOntology.normalize('voice_live')).toBe('realtime_audio');
  });
});

describe('agentic family is executable behind a default-off flag (ADR-024)', () => {
  const AGENTIC = ['computer_use', 'agents', 'mcp'] as const;

  it.each(AGENTIC)('%s declares a real executor, gated at the dispatch point', (capability) => {
    const plan = getCapabilityExecutionPlan(capability)!;

    // As of the ADR-024 reconciliation (LOTE AV), all three have a real
    // implementation — the isolated Docker sandbox — so the plan itself
    // declares them executable. Per-capability enablement (default OFF) is
    // enforced by executeAgenticSandboxMode in capabilities-routes.ts, not
    // by this static plan, which is why supportsExecute stays true
    // regardless of flag state (see
    // agentic-sandbox-dispatch.test.ts for the flag-off behavior itself).
    expect(plan.supportsExecute).toBe(true);
    expect(plan.supportsStream).toBe(false);
    expect(plan.executionPath).toEqual(['agentic_sandbox']);
    expect(plan.dependencies).toContain('agentic_sandbox_runtime');
  });

  it('computer_use no longer routes into the code-execution sandbox', () => {
    // The defect: `computer_use` listed `sandbox_workflow` FIRST, so a
    // capability meaning "control a GUI" executed whatever `code` field the
    // caller sent — on child_process.spawn against the API host whenever no
    // isolated backend was configured. See ADR-024 and [SEC-04].
    const plan = getCapabilityExecutionPlan('computer_use')!;
    expect(plan.executionPath).not.toContain('sandbox_workflow');
  });

  it.each(AGENTIC)('%s no longer falls back to a plain chat model', (capability) => {
    // `agents` and `mcp` had no tool_pipeline executor, so `orchestration`
    // answered with prose describing what an agent would have done.
    expect(getCapabilityExecutionPlan(capability)!.executionPath).not.toContain('orchestration');
  });

  it('keeps the ids resolvable, so the refusal is specific rather than "unknown capability"', () => {
    expect(capabilityOntology.has('computer_use')).toBe(true);
    expect(capabilityOntology.normalize('browser_use')).toBe('computer_use');
    expect(capabilityOntology.normalize('agentic_workflow')).toBe('agents');
    expect(capabilityOntology.normalize('model_context_protocol')).toBe('mcp');
    expect(normalizeCapabilityName('action_planning')).toBe('agents');
  });

  it('leaves the real code-execution capabilities executable', () => {
    // The correction must not disable the sandbox for the ids that legitimately
    // mean "run this code".
    for (const capability of ['code_interpreter', 'code_generation', 'debugging'] as const) {
      const plan = getCapabilityExecutionPlan(capability)!;
      expect(plan.supportsExecute).toBe(true);
      expect(plan.executionPath).toContain('sandbox_workflow');
    }
  });
});

describe('speech_to_text is untouched', () => {
  it('keeps its orchestration fallback', () => {
    // Unlike diarization, plain transcription CAN be served by a multimodal
    // chat model that accepts audio, so its fallback is legitimate.
    const plan = getCapabilityExecutionPlan('speech_to_text')!;
    expect(plan.executionPath).toEqual(['native_adapter', 'orchestration']);
  });
});
