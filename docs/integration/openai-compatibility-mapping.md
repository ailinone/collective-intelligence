<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# OpenAI Compatibility Mapping

The public contract maintains operational compatibility with OpenAI for core flows while adding Ailin-specific routing and metadata.

## Endpoint Mapping

| OpenAI Pattern | Ailin Endpoint | Compatibility |
|---|---|---|
| `POST /chat/completions` | `POST /v1/chat/completions` | Direct ✅ |
| `GET /models` | `GET /v1/models` | Direct ✅ |
| `POST /embeddings` | `POST /v1/embeddings` | Direct ✅ |
| `POST /responses` | `POST /v1/responses` | Direct + Ailin metadata ✅ |
| — | `GET /v1/provider-capabilities` | Ailin extension |
| — | `POST /v1/analyze-requirements` | Ailin extension |
| — | `/v1/capabilities/*` | Ailin capability discovery |

## Compatibility Layer

Interface-level compatibility for core endpoints, with additional Ailin metadata and routing controls:

- `strategy` — Guide orchestration approach
- `max_cost` — Set cost ceiling
- `quality_target` — Set minimum quality
- `ailin_metadata.final_decider_*` — Understand which model decided

## Examples

```bash
curl -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-auto",
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

TypeScript:

```ts
const completion = await fetch("https://api.ailin.one/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "ailin-auto",
    messages: [{ role: "user", content: "Hello" }],
  }),
});
console.log(await completion.json());
```

Python:

```python
import os
import requests

response = requests.post(
    "https://api.ailin.one/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "Content-Type": "application/json",
    },
    json={
        "model": "ailin-auto",
        "messages": [{"role": "user", "content": "Hello"}],
    },
)
print(response.status_code, response.text)

- `strategy`
- `max_cost`
- `quality_target`
- `ailin_metadata.final_decider_*`
