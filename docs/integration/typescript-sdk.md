<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# TypeScript SDK Integration

Recommended integration using `fetch` with OpenAI-compatible contract plus Ailin extensions.

## Basic Setup

```bash
npm install undici
```

## Making Requests

Use `model: "ailin-auto"` to keep client code stable while backend strategy remains dynamic.

```ts
const baseUrl = "https://api.ailin.one/v1";
const token = process.env.AILIN_TOKEN || "";

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "ailin-auto",
    messages: [{ role: "user", content: "Summarize this request." }],
  }),
});

const data = await response.json();
console.log(data);
```

## Python Equivalent

Same call from Python via `requests`, for teams mixing SDKs across services:

```python
import os
import requests

base_url = "https://api.ailin.one/v1"
token = os.environ.get("AILIN_TOKEN", "")

response = requests.post(
    f"{base_url}/chat/completions",
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    },
    json={
        "model": "ailin-auto",
        "messages": [{"role": "user", "content": "Summarize this request."}],
    },
)

print(response.json())
```

See the [Python SDK guide](python-sdk.md) for production-oriented patterns.

## Best Practices

Recommended runtime checks:

- `response.status`
- `usage` fields
- `ailin_metadata.final_decider_*`

Fallback strategy:

1. Retry on `429/503` with backoff.
2. Preserve idempotency keys when available.
3. Log `X-Request-Id` and `X-Correlation-Id`.
