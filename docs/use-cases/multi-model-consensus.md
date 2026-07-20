<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Use Case: Multi-Model Consensus

## Scenario

Execute consensus strategy and inspect decision provenance.

```bash
curl -X POST https://api.ailin.one/v1/responses \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"ailin-consensus",
    "input":"Propose 3 migration risks and mitigations.",
    "strategy":"consensus",
    "quality_target":0.92
  }'
```

```ts
const result = await fetch("https://api.ailin.one/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "ailin-consensus",
    input: "Propose 3 migration risks and mitigations.",
    strategy: "consensus",
    quality_target: 0.92,
  }),
});
console.log(await result.json());
```

```python
import os
import requests

resp = requests.post(
    "https://api.ailin.one/v1/responses",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "Content-Type": "application/json",
    },
    json={
        "model": "ailin-consensus",
        "input": "Propose 3 migration risks and mitigations.",
        "strategy": "consensus",
        "quality_target": 0.92,
    },
)
print(resp.status_code, resp.text)
```
