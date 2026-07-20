<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Tools - Task Management Endpoints

Total operations: 4

## POST `/v1/tools/todos/check`

### Purpose

Mark task as completed.

Mark a task as completed. This is a convenience endpoint that updates task status to "completed".

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "id": "string",
  "working_directory": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Task marked as completed successfully |
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
curl -X POST "https://api.ailin.one/v1/tools/todos/check" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"string","working_directory":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/todos/check", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "id": "string",
  "working_directory": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/todos/check",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "id": "string",
    "working_directory": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/todos/create`

### Purpose

Create workspace task.

Create a new task in the workspace task management system. Tasks can be tracked, prioritized, and managed throughout development.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "content": "string",
  "priority": "low",
  "due_date": "2026-01-01T00:00:00Z",
  "working_directory": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Task created successfully |
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
curl -X POST "https://api.ailin.one/v1/tools/todos/create" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"string","priority":"low","due_date":"2026-01-01T00:00:00Z","working_directory":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/todos/create", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "content": "string",
  "priority": "low",
  "due_date": "2026-01-01T00:00:00Z",
  "working_directory": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/todos/create",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "content": "string",
    "priority": "low",
    "due_date": "2026-01-01T00:00:00Z",
    "working_directory": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/todos/list`

### Purpose

List workspace tasks.

List all tasks in the workspace. Supports filtering by status and priority.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "status": "pending",
  "priority": "low",
  "working_directory": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Tasks listed successfully |
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
curl -X POST "https://api.ailin.one/v1/tools/todos/list" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"pending","priority":"low","working_directory":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/todos/list", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "status": "pending",
  "priority": "low",
  "working_directory": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/todos/list",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "status": "pending",
    "priority": "low",
    "working_directory": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/todos/update`

### Purpose

Update workspace task.

Update an existing task. Can modify content, status, priority, or other task properties.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "id": "string",
  "content": "string",
  "status": "pending",
  "priority": "low",
  "working_directory": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Task updated successfully |
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
curl -X POST "https://api.ailin.one/v1/tools/todos/update" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"string","content":"string","status":"pending","priority":"low","working_directory":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/todos/update", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "id": "string",
  "content": "string",
  "status": "pending",
  "priority": "low",
  "working_directory": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/todos/update",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "id": "string",
    "content": "string",
    "status": "pending",
    "priority": "low",
    "working_directory": "string"
},
)
print(response.status_code)
print(response.text)
```

