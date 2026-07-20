<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Quickstart

This quickstart gets you from zero to first request.

## 1. Prerequisites

- API base URL (example: `https://api.ailin.one/v1`)
- Bearer token or API key
- `curl` or HTTP client

## 2. Health Check

```bash
curl https://api.ailin.one/v1/status/health
```

## 3. List Models

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://api.ailin.one/v1/models
```

## 4. First Chat Completion

```bash
curl -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-auto",
    "messages": [
      { "role": "user", "content": "Summarize this API in 3 bullets." }
    ]
  }'
```

```ts
const completion = await fetch("https://api.ailin.one/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "ailin-auto",
    messages: [{ role: "user", content: "Summarize this API in 3 bullets." }],
  }),
});
console.log(await completion.json());
```

```python
import os
import requests

resp = requests.post(
    "https://api.ailin.one/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "Content-Type": "application/json",
    },
    json={
        "model": "ailin-auto",
        "messages": [{"role": "user", "content": "Summarize this API in 3 bullets."}],
    },
)
print(resp.status_code, resp.text)
```

## 5. Responses API

```bash
curl -X POST https://api.ailin.one/v1/responses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-auto",
    "input": "Create a short onboarding checklist for new developers."
  }'
```

## 6. Read Execution Metadata

Inspect `ailin_metadata` in the response:

- `strategy_used`
- `models_used`
- `resolved_strategy`
- `resolved_model`
- `final_decider_model_id`
- `final_decider_model_name`
- `final_decider_role`

## 7. Advanced: Request with Strategy Hints

Ailin can automatically select strategies, but you can also guide it. Here are examples for different use cases:

### High-Quality Analysis (Consensus Strategy)

For tasks where accuracy is critical (research, financial analysis, medical information):

```bash
curl -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-consensus",
    "messages": [
      { "role": "user", "content": "Analyze these 3 research papers and identify contradictions." }
    ],
    "strategy": "consensus",
    "require_capabilities": ["reasoning", "research-analysis"]
  }'
```

**Result:** Consensus strategy analyzes the request independently via 3-5 models, aggregates, synthesizes into one response. Runs for tens of seconds; designed for the highest-stakes requests.

---

### Complex Reasoning (Debate Strategy)

For problems that benefit from structured reasoning and opposing perspectives:

```bash
curl -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-reasoning",
    "messages": [
      { "role": "user", "content": "Debug this system: [complex architecture]. What are potential failure modes?" }
    ],
    "strategy": "debate",
    "require_capabilities": ["system-design", "debugging"]
  }'
```

**Result:** Debate strategy runs multi-round structured reasoning with Model A proposing, Model B critiquing, synthesis. Runs for tens of seconds.

---

### Cost-Optimized (Cost-Cascade Strategy)

For cost-conscious applications where you want high quality but don't want to overspend:

```bash
curl -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-cost-optimized",
    "messages": [
      { "role": "user", "content": "Summarize this article." }
    ],
    "strategy": "cost-cascade",
    "quality_threshold": 0.7,
    "max_cost": 0.05
  }'
```

**Result:** Cost-Cascade starts with a budget model. If confidence < 0.7, escalates to mid-tier. If still below threshold, escalates to premium. Cost-efficient while maintaining the configured quality floor.

---

### Real-Time Speed (Single Strategy)

For latency-critical applications (chat, streaming, real-time assistants):

```bash
curl -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-fast",
    "messages": [
      { "role": "user", "content": "What is 2 + 2?" }
    ],
    "strategy": "single",
    "max_latency_ms": 1000
  }'
```

**Result:** Single strategy routes to best-fit model with no orchestration overhead. The fastest path, with no orchestration overhead.

---

### TypeScript / Node.js Example with Strategy Hints

```ts
const completion = await fetch("https://api.ailin.one/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "ailin-consensus",  // or ailin-reasoning, ailin-cost-optimized, etc.
    messages: [
      {
        role: "user",
        content: "Fact-check this claim: ...",
      },
    ],
    strategy: "consensus",  // explicit strategy hint
    require_capabilities: ["factual-accuracy", "reasoning"],
    quality_threshold: 0.8,  // escalate if below 0.8
  }),
});

const response = await completion.json();
console.log("Response:", response.choices[0].message.content);
console.log("Strategy used:", response.ailin_metadata.strategy_used);
console.log("Quality score:", response.ailin_metadata.final_quality_score);
console.log("Actual cost:", response.ailin_metadata.cost_actual);
```

---

### Python Example

```python
import requests

resp = requests.post(
    "https://api.ailin.one/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "Content-Type": "application/json",
    },
    json={
        "model": "ailin-reasoning",
        "messages": [
            {
                "role": "user",
                "content": "Design a fault-tolerant payment system. What could go wrong?",
            }
        ],
        "strategy": "debate",  # Debate for reasoning
        "require_capabilities": ["system-design", "risk-analysis"],
    },
)

data = response.json()
print(f"Response: {data['choices'][0]['message']['content']}")
print(f"Strategy: {data['ailin_metadata']['strategy_used']}")
print(f"Quality: {data['ailin_metadata']['final_quality_score']}")
print(f"Models involved: {data['ailin_metadata']['models_used']}")
```

---

## 8. Next Steps

- Model aliases: `ci/docs/guides/model-aliases-and-routing.md`
- Migration from OpenAI-only clients: `ci/docs/guides/migration-guide.md`
- Errors/retries/limits: `ci/docs/guides/errors-rate-limits.md`
