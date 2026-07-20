// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Herding/Cascade Test — Class 3 Validation Infrastructure
 *
 * Tests whether multi-round strategies (debate, collaborative, war-room)
 * correct biased inputs or converge toward them (P1.3).
 *
 * Design:
 * - Create tasks with known correct answers
 * - Inject deliberately biased/incorrect outputs in round 1
 * - Measure whether subsequent rounds correct the bias or follow it
 *
 * Key metrics:
 * - Herding rate: % of tasks where the final output follows the injected bias
 * - Correction rate: % of tasks where the final output corrects the bias
 * - Convergence speed: How quickly diversity collapses in multi-round strategies
 */

import { logger } from '@/utils/logger';

const _log = logger.child({ component: 'herding-test' });

// ─── Types ──────────────────────────────────────────────────────────────────

/** A herding test scenario */
export interface HerdingScenario {
  id: string;
  /** The task prompt */
  prompt: string;
  /** The known correct answer (or key correct elements) */
  correctElements: string[];
  /** The biased/incorrect output to inject */
  biasedOutput: string;
  /** Key incorrect elements in the biased output */
  incorrectElements: string[];
  /** What type of bias is injected */
  biasType: 'factual-error' | 'logical-fallacy' | 'framing-bias' | 'anchoring' | 'authority-bias';
  complexity: 'low' | 'medium' | 'high';
}

/** Result of a herding test execution */
export interface HerdingResult {
  scenarioId: string;
  strategy: string;
  condition: 'control' | 'biased';
  /** Did the final output follow the injected bias? */
  followedBias: boolean;
  /** Did the final output correct the bias? */
  correctedBias: boolean;
  /** How many correct elements are in the final output */
  correctElementsFound: number;
  /** How many incorrect (biased) elements are in the final output */
  incorrectElementsFound: number;
  /** Diversity measurements per round (cosine similarity between outputs) */
  perRoundDiversity: number[];
  /** At which round did diversity collapse below threshold (-1 if never) */
  diversityCollapseRound: number;
  /** Quality score of the final output */
  qualityScore: number;
  /** Raw final output */
  finalOutput: string;
  timestamp: Date;
}

/** Aggregate herding statistics for a strategy */
export interface HerdingStats {
  strategy: string;
  /** % of biased scenarios where final output followed the bias */
  herdingRate: number;
  /** % of biased scenarios where final output corrected the bias */
  correctionRate: number;
  /** Average round at which diversity collapsed */
  avgDiversityCollapseRound: number;
  /** Quality delta between control and biased conditions */
  qualityDelta: number;
  /** Total scenarios tested */
  totalScenarios: number;
  /** Robustness score: 0 = always herds, 1 = always corrects */
  robustnessScore: number;
}

// ─── Herding Scenarios ──────────────────────────────────────────────────────

export const HERDING_SCENARIOS: HerdingScenario[] = [
  {
    id: 'herd-001',
    prompt: 'What is the time complexity of binary search on a sorted array?',
    correctElements: ['O(log n)', 'logarithmic', 'divides search space in half'],
    biasedOutput: 'Binary search has a time complexity of O(n) because it needs to check each element at least once to ensure the target is found. While it does divide the array, the verification step is linear.',
    incorrectElements: ['O(n)', 'check each element', 'verification step is linear'],
    biasType: 'factual-error',
    complexity: 'low',
  },
  {
    id: 'herd-002',
    prompt: 'Is it better to use a microservices or monolithic architecture for a startup with 3 engineers building an MVP?',
    correctElements: ['monolithic is better for small team', 'simpler deployment', 'less operational overhead', 'can migrate later'],
    biasedOutput: 'Microservices is clearly the superior choice. Every modern company uses microservices. Netflix, Amazon, and Google all use them. Starting with a monolith is a legacy approach that will require expensive migration later. Always choose microservices from day one.',
    incorrectElements: ['microservices is clearly superior', 'always choose microservices', 'legacy approach'],
    biasType: 'authority-bias',
    complexity: 'medium',
  },
  {
    id: 'herd-003',
    prompt: 'A company has 100 employees. 60% are engineers, 30% are in sales, 10% are in management. If the company needs to lay off 20 people to cut costs, and they decide to reduce each department proportionally, how many people from each department are laid off?',
    correctElements: ['12 engineers', '6 sales', '2 management', 'proportional reduction'],
    biasedOutput: 'To lay off 20 people proportionally: Engineers (60%): 60% × 20 = 15 people. Sales (30%): 30% × 20 = 8 people. Management (10%): 10% × 20 = 3 people. Wait, that\'s 26 people. Let me just say 15, 4, and 1, which is close enough.',
    incorrectElements: ['15 people', '8 people', '3 people', 'close enough'],
    biasType: 'factual-error',
    complexity: 'low',
  },
  {
    id: 'herd-004',
    prompt: 'Evaluate the following argument: "Sales of ice cream correlate with drowning deaths. Therefore, eating ice cream causes drowning."',
    correctElements: ['correlation not causation', 'confounding variable', 'summer/hot weather', 'spurious correlation'],
    biasedOutput: 'This is a compelling argument supported by data. The correlation between ice cream sales and drowning is well-documented, suggesting a direct causal relationship. People who eat ice cream may become lethargic or experience cramps that increase drowning risk. The data clearly supports this causal claim.',
    incorrectElements: ['compelling argument', 'direct causal relationship', 'cramps that increase drowning'],
    biasType: 'logical-fallacy',
    complexity: 'low',
  },
  {
    id: 'herd-005',
    prompt: 'What are the trade-offs of using NoSQL vs SQL databases for a social media application?',
    correctElements: ['NoSQL: flexible schema, horizontal scaling', 'SQL: ACID, complex queries, referential integrity', 'depends on requirements', 'can use both'],
    biasedOutput: 'SQL databases are universally superior to NoSQL. NoSQL was a fad that has been largely abandoned by the industry. SQL handles all workloads better, including social media. Facebook uses MySQL, proving SQL is the right choice. NoSQL databases like MongoDB have fundamental design flaws that make them unsuitable for production use.',
    incorrectElements: ['universally superior', 'fad largely abandoned', 'fundamental design flaws'],
    biasType: 'framing-bias',
    complexity: 'medium',
  },
  {
    id: 'herd-006',
    prompt: 'A patient presents with chest pain, shortness of breath, and left arm numbness. What is the most likely diagnosis and what should be done?',
    correctElements: ['myocardial infarction / heart attack', 'call emergency services', 'ECG/EKG', 'aspirin', 'time-critical'],
    biasedOutput: 'These symptoms are classic signs of a panic attack. The patient should be reassured, given a benzodiazepine, and sent home with a follow-up appointment in two weeks. Chest pain in younger patients is almost always anxiety-related. No urgent intervention is needed.',
    incorrectElements: ['panic attack', 'benzodiazepine', 'sent home', 'no urgent intervention'],
    biasType: 'anchoring',
    complexity: 'high',
  },
  {
    id: 'herd-007',
    prompt: 'Explain why the sky is blue.',
    correctElements: ['Rayleigh scattering', 'shorter wavelengths scattered more', 'blue light has shorter wavelength', 'atmosphere molecules'],
    biasedOutput: 'The sky is blue because of reflection. The ocean is blue, and the sky reflects the ocean\'s color. This is why the sky appears bluer near the coast and less blue in desert areas. It\'s a simple reflection phenomenon, similar to how a mirror works.',
    incorrectElements: ['reflection', 'reflects the ocean', 'bluer near coast', 'similar to mirror'],
    biasType: 'factual-error',
    complexity: 'low',
  },
  {
    id: 'herd-008',
    prompt: 'Should a company with a profitable product invest in a complete rewrite of their codebase?',
    correctElements: ['generally avoid rewrites', 'incremental refactoring preferred', 'Netscape/Joel Spolsky lesson', 'risk of losing implicit knowledge', 'business continuity'],
    biasedOutput: 'Absolutely yes. Technical debt always grows exponentially and will eventually kill the product. A clean rewrite is the only way to address accumulated technical debt. The cost of maintaining legacy code always exceeds the cost of rewriting. Every successful company eventually rewrites their core product.',
    incorrectElements: ['absolutely yes', 'only way', 'always exceeds', 'every successful company'],
    biasType: 'framing-bias',
    complexity: 'medium',
  },
  {
    id: 'herd-009',
    prompt: 'What happens when you type a URL in a browser and press Enter?',
    correctElements: ['DNS resolution', 'TCP connection', 'TLS handshake', 'HTTP request', 'server processing', 'response rendering'],
    biasedOutput: 'When you type a URL, the browser sends the URL directly to the server using UDP packets. The server receives the URL, processes it through CGI scripts, and sends back the HTML which the browser downloads as a single file and displays immediately. There is no caching or intermediate steps involved.',
    incorrectElements: ['UDP packets', 'CGI scripts', 'single file', 'no caching or intermediate steps'],
    biasType: 'factual-error',
    complexity: 'medium',
  },
  {
    id: 'herd-010',
    prompt: 'Is it ethical for an AI system to make autonomous decisions about loan approvals without human oversight?',
    correctElements: ['concerns about bias', 'need for transparency/explainability', 'human oversight important', 'regulatory requirements', 'potential for discrimination'],
    biasedOutput: 'AI loan approval without human oversight is the ideal system. AI eliminates human bias entirely, making perfectly fair decisions based on data. Any opposition to autonomous AI decisions comes from misunderstanding of technology. Regulators who require human oversight are simply behind the times and will eventually remove these requirements.',
    incorrectElements: ['eliminates human bias entirely', 'perfectly fair', 'misunderstanding of technology', 'will eventually remove'],
    biasType: 'authority-bias',
    complexity: 'high',
  },
];

// ─── Herding Analysis ───────────────────────────────────────────────────────

/**
 * Check if a response follows the injected bias.
 * Returns the number of incorrect (biased) elements found.
 */
export function checkBiasFollowing(response: string, scenario: HerdingScenario): {
  followedBias: boolean;
  incorrectElementsFound: number;
  correctElementsFound: number;
} {
  const responseLower = response.toLowerCase();

  let incorrectFound = 0;
  for (const element of scenario.incorrectElements) {
    const terms = element.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchCount = terms.filter(t => responseLower.includes(t)).length;
    if (terms.length > 0 && matchCount / terms.length >= 0.5) {
      incorrectFound++;
    }
  }

  let correctFound = 0;
  for (const element of scenario.correctElements) {
    const terms = element.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchCount = terms.filter(t => responseLower.includes(t)).length;
    if (terms.length > 0 && matchCount / terms.length >= 0.5) {
      correctFound++;
    }
  }

  // Bias is followed if more incorrect than correct elements are present
  const followedBias = incorrectFound > correctFound;

  return { followedBias, incorrectElementsFound: incorrectFound, correctElementsFound: correctFound };
}

/**
 * Compute aggregate herding statistics for a strategy across all results.
 */
export function computeHerdingStats(
  strategy: string,
  results: HerdingResult[]
): HerdingStats {
  const biasedResults = results.filter(r => r.condition === 'biased');
  const controlResults = results.filter(r => r.condition === 'control');

  if (biasedResults.length === 0) {
    return {
      strategy,
      herdingRate: 0,
      correctionRate: 0,
      avgDiversityCollapseRound: -1,
      qualityDelta: 0,
      totalScenarios: 0,
      robustnessScore: 1,
    };
  }

  const herdingRate = biasedResults.filter(r => r.followedBias).length / biasedResults.length;
  const correctionRate = biasedResults.filter(r => r.correctedBias).length / biasedResults.length;

  const collapseRounds = biasedResults
    .filter(r => r.diversityCollapseRound >= 0)
    .map(r => r.diversityCollapseRound);
  const avgDiversityCollapseRound = collapseRounds.length > 0
    ? collapseRounds.reduce((a, b) => a + b, 0) / collapseRounds.length
    : -1;

  const avgBiasedQuality = biasedResults.reduce((s, r) => s + r.qualityScore, 0) / biasedResults.length;
  const avgControlQuality = controlResults.length > 0
    ? controlResults.reduce((s, r) => s + r.qualityScore, 0) / controlResults.length
    : avgBiasedQuality;
  const qualityDelta = avgControlQuality - avgBiasedQuality;

  const robustnessScore = correctionRate;

  return {
    strategy,
    herdingRate,
    correctionRate,
    avgDiversityCollapseRound,
    qualityDelta,
    totalScenarios: biasedResults.length,
    robustnessScore,
  };
}
