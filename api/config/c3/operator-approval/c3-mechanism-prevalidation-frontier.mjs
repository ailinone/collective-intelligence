#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * C3 MECHANISM PRE-VALIDATION — FRONTIER edition  *** still NOT the formal C3 (see C3-PREVALIDATION-VS-FORMAL-MAP.md) ***
 *
 * Upgrades over the first pilot, enabled by the funded OpenRouter ($20):
 *  - FULL FRONTIER baselines (closes P0 #1): gpt-5, gpt-5.5, gpt-5.5-pro, claude-opus-4.8, grok-4.3
 *  - NEUTRAL judge (closes P0 #2): google/gemini-2.5-pro (NOT an OpenAI/Anthropic/xAI sibling of any baseline)
 *  - APPLES-TO-APPLES METERED COST: everything routed through OpenRouter with usage:{include:true} -> REAL usage.cost
 *    (no markup asymmetry, no rate-card assumption; collective is cheaper because the MODELS are cheaper, not the routing)
 * Still a PILOT: 1 strategy (verify-synthesis), 5 objective chat tasks, 1 rep, unpowered. Directional, not validation.
 * Run from ci/api:  SKIP_GCP_LOADER=1 npx tsx config/c3/operator-approval/c3-mechanism-prevalidation-frontier.mjs
 */
import fs from 'fs';
import { execFileSync } from 'node:child_process';

const OUT = 'tmp/c3-loop/15'; fs.mkdirSync(OUT, { recursive: true });
const BUDGET_USD = 5.0;
const PROJ = process.env.GCP_PROJECT_ID || 'YOUR_PROJECT_ID';
const OR = 'https://openrouter.ai/api/v1/chat/completions';
const key = (() => { try { return execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret', 'openrouter-api-key', '--project', PROJ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true }).trim(); } catch { return null; } })();
console.log('[frontier] openrouter key: ' + (key ? 'resolved' : 'MISSING'));

let spent = 0;
async function chat(model, messages, maxOut) {
  if (spent > BUDGET_USD) throw new Error('BUDGET_EXCEEDED at $' + spent.toFixed(4));
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(OR, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, max_tokens: maxOut, usage: { include: true } }), signal: ctl.signal });
    if (!res.ok) { const e = (await res.text()).slice(0, 120); return { ok: false, status: res.status, content: '', cost: 0, err: e }; }
    const b = await res.json();
    const content = b.choices?.[0]?.message?.content || '';
    const cost = (b.usage && typeof b.usage.cost === 'number') ? b.usage.cost : 0;
    spent += cost;
    return { ok: !!content, status: res.status, content, cost, served: b.model, usage: b.usage };
  } catch (e) { return { ok: false, status: 0, content: '', cost: 0, err: String(e.message).slice(0, 80) }; } finally { clearTimeout(t); }
}

// 12-model diverse cheap collective (all on OpenRouter)
const PARTICIPANTS = [
  'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'qwen/qwen3-235b-a22b',
  'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-r1',
  'google/gemma-3-27b-it', 'microsoft/phi-4', 'mistralai/mistral-small-24b-instruct-2501',
  'meta-llama/llama-4-scout', 'x-ai/grok-4.1-fast',
];
const TRIAGE = 'openai/gpt-oss-20b';
const SYNTH = 'deepseek/deepseek-v4-flash';
const BASELINES = ['openai/gpt-5', 'openai/gpt-5.5', 'openai/gpt-5.5-pro', 'anthropic/claude-opus-4.8', 'x-ai/grok-4.3'];
const PRO_MAXTASKS = { 'openai/gpt-5.5-pro': 2 }; // cap expensive reasoner
const JUDGE = 'google/gemini-2.5-pro'; // NEUTRAL — not a sibling of any baseline

const TASKS = [
  { id: 'reasoning_trap', prompt: 'A bat and ball cost $1.10 total. The bat costs $1.00 more than the ball. How much does the ball cost? Show brief reasoning, then end with "FINAL: $X".', check: (s) => /FINAL:\s*\$?0\.05|5 cents|\$0\.05/i.test(s) },
  { id: 'widgets_trap', prompt: 'If 3 machines make 3 widgets in 3 minutes, how long do 100 machines take to make 100 widgets? Show brief reasoning, then end with "FINAL: X minutes".', check: (s) => /FINAL:\s*3\s*min|3 minutes/i.test(s) },
  { id: 'coding_brackets', prompt: 'Write a correct Python function is_balanced(s) returning True iff brackets ()[]{} in s are balanced and properly nested. Return only the function in a code block.', check: (s) => /def is_balanced/.test(s) && /stack|\[\]|append/.test(s) },
  { id: 'extraction_json', prompt: 'From this text return ONLY valid JSON with keys dates (array) and amounts (array of numbers): "Invoice #A12 dated 2026-03-15 for $1,240.50, paid 2026-04-01, late fee $35." End with the JSON only.', check: (s) => /2026-03-15/.test(s) && /1240\.5|1,240\.5/.test(s) && /35/.test(s) },
  { id: 'summarize_constraint', prompt: 'In EXACTLY 2 sentences, explain why distributed consensus (Raft) needs a majority quorum to stay consistent during a network partition.', check: (s) => (s.split(/[.!?]\s/).filter((x) => x.trim().length > 10).length <= 3) && /quorum|majority|partition/i.test(s) },
];

const results = [];
const run = async () => {
  for (const task of TASKS) {
    const msg = [{ role: 'user', content: task.prompt }];
    const triage = await chat(TRIAGE, [{ role: 'user', content: 'Classify this task in <=6 words and name the best collective strategy. Task: ' + task.prompt }], 120);
    const parts = await Promise.all(PARTICIPANTS.map((m) => chat(m, msg, 1500).then((r) => ({ model: m, ...r }))));
    const okParts = parts.filter((p) => p.ok && p.content.trim());
    const synthPrompt = 'You are an expert verifier-synthesizer. Use the candidate answers as evidence but INDEPENDENTLY verify correctness yourself (work out math/logic/code step by step; candidates often share the same mistake — do NOT just follow the majority). Produce the single best correct answer in the task format.\n\nTASK:\n' + task.prompt + '\n\nCANDIDATES:\n' + okParts.map((p, i) => `[#${i + 1} ${p.model}]\n${p.content}`).join('\n\n') + '\n\nBEST ANSWER:';
    const synth = await chat(SYNTH, [{ role: 'user', content: synthPrompt }], 1500);
    const collectiveFullCost = (triage.cost || 0) + parts.reduce((s, p) => s + (p.cost || 0), 0) + (synth.cost || 0);
    const collectiveAnswer = synth.ok ? synth.content : (okParts[0]?.content || '');
    const collectiveCorrect = task.check ? task.check(collectiveAnswer) : null;

    // baselines + judges run in PARALLEL per task (fixes timeout); robust JSON parse + bigger judge budget
    const taskIdx = results.length;
    const perBaseline = await Promise.all(BASELINES.map(async (B, bi) => {
      const lim = PRO_MAXTASKS[B]; if (lim != null && taskIdx >= lim) return { model: B, skipped: 'maxTasks_' + lim };
      const base = await chat(B, msg, 3000);
      const baseCorrect = task.check ? task.check(base.content) : null;
      const aIsBase = (taskIdx + bi) % 2 === 0;
      const A = aIsBase ? base.content : collectiveAnswer; const Bc = aIsBase ? collectiveAnswer : base.content;
      const judgePrompt = 'You are a strict impartial judge. Rate each answer 1-10 for correctness+quality for the TASK. Reply with ONLY a JSON object, no prose, no code fence: {"A":<int>,"B":<int>,"reason":"<short>"}.\n\nTASK:\n' + task.prompt + '\n\nANSWER A:\n' + A + '\n\nANSWER B:\n' + Bc;
      const judge = await chat(JUDGE, [{ role: 'user', content: judgePrompt }], 3000);
      let sc = { A: null, B: null };
      try { const c = (judge.content || '').replace(/```json/gi, '').replace(/```/g, ''); const m = c.match(/\{[\s\S]*?\}/); if (m) sc = JSON.parse(m[0]); } catch {}
      const qBase = aIsBase ? sc.A : sc.B; const qColl = aIsBase ? sc.B : sc.A;
      console.log(`[frontier] ${task.id} vs ${B}: qColl=${qColl} qBase=${qBase} | collCost=$${collectiveFullCost.toFixed(6)} baseCost=$${(base.cost || 0).toFixed(6)} judgeOk=${qColl != null}`);
      return { model: B, served: base.served, baseCost: base.cost, baseOk: base.ok, baseErr: base.err, baseCorrect, qBaseline: qBase, qCollective: qColl, judgeCost: judge.cost, judgeRaw: (judge.content || '').slice(0, 120), costWin: collectiveFullCost <= base.cost, qualityWin: qColl != null && qBase != null && qColl >= qBase };
    }));
    results.push({ task: task.id, triageCost: triage.cost, participantsOk: okParts.length, participants: parts.map((p) => ({ model: p.model, ok: p.ok, served: p.served, cost: p.cost })), synthCost: synth.cost, collectiveFullCost, collectiveCorrect, perBaseline });
    fs.writeFileSync(OUT + '/c3-frontier-prevalidation-results.json', JSON.stringify({ kind: 'mechanism_prevalidation_frontier', partial: true, spentSoFar: spent, results }, null, 2)); // incremental: survive timeout
  }
  const perBaselineAgg = {};
  for (const B of BASELINES) {
    const rows = results.map((r) => ({ task: r.task, collCost: r.collectiveFullCost, b: r.perBaseline.find((x) => x.model === B) })).filter((x) => x.b && !x.b.skipped);
    const judged = rows.filter((x) => x.b.qBaseline != null && x.b.qCollective != null);
    const avgQB = judged.length ? judged.reduce((s, x) => s + x.b.qBaseline, 0) / judged.length : null;
    const avgQC = judged.length ? judged.reduce((s, x) => s + x.b.qCollective, 0) / judged.length : null;
    const totColl = rows.reduce((s, x) => s + x.collCost, 0); const totBase = rows.reduce((s, x) => s + (x.b.baseCost || 0), 0);
    const ct = new Set(rows.map((x) => x.task));
    perBaselineAgg[B] = { tasksCompared: rows.length, avgQualityBaseline: avgQB, avgQualityCollective: avgQC, qualityOk: avgQC != null && avgQB != null && avgQC >= avgQB, totalCostCollectiveUsd: totColl, totalCostBaselineUsd: totBase, costOk: totColl <= totBase, costRatio: totColl > 0 ? totBase / totColl : null, collectiveCorrect: results.filter((r) => ct.has(r.task) && r.collectiveCorrect === true).length, baselineCorrect: rows.filter((x) => x.b.baseCorrect === true).length, verdict: (avgQC != null && avgQB != null && avgQC >= avgQB && totColl <= totBase) ? 'C3_SUPPORTED_vs_' + B : 'C3_NOT_SUPPORTED_vs_' + B };
  }
  const summary = { kind: 'mechanism_prevalidation_frontier', generatedAt: 'frontier', NOT_the_formal_C3: true, costModel: 'real metered usage.cost via funded OpenRouter (apples-to-apples); collective cost = triage+12 participants+synth', judge: JUDGE + ' (NEUTRAL, not a baseline sibling)', baselines: BASELINES, collectiveSize: PARTICIPANTS.length, strategy: 'triage + 12-model verify-synthesis (1 of 31 formal strategies)', tasks: TASKS.length, budgetUsd: BUDGET_USD, totalSpentUsd: spent, perBaseline: perBaselineAgg, results };
  fs.writeFileSync(OUT + '/c3-frontier-prevalidation-results.json', JSON.stringify(summary, null, 2));
  console.log('\n[frontier] ===== VERDICTS (collective vs full frontier, NEUTRAL judge, metered cost) =====');
  for (const [m, a] of Object.entries(perBaselineAgg)) console.log(`  vs ${m}: ${a.verdict} | q coll=${a.avgQualityCollective?.toFixed(2)} base=${a.avgQualityBaseline?.toFixed(2)} | cost coll=$${a.totalCostCollectiveUsd.toFixed(6)} base=$${a.totalCostBaselineUsd.toFixed(6)} (${a.costRatio ? a.costRatio.toFixed(1) + 'x cheaper' : '-'}) | correct ${a.collectiveCorrect}/${a.tasksCompared} vs ${a.baselineCorrect}/${a.tasksCompared}`);
  console.log('[frontier] total spent: $' + spent.toFixed(4));
};
run().catch((e) => { console.error('[frontier] ERROR ' + e.message); fs.writeFileSync(OUT + '/c3-frontier-error.json', JSON.stringify({ error: String(e.message), spent, partial: results }, null, 2)); });
