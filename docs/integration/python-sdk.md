<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Python SDK Integration

Basic integration with `requests` for `/v1/responses` and `/v1/chat/completions`.

## Setup

```bash
pip install requests
```

## Making Requests

```python
import os
import requests

BASE_URL = "https://api.ailin.one/v1"
TOKEN = os.environ.get("AILIN_TOKEN", "")

payload = {
    "model": "ailin-auto",
    "input": "Generate a concise production readiness checklist."
}

resp = requests.post(
    f"{BASE_URL}/responses",
    headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    },
    json=payload,
    timeout=60,
)

print(resp.status_code)
print(resp.text)
```

## TypeScript Equivalent

Same call from TypeScript via `fetch`, for teams mixing SDKs across services:

```ts
const baseUrl = "https://api.ailin.one/v1";
const token = process.env.AILIN_TOKEN || "";

const response = await fetch(`${baseUrl}/responses`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "ailin-auto",
    input: "Generate a concise production readiness checklist.",
  }),
});

console.log(await response.json());
```

See the [TypeScript SDK guide](typescript-sdk.md) for retry and observability patterns.

## Production Recommendations

- explicit timeout per request
- exponential backoff for `429` and `503`
- request tracing with `X-Request-Id` and `X-Correlation-Id`
- structured logging for `ailin_metadata` and cost fields
