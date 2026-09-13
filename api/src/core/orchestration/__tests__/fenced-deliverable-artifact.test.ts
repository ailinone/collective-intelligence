// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * fenced-deliverable-artifact.test.ts — LOTE AS artifact-modality check
 * (2026-09-06)
 *
 * Scoping check confirmed a real, narrow gap: no code path anywhere scanned
 * a plain chat completion's text for a chart/diagram deliverable (a fenced
 * ```svg``` or ```mermaid``` block that IS the whole answer) and promoted it
 * to a first-class `AilinArtifact` — every existing `AilinArtifact`
 * construction site lives inside `executeMediaGenerationStage` and requires
 * a dedicated triage stage. `detectFencedDeliverableArtifact` is the
 * minimal, conservative fix: a pure detector wired into the ordinary
 * (non-media) per-stage text path of `executeMultiStagePlan`, gated so a
 * snippet embedded in a longer explanation is never misdetected.
 */
import { describe, it, expect } from 'vitest';
import { detectFencedDeliverableArtifact } from '@/core/orchestration/orchestration-engine';

describe('detectFencedDeliverableArtifact', () => {
  it('detects a response that IS a single svg block', () => {
    const content = '```svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>\n```';
    const match = detectFencedDeliverableArtifact(content);
    expect(match).toBeDefined();
    expect(match?.kind).toBe('svg');
    expect(match?.mimeType).toBe('image/svg+xml');
    expect(match?.filename).toBe('diagram.svg');
    expect(match?.content).toContain('<svg');
  });

  it('detects a response that IS a single mermaid block', () => {
    const content = '```mermaid\ngraph TD;\n  A-->B;\n  B-->C;\n```';
    const match = detectFencedDeliverableArtifact(content);
    expect(match).toBeDefined();
    expect(match?.kind).toBe('mermaid');
    expect(match?.mimeType).toBe('text/vnd.mermaid');
    expect(match?.filename).toBe('diagram.mmd');
    expect(match?.content).toContain('graph TD');
  });

  it('tolerates a short leading caption ("Here is your diagram:")', () => {
    const content = 'Here is your diagram:\n```mermaid\ngraph TD;\n  A-->B;\n```';
    const match = detectFencedDeliverableArtifact(content);
    expect(match).toBeDefined();
    expect(match?.kind).toBe('mermaid');
  });

  it('does NOT match a code block embedded in a longer explanation', () => {
    const content =
      'To draw a simple flow, you can use Mermaid syntax like this:\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nThis works because Mermaid renders directed graphs from a small text DSL. You can add more nodes, styles, and subgraphs as your diagram grows in complexity, and most Markdown renderers that support Mermaid will pick this up automatically without any extra configuration on your end.';
    expect(detectFencedDeliverableArtifact(content)).toBeUndefined();
  });

  it('does NOT match an ordinary chat response with no fenced svg/mermaid block', () => {
    expect(detectFencedDeliverableArtifact('The capital of France is Paris.')).toBeUndefined();
  });

  it('does NOT match a fenced block tagged svg whose body is not actually an SVG document', () => {
    const content = '```svg\njust some text, not xml\n```';
    expect(detectFencedDeliverableArtifact(content)).toBeUndefined();
  });

  it('does NOT match an empty fenced block', () => {
    const content = '```mermaid\n\n```';
    expect(detectFencedDeliverableArtifact(content)).toBeUndefined();
  });

  it('does NOT match a plain ```javascript``` code snippet', () => {
    const content = '```javascript\nconsole.log("hello");\n```';
    expect(detectFencedDeliverableArtifact(content)).toBeUndefined();
  });

  it('handles empty/whitespace-only input without throwing', () => {
    expect(detectFencedDeliverableArtifact('')).toBeUndefined();
    expect(detectFencedDeliverableArtifact('   \n  ')).toBeUndefined();
  });
});
