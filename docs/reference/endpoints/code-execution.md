<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Code Execution Endpoints

Total operations: 1

## POST `/v1/code/execute`

### Purpose

Execute code in sandbox.

Executes code using models with code_interpreter capability (Gemini, etc.) with secure sandboxing. Automatically selects the best model based on language and requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "code": "string",
  "language": "javascript",
  "functionName": "string",
  "tests": [
    {
      "args": [
        {}
      ],
      "expected": {}
    }
  ],
  "timeoutMs": 30000
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Code executed successfully |
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
curl -X POST "https://api.ailin.one/v1/code/execute" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"string","language":"javascript","functionName":"string","tests":[{"args":[{}],"expected":{}}],"timeoutMs":30000}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/code/execute", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "code": "string",
  "language": "javascript",
  "functionName": "string",
  "tests": [
    {
      "args": [
        {}
      ],
      "expected": {}
    }
  ],
  "timeoutMs": 30000
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/code/execute",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "code": "string",
    "language": "javascript",
    "functionName": "string",
    "tests": [
        {
            "args": [
                {}
            ],
            "expected": {}
        }
    ],
    "timeoutMs": 30000
},
)
print(response.status_code)
print(response.text)
```

