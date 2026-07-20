<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Chat Endpoints

Total operations: 4

## POST `/v1/chat/completions`

### Purpose

Create a chat completion.

Create a chat completion with intelligent multi-model orchestration. Supports streaming and non-streaming modes. Automatically selects the best model based on requirements, cost, and quality targets.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "model": "string",
  "messages": [
    {
      "role": "system",
      "content": {},
      "name": "string",
      "tool_calls": [
        {}
      ],
      "tool_call_id": "string"
    }
  ],
  "temperature": 1,
  "max_tokens": 1,
  "top_p": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "stop": "string",
  "stream": false,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": {},
        "description": {},
        "parameters": {}
      }
    }
  ],
  "tool_choice": "none",
  "response_format": {
    "type": "json_object"
  },
  "strategy": "single",
  "max_cost": 1,
  "quality_target": 1,
  "task_type": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Successful completion |
| `202` | Request queued for asynchronous processing |
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
curl -X POST "https://api.ailin.one/v1/chat/completions" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"string","messages":[{"role":"system","content":{},"name":"string","tool_calls":[{}],"tool_call_id":"string"}],"temperature":1,"max_tokens":1,"top_p":1,"frequency_penalty":0,"presence_penalty":0,"stop":"string","stream":false,"tools":[{"type":"function","function":{"name":{},"description":{},"parameters":{}}}],"tool_choice":"none","response_format":{"type":"json_object"},"strategy":"single","max_cost":1,"quality_target":1,"task_type":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "model": "string",
  "messages": [
    {
      "role": "system",
      "content": {},
      "name": "string",
      "tool_calls": [
        {}
      ],
      "tool_call_id": "string"
    }
  ],
  "temperature": 1,
  "max_tokens": 1,
  "top_p": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "stop": "string",
  "stream": false,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": {},
        "description": {},
        "parameters": {}
      }
    }
  ],
  "tool_choice": "none",
  "response_format": {
    "type": "json_object"
  },
  "strategy": "single",
  "max_cost": 1,
  "quality_target": 1,
  "task_type": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "model": "string",
    "messages": [
        {
            "role": "system",
            "content": {},
            "name": "string",
            "tool_calls": [
                {}
            ],
            "tool_call_id": "string"
        }
    ],
    "temperature": 1,
    "max_tokens": 1,
    "top_p": 1,
    "frequency_penalty": 0,
    "presence_penalty": 0,
    "stop": "string",
    "stream": false,
    "tools": [
        {
            "type": "function",
            "function": {
                "name": {},
                "description": {},
                "parameters": {}
            }
        }
    ],
    "tool_choice": "none",
    "response_format": {
        "type": "json_object"
    },
    "strategy": "single",
    "max_cost": 1,
    "quality_target": 1,
    "task_type": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/chat/completions/extended-thinking`

### Purpose

Create or execute chat completions extended thinking.

Create or execute chat completions extended thinking.

Enterprise contract notes:
- Purpose: exposes /v1/chat/completions/extended-thinking as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Successful operation. |
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
curl -X POST "https://api.ailin.one/v1/chat/completions/extended-thinking" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/chat/completions/extended-thinking", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
  },
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/chat/completions/extended-thinking",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/chat/completions/intelligent`

### Purpose

Create chat completion with intelligent selection.

Chat completion with intelligent model selection, triage, and unlimited fallback. Uses advanced AI to analyze requirements and automatically select the best model, with automatic failover to alternative models if needed.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "model": "string",
  "messages": [
    {
      "role": "system",
      "content": {},
      "name": "string",
      "tool_calls": [
        {}
      ],
      "tool_call_id": "string"
    }
  ],
  "temperature": 1,
  "max_tokens": 1,
  "top_p": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "stop": "string",
  "stream": false,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": {},
        "description": {},
        "parameters": {}
      }
    }
  ],
  "tool_choice": "none",
  "response_format": {
    "type": "json_object"
  },
  "strategy": "single",
  "max_cost": 1,
  "quality_target": 1,
  "task_type": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Chat completion completed successfully |
| `202` | Request queued for asynchronous processing |
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
curl -X POST "https://api.ailin.one/v1/chat/completions/intelligent" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"string","messages":[{"role":"system","content":{},"name":"string","tool_calls":[{}],"tool_call_id":"string"}],"temperature":1,"max_tokens":1,"top_p":1,"frequency_penalty":0,"presence_penalty":0,"stop":"string","stream":false,"tools":[{"type":"function","function":{"name":{},"description":{},"parameters":{}}}],"tool_choice":"none","response_format":{"type":"json_object"},"strategy":"single","max_cost":1,"quality_target":1,"task_type":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/chat/completions/intelligent", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "model": "string",
  "messages": [
    {
      "role": "system",
      "content": {},
      "name": "string",
      "tool_calls": [
        {}
      ],
      "tool_call_id": "string"
    }
  ],
  "temperature": 1,
  "max_tokens": 1,
  "top_p": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "stop": "string",
  "stream": false,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": {},
        "description": {},
        "parameters": {}
      }
    }
  ],
  "tool_choice": "none",
  "response_format": {
    "type": "json_object"
  },
  "strategy": "single",
  "max_cost": 1,
  "quality_target": 1,
  "task_type": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/chat/completions/intelligent",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "model": "string",
    "messages": [
        {
            "role": "system",
            "content": {},
            "name": "string",
            "tool_calls": [
                {}
            ],
            "tool_call_id": "string"
        }
    ],
    "temperature": 1,
    "max_tokens": 1,
    "top_p": 1,
    "frequency_penalty": 0,
    "presence_penalty": 0,
    "stop": "string",
    "stream": false,
    "tools": [
        {
            "type": "function",
            "function": {
                "name": {},
                "description": {},
                "parameters": {}
            }
        }
    ],
    "tool_choice": "none",
    "response_format": {
        "type": "json_object"
    },
    "strategy": "single",
    "max_cost": 1,
    "quality_target": 1,
    "task_type": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/chat/completions/ultra-thinking`

### Purpose

Create or execute chat completions ultra thinking.

Create or execute chat completions ultra thinking.

Enterprise contract notes:
- Purpose: exposes /v1/chat/completions/ultra-thinking as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Successful operation. |
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
curl -X POST "https://api.ailin.one/v1/chat/completions/ultra-thinking" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/chat/completions/ultra-thinking", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
  },
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/chat/completions/ultra-thinking",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

