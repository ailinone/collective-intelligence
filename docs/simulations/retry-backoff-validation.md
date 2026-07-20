<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Simulation: Retry and Backoff Validation

Validate client retry behavior for 429/503 scenarios.

```bash
curl -i -X POST https://api.ailin.one/v1/responses \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"ailin-economy","input":"retry validation run"}'
```

```ts
async function callWithRetry(payload, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch("https://api.ailin.one/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (![429, 503].includes(response.status) || attempt === maxRetries) return response;
    const retryAfter = Number(response.headers.get("Retry-After") || "1");
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
}
```

```python
import os
import time
import requests

payload = {"model": "ailin-economy", "input": "retry validation run"}

for attempt in range(4):
    response = requests.post(
        "https://api.ailin.one/v1/responses",
        headers={
            "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
            "Content-Type": "application/json",
        },
        json=payload,
    )
    if response.status_code not in (429, 503) or attempt == 3:
        print(response.status_code, response.text)
        break
    retry_after = int(response.headers.get("Retry-After", "1"))
    time.sleep(retry_after)
```
