// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability probe registry bootstrap.
 * Registers real probes and fills uncovered capabilities with deterministic fallbacks
 * (no fake success / no *_not_implemented placeholder registration).
 */

import { MODEL_CAPABILITIES, type ModelCapability } from '@/types';
import { registerCapabilityTest } from './registry';
import type { CapabilityId, CapabilityTester } from './capabilities';
import {
  chatTest,
  functionCallingTest,
  streamingTest,
  reasoningTest,
  jsonModeTest,
} from './implementations/text-tests';
import { speechToTextTest, textToSpeechTest } from './implementations/audio-tests';
import { visionTest, imageGenerationTest } from './implementations/vision-tests';
import { embeddingsTest } from './implementations/embeddings-tests';
import {
  codeGenerationTest,
  debuggingTest,
  codeReviewTest,
  refactoringTest,
  codeInterpreterTest,
} from './code';
import { webSearchTest, fileSearchTest } from './tools-and-agents';

const explicitTesters: Partial<Record<ModelCapability, CapabilityTester>> = {
  chat: chatTest,
  text_generation: chatTest,
  completions: chatTest,
  reasoning: reasoningTest,
  thinking_mode: reasoningTest,
  qa: chatTest,
  analysis: chatTest,
  function_calling: functionCallingTest,
  tool_use: functionCallingTest,
  streaming: streamingTest,
  json_mode: jsonModeTest,
  embeddings: embeddingsTest,
  embedding: embeddingsTest,
  speech_to_text: speechToTextTest,
  transcription: speechToTextTest,
  audio_input: speechToTextTest,
  listen: speechToTextTest,
  text_to_speech: textToSpeechTest,
  tts: textToSpeechTest,
  audio_generation: textToSpeechTest,
  vision: visionTest,
  multimodal: visionTest,
  image_generation: imageGenerationTest,
  image_editing: imageGenerationTest,
  code_generation: codeGenerationTest,
  code_completion: codeGenerationTest,
  coding: codeGenerationTest,
  code_review: codeReviewTest,
  debugging: debuggingTest,
  refactoring: refactoringTest,
  testing: codeGenerationTest,
  code_interpreter: codeInterpreterTest,
  web_search: webSearchTest,
  deep_search: webSearchTest,
  deep_research: webSearchTest,
  file_search: fileSearchTest,
};

function fallbackTesterForCapability(capability: ModelCapability): CapabilityTester {
  if (capability.includes('code') || capability === 'debugging' || capability === 'refactoring') {
    return codeGenerationTest;
  }
  if (
    capability.includes('image') ||
    capability.includes('video') ||
    capability === 'vision' ||
    capability === 'multimodal'
  ) {
    return visionTest;
  }
  if (capability.includes('audio') || capability.includes('speech') || capability === 'diarization') {
    return speechToTextTest;
  }
  if (capability.includes('search') || capability === 'research') {
    return webSearchTest;
  }
  return chatTest;
}

for (const capability of MODEL_CAPABILITIES) {
  const tester = explicitTesters[capability] ?? fallbackTesterForCapability(capability);
  registerCapabilityTest(capability as CapabilityId, tester);
}

// Legacy aliases kept for compatibility in validation code paths.
registerCapabilityTest('translation' as CapabilityId, chatTest);
registerCapabilityTest('summarization' as CapabilityId, chatTest);
registerCapabilityTest('sentiment_analysis' as CapabilityId, chatTest);
registerCapabilityTest('entity_recognition' as CapabilityId, chatTest);
registerCapabilityTest('action_planning' as CapabilityId, reasoningTest);
registerCapabilityTest('self-correction' as CapabilityId, reasoningTest);

export { getCapabilityTest, hasCapabilityTest, getRegisteredCapabilities } from './registry';
export type {
  CapabilityId,
  CapabilityTester,
  CapabilityTestResult,
  CapabilityTestContext,
} from './capabilities';
