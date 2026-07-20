<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Use Case: Enterprise Governance

## Scenario

Apply governance controls: organization scope, quotas, and audit headers.

```bash
curl -X GET https://api.ailin.one/v1/enterprise/quotas/current \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-Organization-Id: $AILIN_ORG_ID"
```

```ts
const quotas = await fetch("https://api.ailin.one/v1/enterprise/quotas/current", {
  method: "GET",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-Organization-Id": process.env.AILIN_ORG_ID || "",
  },
});
console.log(await quotas.json());
```

```python
import os
import requests

resp = requests.get(
    "https://api.ailin.one/v1/enterprise/quotas/current",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-Organization-Id": os.environ.get("AILIN_ORG_ID", ""),
    },
)
print(resp.status_code, resp.text)
```

Expected controls:

- tenant and organization boundary enforcement
- quota checks before expensive execution
- request/correlation ID traceability in logs
