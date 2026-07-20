<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Organization Endpoints

Total operations: 1

## PATCH `/v1/organization/settings`

### Purpose

Update organization settings.

Update organization settings (admin only)

### Authentication

Requires: Bearer token.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "name": "string",
  "settings": {}
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Organization settings updated successfully |
| `400` | #/components/responses/BadRequest |
| `401` | #/components/responses/Unauthorized |
| `403` | #/components/responses/Forbidden |
| `404` | #/components/responses/NotFound |
| `409` | #/components/responses/Conflict |
| `422` | #/components/responses/UnprocessableEntity |
| `429` | #/components/responses/TooManyRequests |
| `500` | #/components/responses/InternalServerError |

### Error Handling

Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.

### Rate Limits

Subject to tenant-level quota and platform-level rate-limit policies.

### Observability

Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.

### Examples

```bash
curl -X PATCH "https://api.ailin.one/v1/organization/settings" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"string","settings":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/organization/settings", {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "name": "string",
  "settings": {}
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "PATCH",
    "https://api.ailin.one/v1/organization/settings",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "name": "string",
    "settings": {}
},
)
print(response.status_code)
print(response.text)
```

