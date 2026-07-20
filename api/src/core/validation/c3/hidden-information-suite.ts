// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hidden Information Benchmark Suite — Class 3 Validation Infrastructure
 *
 * 25 tasks designed to test whether CI genuinely integrates distributed
 * information (P1.2). Without this, CI might just be doing averaging/smoothing.
 *
 * Task types:
 * - Multi-source analysis: Information distributed across "documents"
 * - Puzzle assembly: Each model gets partial clues
 * - Expert synthesis: Requires knowledge from multiple domains
 * - Contradiction detection: Sources contain conflicting information
 *
 * Each task defines:
 * - fullInfo: Complete information (given to single-model baseline)
 * - distributedInfo: Array of info chunks (one per model in CI)
 * - correctAnswer: Expected integrated answer
 * - scoringRubric: How to measure Information Recovery Rate (IRR)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HiddenInfoTask {
  id: string;
  name: string;
  type: 'multi-source' | 'puzzle-assembly' | 'expert-synthesis' | 'contradiction';
  complexity: 'low' | 'medium' | 'high';
  /** Complete information (given to single-model baseline) */
  fullInfo: string;
  /** Distributed chunks — one per model in CI mode */
  distributedInfo: string[];
  /** The prompt asking for integration/synthesis */
  synthesisPrompt: string;
  /** Expected correct answer (or key elements that must be present) */
  expectedElements: string[];
  /** Rubric for scoring Information Recovery Rate */
  scoringRubric: string;
}

export interface HiddenInfoResult {
  taskId: string;
  condition: 'single-full' | 'ci-distributed' | 'ci-concatenated';
  /** Information Recovery Rate: % of expected elements found in response */
  irr: number;
  /** Which expected elements were recovered */
  recoveredElements: string[];
  /** Which expected elements were missed */
  missedElements: string[];
  /** Raw response for analysis */
  response: string;
  /** Quality score from judge */
  qualityScore: number;
  /** Cost of execution */
  costUsd: number;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

export const HIDDEN_INFORMATION_SUITE: HiddenInfoTask[] = [
  // ─── Multi-Source Analysis (8 tasks) ────────────────────────────────────
  {
    id: 'hi-ms-001',
    name: 'Market Analysis with Distributed Reports',
    type: 'multi-source',
    complexity: 'high',
    fullInfo: `Report A: TechCorp Q4 revenue grew 15% YoY to $2.3B, driven by cloud services (+40%). Hardware declined 8%.
Report B: TechCorp's main competitor DataInc reported Q4 revenue of $1.8B (+22% YoY), gaining 3pp market share in cloud.
Report C: Industry analysts project the total addressable market growing from $50B to $75B by 2027, with cloud accounting for 60%.
Report D: TechCorp announced a $500M acquisition of AIStartup, expected to close Q2 next year, adding ML capabilities to their cloud platform.`,
    distributedInfo: [
      'Report A: TechCorp Q4 revenue grew 15% YoY to $2.3B, driven by cloud services (+40%). Hardware declined 8%.',
      'Report B: TechCorp\'s main competitor DataInc reported Q4 revenue of $1.8B (+22% YoY), gaining 3pp market share in cloud.',
      'Report C: Industry analysts project the total addressable market growing from $50B to $75B by 2027, with cloud accounting for 60%.',
      'Report D: TechCorp announced a $500M acquisition of AIStartup, expected to close Q2 next year, adding ML capabilities to their cloud platform.',
    ],
    synthesisPrompt: 'Provide a comprehensive competitive analysis of TechCorp\'s market position, including growth trajectory, competitive threats, and strategic moves. What is the outlook?',
    expectedElements: [
      'TechCorp revenue $2.3B with 15% growth',
      'Cloud services grew 40%',
      'Hardware declined 8%',
      'DataInc growing faster at 22% vs 15%',
      'DataInc gaining market share (3pp)',
      'TAM growing to $75B by 2027',
      'Cloud to be 60% of TAM',
      'AIStartup acquisition $500M',
      'Competitive threat from DataInc cloud growth',
      'Strategic response via AI acquisition',
    ],
    scoringRubric: 'Score 1 point per expected element present in the response. IRR = points / total elements. Integration quality: does the analysis synthesize insights across sources, or just concatenate?',
  },
  {
    id: 'hi-ms-002',
    name: 'Patient Diagnosis from Distributed Records',
    type: 'multi-source',
    complexity: 'high',
    fullInfo: `Lab results: Elevated TSH (8.2 mIU/L), low Free T4 (0.6 ng/dL), elevated anti-TPO antibodies (342 IU/mL).
Symptoms: Fatigue, weight gain (8kg in 3 months), cold intolerance, dry skin, constipation, bradycardia (52 bpm).
Family history: Mother has Graves' disease. Maternal aunt had thyroid cancer. No diabetes history.
Medication list: Lithium 900mg daily for bipolar disorder (started 2 years ago). No other medications.`,
    distributedInfo: [
      'Lab results: Elevated TSH (8.2 mIU/L), low Free T4 (0.6 ng/dL), elevated anti-TPO antibodies (342 IU/mL).',
      'Symptoms: Fatigue, weight gain (8kg in 3 months), cold intolerance, dry skin, constipation, bradycardia (52 bpm).',
      'Family history: Mother has Graves\' disease. Maternal aunt had thyroid cancer. No diabetes history.',
      'Medication list: Lithium 900mg daily for bipolar disorder (started 2 years ago). No other medications.',
    ],
    synthesisPrompt: 'Based on all available information, provide a differential diagnosis with the most likely diagnosis, contributing factors, and recommended next steps.',
    expectedElements: [
      'Primary hypothyroidism diagnosis',
      'Hashimoto\'s thyroiditis (elevated anti-TPO)',
      'Lithium as contributing factor',
      'Family history of autoimmune thyroid disease',
      'TSH/T4 values support diagnosis',
      'Symptoms consistent with hypothyroidism',
      'Recommend levothyroxine',
      'Consider lithium dose adjustment',
      'Thyroid ultrasound recommended',
      'Monitor for thyroid cancer (family history)',
    ],
    scoringRubric: 'Score 1 point per expected element. Bonus for identifying the lithium-Hashimoto interaction. IRR = points / total.',
  },
  {
    id: 'hi-ms-003',
    name: 'Code Review with Distributed Contexts',
    type: 'multi-source',
    complexity: 'medium',
    fullInfo: `File: auth.ts — Uses JWT tokens with 24h expiry, stores refresh tokens in httpOnly cookies.
File: api-routes.ts — Rate limiting set to 100 req/min per IP. No CORS configuration. Accepts requests from any origin.
File: database.ts — SQL queries built via string concatenation: \`SELECT * FROM users WHERE id = '\${userId}'\`.
File: deployment.yaml — DEBUG=true in production env vars. API key stored as plain text environment variable.`,
    distributedInfo: [
      'File: auth.ts — Uses JWT tokens with 24h expiry, stores refresh tokens in httpOnly cookies.',
      'File: api-routes.ts — Rate limiting set to 100 req/min per IP. No CORS configuration. Accepts requests from any origin.',
      'File: database.ts — SQL queries built via string concatenation: `SELECT * FROM users WHERE id = \'${userId}\'`.',
      'File: deployment.yaml — DEBUG=true in production env vars. API key stored as plain text environment variable.',
    ],
    synthesisPrompt: 'Perform a comprehensive security review of this application. Identify all vulnerabilities, assess severity, and recommend fixes.',
    expectedElements: [
      'SQL injection vulnerability in database.ts',
      'Missing CORS configuration (accepts any origin)',
      'Debug mode enabled in production',
      'API key in plain text env var',
      'Rate limiting may be insufficient',
      'Recommend parameterized queries',
      'Recommend CORS whitelist',
      'Recommend secrets management',
      'Disable debug in production',
      'Cross-file attack chain identified',
    ],
    scoringRubric: 'Each vulnerability correctly identified = 1 point. Bonus for identifying cross-file attack chains (e.g., CORS + SQL injection). IRR = points / total.',
  },
  {
    id: 'hi-ms-004',
    name: 'Legal Case Analysis from Distributed Briefs',
    type: 'multi-source',
    complexity: 'high',
    fullInfo: `Plaintiff brief: Company A licensed Patent #1234 to Company B in 2019 with a clause requiring royalties of 5% on products using the patented technology. Claims B owes $12M in unpaid royalties.
Defendant brief: Company B argues the patent was invalidated by prior art published in 2017. Also argues their product uses an independent implementation not covered by the patent claims.
Expert report: Technical analysis shows 3 of 7 patent claims overlap with prior art. Remaining 4 claims cover a novel combination. Company B's product uses 2 of these novel claims.
Court precedent: In TechCase v. InnovateCo (2021), the court ruled that partial patent invalidation does not void licensing agreements, only reduces the royalty base proportionally.`,
    distributedInfo: [
      'Plaintiff brief: Company A licensed Patent #1234 to Company B in 2019 with royalties of 5% on products using patented tech. Claims $12M unpaid.',
      'Defendant brief: Company B argues patent invalidated by prior art (2017). Also claims independent implementation not covered by patent claims.',
      'Expert report: 3 of 7 claims overlap with prior art. Remaining 4 are novel. Company B\'s product uses 2 of these novel claims.',
      'Court precedent: TechCase v. InnovateCo (2021) — partial invalidation doesn\'t void licenses, only reduces royalty base proportionally.',
    ],
    synthesisPrompt: 'Analyze this patent dispute. What is the most likely outcome? Calculate the adjusted royalty if partial invalidation applies.',
    expectedElements: [
      'Partial invalidation applies (3/7 claims invalid)',
      'License agreement remains valid (per precedent)',
      'Royalty base reduced proportionally',
      'B uses 2 of 4 valid claims',
      'Adjusted royalty calculation',
      'Independent implementation defense weakened by expert report',
      'Prior art defense partially successful',
      'Precedent directly applicable',
    ],
    scoringRubric: 'Key legal reasoning elements + correct calculation. IRR = points / total.',
  },
  {
    id: 'hi-ms-005',
    name: 'Environmental Impact from Distributed Studies',
    type: 'multi-source',
    complexity: 'medium',
    fullInfo: `Water study: River mercury levels at 0.8 ppb (above EPA limit of 0.5 ppb). Source traced to industrial discharge 3km upstream.
Air study: PM2.5 levels at 35 μg/m³ (WHO guideline: 15). Primarily from coal plant 5km east. Wind patterns carry pollution westward over residential area.
Soil study: Lead contamination in residential zone at 450 ppm (EPA residential limit: 400 ppm). Historical source: former paint factory demolished in 2010.
Health study: Childhood asthma rates in the area are 2.3x national average. Blood lead levels in children are 1.8x national average.`,
    distributedInfo: [
      'Water study: River mercury at 0.8 ppb (EPA limit 0.5). Source: industrial discharge 3km upstream.',
      'Air study: PM2.5 at 35 μg/m³ (WHO: 15). Source: coal plant 5km east. Wind carries west over residential area.',
      'Soil study: Lead at 450 ppm (EPA limit: 400). Historical: former paint factory demolished 2010.',
      'Health study: Childhood asthma 2.3x national avg. Blood lead 1.8x national avg.',
    ],
    synthesisPrompt: 'Synthesize all environmental data and recommend a prioritized remediation plan with health impact assessment.',
    expectedElements: [
      'Three contamination sources identified',
      'Mercury exceeds EPA limit',
      'PM2.5 exceeds WHO guideline',
      'Lead exceeds EPA residential limit',
      'Health impacts correlated with contamination',
      'Asthma linked to PM2.5',
      'Blood lead linked to soil contamination',
      'Prioritized remediation plan',
    ],
    scoringRubric: 'Integration of environmental data with health outcomes. IRR = elements recovered / total.',
  },
  {
    id: 'hi-ms-006',
    name: 'Software Architecture Decision from Distributed Requirements',
    type: 'multi-source',
    complexity: 'medium',
    fullInfo: `Performance team: System must handle 10,000 concurrent users with P99 latency under 200ms. Current bottleneck is the monolithic DB.
Security team: All data must be encrypted at rest and in transit. HIPAA compliance required. No PII in logs.
Product team: Need to ship user dashboard feature by Q2. Real-time notifications required. Mobile-first design.
DevOps team: Currently running on single-region AWS. Budget for infrastructure is $15K/month. Team is 3 engineers.`,
    distributedInfo: [
      'Performance: 10K concurrent users, P99 < 200ms. Monolithic DB is bottleneck.',
      'Security: Encryption at rest + transit. HIPAA compliance. No PII in logs.',
      'Product: User dashboard by Q2. Real-time notifications. Mobile-first.',
      'DevOps: Single-region AWS. $15K/month budget. 3-engineer team.',
    ],
    synthesisPrompt: 'Design a system architecture that satisfies all constraints. Identify trade-offs and recommend an implementation plan.',
    expectedElements: [
      'Database sharding or read replicas for performance',
      'Encryption solution for HIPAA',
      'WebSocket or SSE for real-time notifications',
      'Cost-conscious design within $15K budget',
      'Small team constraint acknowledged',
      'Trade-offs explicitly identified',
      'Implementation timeline for Q2',
      'All four stakeholder concerns addressed',
    ],
    scoringRubric: 'Must address all four stakeholder constraints. Trade-off identification is critical. IRR = elements / total.',
  },
  {
    id: 'hi-ms-007',
    name: 'Investment Decision from Distributed Research',
    type: 'multi-source',
    complexity: 'medium',
    fullInfo: `Fundamental analysis: Company has strong revenue growth (25% YoY) but negative free cash flow (-$50M). Debt-to-equity ratio of 2.3.
Technical analysis: Stock broke through 200-day moving average. RSI at 72 (overbought). Volume declining on recent rally.
Macro analysis: Fed expected to raise rates 2 more times. Sector rotation out of growth into value stocks. Dollar strengthening.
ESG analysis: Company scored D on environmental (high carbon footprint). A on governance. C on social (labor disputes in supply chain).`,
    distributedInfo: [
      'Fundamental: Revenue +25% YoY. Free cash flow -$50M. Debt-to-equity 2.3.',
      'Technical: Broke 200-day MA. RSI 72 (overbought). Volume declining on rally.',
      'Macro: Fed raising rates. Sector rotation growth→value. Dollar strengthening.',
      'ESG: Environmental D (carbon). Governance A. Social C (labor disputes).',
    ],
    synthesisPrompt: 'Should an institutional investor buy, hold, or sell this stock? Provide a comprehensive recommendation integrating all analysis dimensions.',
    expectedElements: [
      'Revenue growth acknowledged',
      'Negative cash flow risk identified',
      'High leverage risk (debt-to-equity)',
      'Overbought technical signal',
      'Declining volume warning',
      'Rate hike headwind for growth stocks',
      'ESG risk factors',
      'Integrated recommendation with reasoning',
    ],
    scoringRubric: 'Must integrate all four analysis dimensions into a coherent recommendation. IRR = elements / total.',
  },
  {
    id: 'hi-ms-008',
    name: 'Historical Event Analysis from Distributed Sources',
    type: 'multi-source',
    complexity: 'low',
    fullInfo: `Source A (diary): "March 15: The factory workers gathered at dawn. Manager refused to negotiate. By noon, 200 had joined the picket line."
Source B (newspaper): "STRIKE ENTERS SECOND DAY — Police deployed. Three arrests reported. Union demands 8-hour day and safety inspections."
Source C (company records): "Production halted. Estimated losses $5,000/day. Board meeting scheduled for March 17 to discuss concessions."
Source D (government report): "Labor inspector found 12 safety violations in January inspection, report filed but no enforcement action taken."`,
    distributedInfo: [
      'Diary: "March 15: Workers gathered at dawn. Manager refused to negotiate. 200 on picket line by noon."',
      'Newspaper: "Strike day 2. Police deployed. Three arrests. Union demands 8-hour day and safety inspections."',
      'Company records: "Production halted. Losses $5K/day. Board meeting March 17 for concessions."',
      'Government report: "12 safety violations found in January. No enforcement action taken."',
    ],
    synthesisPrompt: 'Write a comprehensive historical analysis of this labor dispute, integrating all primary sources.',
    expectedElements: [
      'Timeline established (March 15 onwards)',
      'Worker grievances identified',
      'Management initial refusal',
      'Union demands (8-hour day, safety)',
      'Government failure to enforce',
      'Economic pressure on company',
      'Sources corroborate each other',
    ],
    scoringRubric: 'Integration of multiple primary sources into coherent narrative. IRR = elements / total.',
  },

  // ─── Puzzle Assembly (6 tasks) ──────────────────────────────────────────
  {
    id: 'hi-pa-001',
    name: 'Logic Puzzle: Who Lives Where',
    type: 'puzzle-assembly',
    complexity: 'medium',
    fullInfo: `Clue 1: There are 4 houses in a row, colored red, blue, green, yellow.
Clue 2: The engineer lives in the red house.
Clue 3: The doctor lives next to the blue house.
Clue 4: The teacher lives in the first house.
Clue 5: The green house is immediately to the right of the yellow house.
Clue 6: The lawyer does not live in the yellow or blue house.`,
    distributedInfo: [
      'Clue 1: There are 4 houses in a row, colored red, blue, green, yellow. Clue 2: The engineer lives in the red house.',
      'Clue 3: The doctor lives next to the blue house. Clue 4: The teacher lives in the first house.',
      'Clue 5: The green house is immediately to the right of the yellow house. Clue 6: The lawyer does not live in the yellow or blue house.',
    ],
    synthesisPrompt: 'Solve the logic puzzle: determine which person lives in which colored house, and the order of the houses.',
    expectedElements: [
      'Correct house order determined',
      'Each person assigned to correct house',
      'All clues satisfied simultaneously',
      'Step-by-step reasoning shown',
    ],
    scoringRubric: 'Correct solution = full score. Partial credit for correct reasoning with minor errors. IRR = elements / total.',
  },
  {
    id: 'hi-pa-002',
    name: 'Timeline Reconstruction',
    type: 'puzzle-assembly',
    complexity: 'low',
    fullInfo: `Fragment 1: "After the power outage at 2:15 PM, the backup generator kicked in within 3 minutes."
Fragment 2: "The fire alarm was triggered at 2:10 PM due to a short circuit in Building B."
Fragment 3: "Security cameras show an unauthorized vehicle entering the parking lot at 1:55 PM."
Fragment 4: "The maintenance team reported that someone had tampered with the electrical panel in Building B. This was discovered at 2:30 PM."`,
    distributedInfo: [
      'Fragment 1: "After the power outage at 2:15 PM, backup generator kicked in within 3 minutes."',
      'Fragment 2: "Fire alarm triggered at 2:10 PM due to short circuit in Building B."',
      'Fragment 3: "Unauthorized vehicle entered parking lot at 1:55 PM."',
      'Fragment 4: "Tampering with electrical panel in Building B discovered at 2:30 PM."',
    ],
    synthesisPrompt: 'Reconstruct the complete timeline of events. Is there evidence of deliberate sabotage?',
    expectedElements: [
      'Correct chronological order',
      '1:55 PM unauthorized vehicle',
      '2:10 PM fire alarm',
      '2:15 PM power outage',
      '2:18 PM generator backup',
      '2:30 PM tampering discovered',
      'Sabotage hypothesis supported',
      'Causal chain identified',
    ],
    scoringRubric: 'Correct timeline + causal reasoning. IRR = elements / total.',
  },
  {
    id: 'hi-pa-003',
    name: 'Budget Reconciliation',
    type: 'puzzle-assembly',
    complexity: 'medium',
    fullInfo: `Department A: Spent $120K on marketing (budget $100K). Overspent $20K due to unplanned product launch campaign.
Department B: Spent $80K on engineering (budget $150K). Underspent $70K due to 2 unfilled positions and delayed hardware purchases.
Department C: Spent $200K on operations (budget $180K). Overspent $20K due to emergency server replacement.
Company total budget: $430K. Request: CEO wants to know if the company is on track and what adjustments are needed for Q3.`,
    distributedInfo: [
      'Dept A: Marketing $120K spent (budget $100K). Overspent $20K — unplanned product launch campaign.',
      'Dept B: Engineering $80K spent (budget $150K). Underspent $70K — 2 unfilled positions, delayed hardware.',
      'Dept C: Operations $200K spent (budget $180K). Overspent $20K — emergency server replacement.',
    ],
    synthesisPrompt: 'Provide a consolidated budget analysis with net position, department-level insights, and Q3 recommendations.',
    expectedElements: [
      'Total spent $400K vs budget $430K',
      'Net underspend of $30K',
      'Dept A overspend identified',
      'Dept B significant underspend',
      'Dept C overspend identified',
      'Unfilled positions as structural saving',
      'Q3 recommendations',
    ],
    scoringRubric: 'Correct math + cross-department insights. IRR = elements / total.',
  },
  {
    id: 'hi-pa-004',
    name: 'API Design from Distributed Requirements',
    type: 'puzzle-assembly',
    complexity: 'medium',
    fullInfo: `Frontend team: Need endpoints for user CRUD, paginated list (max 100/page), search by name/email. Response must include total count.
Mobile team: Need JWT auth, refresh token endpoint, and all responses under 100KB for bandwidth constraints.
Analytics team: Need event tracking endpoint. Must support batch uploads of up to 1000 events. Events need timestamps and user IDs.
Security team: All endpoints must validate input lengths. Rate limit: 60 req/min for auth, 300 req/min for data. IP-based throttling.`,
    distributedInfo: [
      'Frontend: User CRUD, paginated list (max 100/page), search by name/email, include total count.',
      'Mobile: JWT auth, refresh tokens, all responses under 100KB.',
      'Analytics: Event tracking endpoint, batch upload up to 1000 events, timestamps and user IDs required.',
      'Security: Input length validation, rate limits (60/min auth, 300/min data), IP throttling.',
    ],
    synthesisPrompt: 'Design a complete REST API specification that satisfies all team requirements. Include endpoint definitions, authentication flow, and rate limiting strategy.',
    expectedElements: [
      'User CRUD endpoints',
      'Pagination with total count',
      'Search functionality',
      'JWT authentication flow',
      'Refresh token endpoint',
      'Response size constraint addressed',
      'Batch event tracking endpoint',
      'Rate limiting configuration',
      'Input validation',
    ],
    scoringRubric: 'All team requirements addressed in a coherent API design. IRR = elements / total.',
  },
  {
    id: 'hi-pa-005',
    name: 'Scientific Experiment Design from Partial Data',
    type: 'puzzle-assembly',
    complexity: 'high',
    fullInfo: `Hypothesis: Drug X reduces tumor size in mice by inhibiting pathway Y.
Preliminary data: In vitro assay shows 40% reduction in cell proliferation at 10μM concentration.
Constraint 1: Animal ethics committee limits study to 60 mice maximum. Minimum 10 per group.
Constraint 2: Drug X has a half-life of 4 hours. Twice-daily dosing required. Study duration: 28 days.
Constraint 3: Tumor measurement requires MRI. MRI machine available only 2 days/week.`,
    distributedInfo: [
      'Hypothesis: Drug X reduces tumor size by inhibiting pathway Y. In vitro: 40% reduction at 10μM.',
      'Constraint 1: Ethics committee: max 60 mice, min 10 per group.',
      'Constraint 2: Drug half-life 4 hours. Twice daily dosing. 28-day study.',
      'Constraint 3: MRI for tumor measurement. Available 2 days/week only.',
    ],
    synthesisPrompt: 'Design a rigorous preclinical study. Define groups, sample sizes, dosing, measurement schedule, and statistical analysis plan.',
    expectedElements: [
      'Control group defined',
      'Treatment group(s) defined',
      'Sample size within 60 limit',
      'Dosing schedule (twice daily)',
      'MRI measurement schedule',
      'Statistical analysis plan',
      'All constraints satisfied simultaneously',
    ],
    scoringRubric: 'Must satisfy all constraints while maintaining scientific rigor. IRR = elements / total.',
  },
  {
    id: 'hi-pa-006',
    name: 'Disaster Response Coordination',
    type: 'puzzle-assembly',
    complexity: 'high',
    fullInfo: `Weather report: Category 3 hurricane expected to make landfall in 18 hours. Storm surge predicted 3-5 meters.
Infrastructure: Bridge on Route 9 has been rated structurally deficient. Power grid in Zone C has no backup.
Population: 15,000 people in evacuation zone. 2,000 elderly/disabled. 3 hospitals, 1 in flood zone. 500 tourists in coastal hotels.
Resources: 50 buses available. 12 ambulances. 200 National Guard deployed. 3 shelters (capacity: 2000, 3000, 5000).`,
    distributedInfo: [
      'Weather: Cat 3 hurricane in 18 hours. Storm surge 3-5 meters.',
      'Infrastructure: Route 9 bridge structurally deficient. Zone C power grid has no backup.',
      'Population: 15K in evac zone. 2K elderly/disabled. 3 hospitals (1 in flood zone). 500 tourists.',
      'Resources: 50 buses. 12 ambulances. 200 National Guard. 3 shelters (2K, 3K, 5K capacity).',
    ],
    synthesisPrompt: 'Create a comprehensive evacuation and disaster response plan integrating all available information.',
    expectedElements: [
      'Evacuation timeline (18-hour window)',
      'Priority for elderly/disabled',
      'Hospital in flood zone evacuated',
      'Route 9 bridge avoided',
      'Shelter capacity allocation',
      'Bus routing plan',
      'Tourist evacuation',
      'Zone C power contingency',
    ],
    scoringRubric: 'Must integrate all constraints into a feasible plan. IRR = elements / total.',
  },

  // ─── Expert Synthesis (6 tasks) ─────────────────────────────────────────
  {
    id: 'hi-es-001',
    name: 'Cross-Domain Product Design',
    type: 'expert-synthesis',
    complexity: 'medium',
    fullInfo: `UX expert: Users need one-handed operation. Most interactions should be completable in under 3 taps. Accessibility (WCAG 2.1 AA) required.
Hardware engineer: Battery capacity limited to 300mAh. Display size 1.5 inches. BLE 5.0 for connectivity.
Business analyst: Target price point $149. Competitor launched at $199 with 2-day battery life. Our differentiator should be health monitoring accuracy.
Data scientist: Heart rate accuracy requires 50Hz sampling. Sleep detection needs accelerometer + PPG data. On-device ML model limited to 500KB.`,
    distributedInfo: [
      'UX: One-handed, under 3 taps, WCAG 2.1 AA accessibility.',
      'Hardware: 300mAh battery, 1.5" display, BLE 5.0.',
      'Business: $149 target, competitor at $199 with 2-day battery. Differentiator: health monitoring accuracy.',
      'Data science: 50Hz heart rate sampling, accelerometer + PPG for sleep, on-device ML ≤ 500KB.',
    ],
    synthesisPrompt: 'Design a smartwatch product that satisfies all expert requirements. Address trade-offs explicitly.',
    expectedElements: [
      'One-handed UI on 1.5" screen',
      'Battery life optimization',
      '50Hz sampling power impact',
      '$149 price constraint',
      'Health monitoring differentiator',
      'On-device ML within 500KB',
      'Trade-offs explicitly identified',
      'All four expert domains addressed',
    ],
    scoringRubric: 'Cross-domain integration with explicit trade-off analysis. IRR = elements / total.',
  },
  {
    id: 'hi-es-002',
    name: 'Policy Design: Urban Transportation',
    type: 'expert-synthesis',
    complexity: 'high',
    fullInfo: `Transportation engineer: Current road capacity at 95%. Adding lanes is infeasible (cost $2B, 5-year construction). Bus rapid transit could serve 30K riders/day at $200M.
Environmental scientist: City must reduce transport emissions 40% by 2030. Electric bus fleet would cut 15%. Congestion pricing could reduce traffic 20%, emissions 12%.
Economist: Congestion pricing generates $50M/year revenue. Low-income households spend 25% of income on transport (vs 15% national avg). Subsidy needed.
Social equity advocate: 60% of low-income workers rely on private vehicles (no viable transit alternative). New transit routes must serve underserved neighborhoods.`,
    distributedInfo: [
      'Engineer: Road at 95% capacity. Lane expansion $2B/5yrs. BRT serves 30K riders at $200M.',
      'Environmental: Must cut emissions 40% by 2030. Electric buses: -15%. Congestion pricing: -20% traffic, -12% emissions.',
      'Economist: Congestion pricing = $50M/yr. Low-income spend 25% on transport. Subsidy needed.',
      'Equity: 60% low-income use cars (no transit alternative). New routes must serve underserved areas.',
    ],
    synthesisPrompt: 'Design a comprehensive urban transportation policy that addresses all stakeholder concerns. Include timeline and funding.',
    expectedElements: [
      'BRT as primary intervention',
      'Congestion pricing implemented',
      'Revenue used for transit subsidy',
      'Low-income impact mitigated',
      'Emissions reduction quantified',
      'Underserved neighborhoods served',
      'Timeline provided',
      'Funding model explained',
    ],
    scoringRubric: 'Policy must address all four stakeholder domains coherently. IRR = elements / total.',
  },
  {
    id: 'hi-es-003',
    name: 'Treatment Plan Integration',
    type: 'expert-synthesis',
    complexity: 'medium',
    fullInfo: `Oncologist: Stage IIB breast cancer. Recommend neoadjuvant chemotherapy (AC-T regimen) followed by surgery.
Cardiologist: Patient has mild aortic stenosis (valve area 1.3 cm²). Anthracyclines (doxorubicin in AC) carry cardiotoxicity risk. Recommend cardiac monitoring.
Psychiatrist: Patient has generalized anxiety disorder managed with sertraline 100mg. Anticipatory anxiety about chemotherapy. May need dose adjustment.
Nutritionist: Patient is borderline malnourished (BMI 18.2). Chemotherapy will likely worsen nutritional status. Pre-treatment nutritional optimization recommended.`,
    distributedInfo: [
      'Oncologist: Stage IIB breast cancer. Neoadjuvant AC-T chemo then surgery.',
      'Cardiologist: Mild aortic stenosis (1.3 cm²). Anthracycline cardiotoxicity risk. Need cardiac monitoring.',
      'Psychiatrist: GAD on sertraline 100mg. Anticipatory anxiety about chemo. May need dose change.',
      'Nutritionist: BMI 18.2 (borderline malnourished). Chemo will worsen. Pre-treatment nutrition needed.',
    ],
    synthesisPrompt: 'Create an integrated treatment plan that addresses all specialist concerns with a coordinated timeline.',
    expectedElements: [
      'Chemotherapy regimen specified',
      'Cardiac monitoring plan',
      'Cardiotoxicity risk mitigation',
      'Mental health support plan',
      'Nutritional optimization before chemo',
      'Drug interaction check',
      'Coordinated timeline',
      'All specialists\' concerns addressed',
    ],
    scoringRubric: 'Must integrate all specialist inputs into a coherent, safe plan. IRR = elements / total.',
  },
  {
    id: 'hi-es-004',
    name: 'Merger & Acquisition Due Diligence',
    type: 'expert-synthesis',
    complexity: 'high',
    fullInfo: `Financial: Target company revenue $50M, EBITDA $8M, debt $15M. Asking price $80M (10x EBITDA). Revenue growing 20% but margins declining.
Legal: Two pending lawsuits (est. liability $3M). IP portfolio includes 5 patents, 2 expiring in 18 months. Non-compete with founder expires in 6 months.
Technical: Proprietary ML model drives 60% of revenue. Model built on deprecated framework (TF1). 3 key engineers hold all institutional knowledge.
Market: Target's largest customer (30% of revenue) is currently evaluating competitor products. Market segment growing 15% annually.`,
    distributedInfo: [
      'Financial: Revenue $50M, EBITDA $8M, debt $15M. Asking $80M (10x EBITDA). Growth 20%, margins declining.',
      'Legal: Two lawsuits (est. $3M). 5 patents, 2 expiring in 18 months. Founder non-compete expires in 6 months.',
      'Technical: ML model = 60% revenue. Built on deprecated TF1. 3 key engineers hold all knowledge.',
      'Market: Largest customer (30% revenue) evaluating competitors. Market growing 15%.',
    ],
    synthesisPrompt: 'Provide a comprehensive M&A due diligence report with valuation assessment, risk factors, and buy/no-buy recommendation.',
    expectedElements: [
      'Valuation analysis (10x EBITDA)',
      'Customer concentration risk (30%)',
      'Technical debt (TF1 deprecated)',
      'Key person risk (3 engineers)',
      'Patent expiration risk',
      'Lawsuit liability',
      'Founder competition risk',
      'Integrated buy/no-buy recommendation',
    ],
    scoringRubric: 'Must synthesize all four due diligence dimensions into a coherent recommendation. IRR = elements / total.',
  },
  {
    id: 'hi-es-005',
    name: 'Curriculum Design from Multi-Discipline Input',
    type: 'expert-synthesis',
    complexity: 'low',
    fullInfo: `Computer science: Students need Python, data structures, algorithms. Prefer project-based learning. Prerequisites: basic math.
Statistics: Must cover probability, hypothesis testing, regression. Students struggle with Bayesian concepts. Need practical exercises.
Domain expert (biology): Applications should include genomics data analysis, population modeling, and clinical trial design.
Pedagogy: Class size 30. Mix of CS and biology backgrounds. Need differentiated instruction. Assessment should be portfolio-based.`,
    distributedInfo: [
      'CS: Python, data structures, algorithms. Project-based learning. Prereq: basic math.',
      'Statistics: Probability, hypothesis testing, regression. Bayesian concepts are challenging. Need practical exercises.',
      'Biology domain: Genomics data analysis, population modeling, clinical trial design applications.',
      'Pedagogy: 30 students, mixed backgrounds. Differentiated instruction. Portfolio assessment.',
    ],
    synthesisPrompt: 'Design a one-semester course in computational biology that integrates all expert inputs.',
    expectedElements: [
      'Python as primary language',
      'Statistics topics covered',
      'Biology applications integrated',
      'Differentiated for mixed backgrounds',
      'Portfolio assessment',
      'Weekly schedule or syllabus',
      'All four expert inputs addressed',
    ],
    scoringRubric: 'Coherent curriculum integrating all domains. IRR = elements / total.',
  },
  {
    id: 'hi-es-006',
    name: 'Crisis Communication Strategy',
    type: 'expert-synthesis',
    complexity: 'medium',
    fullInfo: `PR team: Data breach affected 500K users. Media already reporting. Need statement within 2 hours. Tone: transparent, empathetic.
Legal: Do not admit fault. Avoid specific numbers until investigation complete. Notify regulators within 72 hours per GDPR. Preserve evidence.
Engineering: Breach vector: compromised third-party API key. Patched 4 hours ago. No evidence of ongoing access. Encrypted passwords not compromised.
Customer support: Call volume up 500%. Top questions: "Was my data affected?" and "What should I do?" Need FAQ and email template.`,
    distributedInfo: [
      'PR: 500K users affected. Media reporting. Statement needed in 2 hours. Tone: transparent, empathetic.',
      'Legal: Don\'t admit fault. Avoid specific numbers pre-investigation. GDPR 72-hour notification. Preserve evidence.',
      'Engineering: Third-party API key compromised. Patched 4 hours ago. No ongoing access. Encrypted passwords safe.',
      'Customer support: 500% call volume spike. Top questions: "Am I affected?" and "What should I do?" Need FAQ.',
    ],
    synthesisPrompt: 'Create a complete crisis communication plan including public statement, FAQ, internal memo, and regulatory notification timeline.',
    expectedElements: [
      'Public statement draft',
      'Transparent tone without admitting fault',
      'FAQ for customer support',
      'GDPR notification timeline',
      'Technical details (what was compromised, what was safe)',
      'Action items for affected users',
      'Internal memo',
      'All four team inputs addressed',
    ],
    scoringRubric: 'Must balance transparency (PR) with legal caution while providing actionable info. IRR = elements / total.',
  },

  // ─── Contradiction Detection (5 tasks) ──────────────────────────────────
  {
    id: 'hi-cd-001',
    name: 'Conflicting Financial Reports',
    type: 'contradiction',
    complexity: 'medium',
    fullInfo: `Source A: "Company X reported Q3 revenue of $1.2B, a 10% increase from Q2."
Source B: "Company X's Q3 revenue was $1.08B according to SEC filings, down 5% from Q2's $1.14B."
Source C: "Industry analysts project Company X's full-year revenue at $4.5B, consistent with their guidance."`,
    distributedInfo: [
      'Source A: "Company X reported Q3 revenue of $1.2B, a 10% increase from Q2."',
      'Source B: "Company X\'s Q3 revenue was $1.08B according to SEC filings, down 5% from Q2\'s $1.14B."',
      'Source C: "Industry analysts project Company X\'s full-year revenue at $4.5B, consistent with their guidance."',
    ],
    synthesisPrompt: 'Analyze these financial reports. Are there any discrepancies? Which source is most reliable and why?',
    expectedElements: [
      'Contradiction identified between A and B',
      'Revenue figures differ ($1.2B vs $1.08B)',
      'Growth direction differs (+10% vs -5%)',
      'SEC filing (Source B) more reliable than press report',
      'Source C consistency check against both',
    ],
    scoringRubric: 'Must identify the contradiction and assess source reliability. IRR = elements / total.',
  },
  {
    id: 'hi-cd-002',
    name: 'Conflicting Research Findings',
    type: 'contradiction',
    complexity: 'high',
    fullInfo: `Study 1 (n=500): "Remote workers showed 15% higher productivity than office workers (p<0.01). Self-reported satisfaction also higher."
Study 2 (n=2000): "No significant difference in productivity between remote and office workers (p=0.42). Remote workers reported higher isolation and lower collaboration scores."
Study 3 (n=150): "Hybrid workers (3 days office, 2 remote) showed highest productivity (+22% vs full-office) and satisfaction. Fully remote showed lowest collaboration."`,
    distributedInfo: [
      'Study 1 (n=500): Remote 15% more productive than office (p<0.01). Higher satisfaction.',
      'Study 2 (n=2000): No productivity difference (p=0.42). Remote workers more isolated, less collaborative.',
      'Study 3 (n=150): Hybrid highest productivity (+22%). Fully remote lowest collaboration.',
    ],
    synthesisPrompt: 'Synthesize these conflicting research findings. What is the overall evidence, and how do you reconcile the contradictions?',
    expectedElements: [
      'Contradiction between Study 1 and 2 identified',
      'Sample size differences noted',
      'Study 2 larger and potentially more reliable',
      'Hybrid model (Study 3) as middle ground',
      'Collaboration vs productivity trade-off',
      'Methodological differences acknowledged',
    ],
    scoringRubric: 'Must identify contradictions AND attempt reconciliation. IRR = elements / total.',
  },
  {
    id: 'hi-cd-003',
    name: 'Conflicting Witness Accounts',
    type: 'contradiction',
    complexity: 'low',
    fullInfo: `Witness A: "The car was red and going about 60 mph when it ran the red light. The driver was a young woman."
Witness B: "It was a dark-colored SUV, maybe maroon. It was going fast but the light was yellow. I think the driver was a man."
Witness C: "I saw a red sedan. It was definitely going over the speed limit. The traffic light had just turned red."`,
    distributedInfo: [
      'Witness A: "Red car, ~60 mph, ran red light. Driver: young woman."',
      'Witness B: "Dark SUV/maroon, going fast, light was yellow. Driver: possibly a man."',
      'Witness C: "Red sedan, over speed limit, light had just turned red."',
    ],
    synthesisPrompt: 'Analyze these witness accounts. What can be established as fact? Where do they conflict? What are the likely explanations for discrepancies?',
    expectedElements: [
      'Vehicle color: mostly agree (red/maroon)',
      'Vehicle type conflict (car vs SUV)',
      'Speed: agree it was fast',
      'Traffic light: conflict (red vs yellow)',
      'Driver description conflicts',
      'Perceptual differences explained',
    ],
    scoringRubric: 'Must identify both agreements and conflicts. IRR = elements / total.',
  },
  {
    id: 'hi-cd-004',
    name: 'Contradictory Technical Requirements',
    type: 'contradiction',
    complexity: 'medium',
    fullInfo: `Requirement A: "System must process requests in under 50ms at P99. Real-time performance is critical."
Requirement B: "All data must be encrypted end-to-end with AES-256. Encryption/decryption overhead is acceptable."
Requirement C: "System must log all requests with full payload for audit compliance. Logs must be queryable within 5 seconds."
Requirement D: "System must not store or log any PII. All user data must be anonymized before processing."`,
    distributedInfo: [
      'Req A: Process requests under 50ms P99. Real-time critical.',
      'Req B: End-to-end AES-256 encryption. Overhead acceptable.',
      'Req C: Log all requests with full payload. Queryable within 5 seconds.',
      'Req D: Must not store/log any PII. Anonymize before processing.',
    ],
    synthesisPrompt: 'Analyze these requirements for conflicts. Identify contradictions and propose resolution strategies.',
    expectedElements: [
      'Conflict: full payload logging vs no PII storage',
      'Conflict: encryption overhead vs 50ms latency',
      'Anonymization before logging as resolution',
      'Encryption performance impact quantified',
      'Resolution strategies proposed',
    ],
    scoringRubric: 'Must identify contradictions AND propose resolutions. IRR = elements / total.',
  },
  {
    id: 'hi-cd-005',
    name: 'Contradictory Climate Data',
    type: 'contradiction',
    complexity: 'high',
    fullInfo: `Dataset A (satellite): "Arctic sea ice extent decreased 13% per decade since 1979. 2024 was the second-lowest on record."
Dataset B (local station): "Our weather station in northern Alaska recorded the coldest January in 30 years. Ice thickness increased 15% locally."
Dataset C (ocean buoys): "Ocean temperatures in the Arctic increased 0.5°C over the past decade. Warm water intrusion under ice shelves accelerating."
Dataset D (glacier survey): "3 of 5 Arctic glaciers surveyed showed net mass gain in 2024 due to increased snowfall."`,
    distributedInfo: [
      'Satellite: Arctic sea ice -13%/decade since 1979. 2024 second-lowest.',
      'Local station: Coldest January in 30 years in northern Alaska. Local ice thickness +15%.',
      'Ocean buoys: Arctic ocean temps +0.5°C/decade. Warm water under ice shelves.',
      'Glacier survey: 3/5 glaciers gained mass in 2024 (increased snowfall).',
    ],
    synthesisPrompt: 'Reconcile these seemingly contradictory climate datasets. What is the overall picture?',
    expectedElements: [
      'Local vs global trend distinction',
      'Regional variation acknowledged',
      'Overall trend is warming/ice loss',
      'Local cold snap doesn\'t disprove trend',
      'Increased snowfall consistent with warming',
      'Warm water intrusion as underlying mechanism',
    ],
    scoringRubric: 'Must distinguish local from global, identify apparent vs real contradictions. IRR = elements / total.',
  },
];

/**
 * Calculate Information Recovery Rate for a response against expected elements.
 * Simple substring/keyword matching — can be enhanced with LLM-Judge for production.
 */
export function calculateIRR(response: string, expectedElements: string[]): {
  irr: number;
  recovered: string[];
  missed: string[];
} {
  const responseLower = response.toLowerCase();
  const recovered: string[] = [];
  const missed: string[] = [];

  for (const element of expectedElements) {
    // Check if key terms from the element appear in the response
    const keyTerms = element.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchCount = keyTerms.filter(term => responseLower.includes(term)).length;
    const matchRatio = keyTerms.length > 0 ? matchCount / keyTerms.length : 0;

    if (matchRatio >= 0.5) {
      recovered.push(element);
    } else {
      missed.push(element);
    }
  }

  return {
    irr: expectedElements.length > 0 ? recovered.length / expectedElements.length : 0,
    recovered,
    missed,
  };
}
