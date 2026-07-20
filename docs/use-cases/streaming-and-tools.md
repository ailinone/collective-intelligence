<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Use Case: Streaming and Tools

## Scenario

Streaming chat response with tool contract enabled.

```bash
curl -N -X POST https://api.ailin.one/v1/chat/completions \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"ailin-auto",
    "stream": true,
    "messages":[{"role":"user","content":"Search and summarize release notes."}],
    "tools":[{"type":"function","function":{"name":"web_search","parameters":{"type":"object"}}}]
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
    stream: true,
    messages: [{ role: "user", content: "Search and summarize release notes." }],
    tools: [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }],
  }),
});
console.log(response.status);
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
        "stream": True,
        "messages": [{"role": "user", "content": "Search and summarize release notes."}],
        "tools": [{"type": "function", "function": {"name": "web_search", "parameters": {"type": "object"}}}],
    },
    stream=True,
)
print(resp.status_code)
```
