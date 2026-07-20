<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Simulation: Local Smoke

Run minimal local smoke checks against key endpoints.

```bash
curl https://api.ailin.one/v1/status/health
curl -H "Authorization: Bearer $AILIN_TOKEN" https://api.ailin.one/v1/models
```

```ts
const health = await fetch("https://api.ailin.one/v1/status/health");
const models = await fetch("https://api.ailin.one/v1/models", {
  headers: { Authorization: `Bearer ${process.env.AILIN_TOKEN}` },
});
console.log(health.status, models.status);
```

```python
import os
import requests

health = requests.get("https://api.ailin.one/v1/status/health")
models = requests.get(
    "https://api.ailin.one/v1/models",
    headers={"Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}"},
)
print(health.status_code, models.status_code)
```
