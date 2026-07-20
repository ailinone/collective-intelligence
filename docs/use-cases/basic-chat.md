<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Use Case: Basic Chat

## Scenario

Single-turn chat completion with automatic model routing.

```bash
curl -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ailin-auto",
    "messages": [{"role":"user","content":"Explain tenant isolation in 2 lines."}]
  }'
```

```ts
const response = await fetch("https://api.ailin.one/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "ailin-auto",
    messages: [{ role: "user", content: "Explain tenant isolation in 2 lines." }],
  }),
});
console.log(await response.json());
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
        "messages": [{"role": "user", "content": "Explain tenant isolation in 2 lines."}],
    },
)
print(resp.status_code, resp.text)
```
