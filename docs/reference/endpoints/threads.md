<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Threads Endpoints

Total operations: 16

## POST `/v1/threads`

### Purpose

Create thread.

Create a new conversation thread. Threads represent conversations between a user and an assistant.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "messages": [
    {
      "role": "user",
      "content": {},
      "file_ids": [
        {}
      ],
      "metadata": {},
      "tool_call_id": "string",
      "name": "string"
    }
  ],
  "metadata": {}
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Thread created successfully |
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
curl -X POST "https://api.ailin.one/v1/threads" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":{},"file_ids":[{}],"metadata":{},"tool_call_id":"string","name":"string"}],"metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "messages": [
    {
      "role": "user",
      "content": {},
      "file_ids": [
        {}
      ],
      "metadata": {},
      "tool_call_id": "string",
      "name": "string"
    }
  ],
  "metadata": {}
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/threads",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "messages": [
        {
            "role": "user",
            "content": {},
            "file_ids": [
                {}
            ],
            "metadata": {},
            "tool_call_id": "string",
            "name": "string"
        }
    ],
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/threads/{thread_id}`

### Purpose

Delete thread.

Permanently delete a conversation thread. This action cannot be undone. All messages, runs, and associated data will be removed. The thread ID will no longer be valid after deletion.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread to delete |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Thread deleted successfully |
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
curl -X DELETE "https://api.ailin.one/v1/threads/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample", {
  method: "DELETE",
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
    "DELETE",
    "https://api.ailin.one/v1/threads/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/threads/{thread_id}`

### Purpose

Retrieve thread.

Retrieve a specific conversation thread by ID. Returns complete thread information including all messages, metadata, and current state. Threads are used for maintaining conversation context across multiple interactions with assistants.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread to retrieve |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Thread retrieved successfully |
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
curl -X GET "https://api.ailin.one/v1/threads/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample", {
  method: "GET",
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
    "GET",
    "https://api.ailin.one/v1/threads/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/threads/{thread_id}`

### Purpose

Modify thread.

Updates the metadata of an existing thread. Only the metadata object can be modified; messages, runs, and other thread content cannot be changed through this endpoint. Use this to update custom metadata for organization and tracking purposes.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread to modify |

### Request Body

```json
{
  "metadata": {}
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Thread modified successfully |
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
curl -X POST "https://api.ailin.one/v1/threads/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "metadata": {}
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/threads/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/threads/{thread_id}/messages`

### Purpose

List messages.

Retrieves a paginated list of messages from a thread. Supports cursor-based pagination using `after` and `before` parameters, and ordering with `order` parameter (asc/desc). Returns messages in chronological order by default, with detailed metadata for each message.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `limit` | query | no | integer | Number of messages to return (1-100, default: 20) |
| `order` | query | no | string | Sort order (default: desc) |
| `after` | query | no | string | Cursor for pagination (after this ID) |
| `before` | query | no | string | Cursor for pagination (before this ID) |
| `run_id` | query | no | string | Filter messages by run ID |
| `thread_id` | path | yes | string | The ID of the thread |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | List of messages |
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
curl -X GET "https://api.ailin.one/v1/threads/sample/messages" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/messages", {
  method: "GET",
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
    "GET",
    "https://api.ailin.one/v1/threads/sample/messages",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/threads/{thread_id}/messages`

### Purpose

Create message.

Creates a new message in an existing thread. Supports text content, images (via file IDs), tool call outputs, and attachments. Messages are automatically ordered chronologically and can be retrieved via the list messages endpoint.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |

### Request Body

```json
{
  "role": "user",
  "content": "string",
  "file_ids": [
    "string"
  ],
  "metadata": {},
  "tool_call_id": "string",
  "name": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Message created successfully |
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
curl -X POST "https://api.ailin.one/v1/threads/sample/messages" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","content":"string","file_ids":["string"],"metadata":{},"tool_call_id":"string","name":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/messages", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "role": "user",
  "content": "string",
  "file_ids": [
    "string"
  ],
  "metadata": {},
  "tool_call_id": "string",
  "name": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/threads/sample/messages",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "role": "user",
    "content": "string",
    "file_ids": [
        "string"
    ],
    "metadata": {},
    "tool_call_id": "string",
    "name": "string"
},
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/threads/{thread_id}/messages/{message_id}`

### Purpose

Delete message.

Permanently deletes a message from a thread. This action cannot be undone. The message ID will no longer be valid after deletion. Use this endpoint to remove unwanted messages from conversation threads.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |
| `message_id` | path | yes | string | The ID of the message to delete |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Message deleted successfully |
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
curl -X DELETE "https://api.ailin.one/v1/threads/sample/messages/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/messages/sample", {
  method: "DELETE",
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
    "DELETE",
    "https://api.ailin.one/v1/threads/sample/messages/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/threads/{thread_id}/messages/{message_id}`

### Purpose

Get message.

Retrieves detailed information about a specific message in a thread, including content, role, attachments, tool calls, and metadata. Use this endpoint to inspect individual messages and their associated data, such as file IDs or tool execution results.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |
| `message_id` | path | yes | string | The ID of the message to retrieve |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Message retrieved successfully |
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
curl -X GET "https://api.ailin.one/v1/threads/sample/messages/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/messages/sample", {
  method: "GET",
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
    "GET",
    "https://api.ailin.one/v1/threads/sample/messages/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/threads/{thread_id}/messages/{message_id}`

### Purpose

Modify message.

Updates the metadata of an existing message in a thread. Only the metadata object can be modified; message content, role, and other core properties cannot be changed. The provided metadata replaces all existing metadata. Use this endpoint to update custom metadata for organization, tagging, or tracking purposes without affecting the message content itself.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |
| `message_id` | path | yes | string | The ID of the message to modify |

### Request Body

```json
{
  "metadata": {}
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Message modified successfully |
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
curl -X POST "https://api.ailin.one/v1/threads/sample/messages/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/messages/sample", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "metadata": {}
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/threads/sample/messages/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/threads/{thread_id}/runs`

### Purpose

List runs.

Returns a list of runs belonging to a thread with pagination support

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `limit` | query | no | object | Number of runs to return (1-100, default: 20) |
| `order` | query | no | string | Sort order (default: desc) |
| `after` | query | no | string | Cursor for pagination (after this ID) |
| `before` | query | no | string | Cursor for pagination (before this ID) |
| `thread_id` | path | yes | string | The ID of the thread |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | List of runs |
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
curl -X GET "https://api.ailin.one/v1/threads/sample/runs" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/runs", {
  method: "GET",
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
    "GET",
    "https://api.ailin.one/v1/threads/sample/runs",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/threads/{thread_id}/runs`

### Purpose

Create run.

Creates a new run to execute an assistant on a thread. A run processes all messages in the thread and generates assistant responses, executing tools as needed. The run will execute asynchronously and can be monitored via the get run endpoint. Supports streaming for real-time updates.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |

### Request Body

```json
{
  "assistant_id": "string",
  "model": "string",
  "instructions": "string",
  "additional_instructions": "string",
  "tools": [
    {}
  ],
  "metadata": {},
  "temperature": 1,
  "top_p": 1,
  "stream": true
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Run created successfully |
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
curl -X POST "https://api.ailin.one/v1/threads/sample/runs" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"assistant_id":"string","model":"string","instructions":"string","additional_instructions":"string","tools":[{}],"metadata":{},"temperature":1,"top_p":1,"stream":true}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/runs", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "assistant_id": "string",
  "model": "string",
  "instructions": "string",
  "additional_instructions": "string",
  "tools": [
    {}
  ],
  "metadata": {},
  "temperature": 1,
  "top_p": 1,
  "stream": true
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/threads/sample/runs",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "assistant_id": "string",
    "model": "string",
    "instructions": "string",
    "additional_instructions": "string",
    "tools": [
        {}
    ],
    "metadata": {},
    "temperature": 1,
    "top_p": 1,
    "stream": true
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/threads/{thread_id}/runs/{run_id}`

### Purpose

Get run.

Retrieve a specific run by ID. Returns detailed run information including status, steps, tool calls, and execution results. Runs represent individual assistant execution instances within a thread.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |
| `run_id` | path | yes | string | The ID of the run to retrieve |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Run retrieved successfully |
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
curl -X GET "https://api.ailin.one/v1/threads/sample/runs/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/runs/sample", {
  method: "GET",
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
    "GET",
    "https://api.ailin.one/v1/threads/sample/runs/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/threads/{thread_id}/runs/{run_id}/cancel`

### Purpose

Cancel run.

Cancels an in-progress run. Only runs with status "in_progress" or "queued" can be cancelled. Once cancelled, the run status changes to "cancelling" (immediate) or "cancelled" (final). The run will stop processing and no further assistant responses will be generated. Use this endpoint to halt long-running runs or when user input is needed to proceed. This is useful for stopping expensive operations or when a user changes their mind about a request.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |
| `run_id` | path | yes | string | The ID of the run to cancel |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Run cancelled successfully |
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
curl -X POST "https://api.ailin.one/v1/threads/sample/runs/sample/cancel" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/runs/sample/cancel", {
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
    "https://api.ailin.one/v1/threads/sample/runs/sample/cancel",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/threads/{thread_id}/runs/{run_id}/steps`

### Purpose

List run steps.

Returns a paginated list of all steps executed within a run, ordered chronologically. Steps represent individual operations such as message creation or tool calls. Supports cursor-based pagination using `after` and `before` parameters, and ordering with `order` parameter. Use this endpoint to inspect the complete execution flow of a run and track each operation performed by the assistant.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `limit` | query | no | object | Number of steps to return (1-100, default: 20) |
| `order` | query | no | string | Sort order (default: desc) |
| `after` | query | no | string | Cursor for pagination (after this ID) |
| `before` | query | no | string | Cursor for pagination (before this ID) |
| `thread_id` | path | yes | string | The ID of the thread |
| `run_id` | path | yes | string | The ID of the run |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | List of run steps |
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
curl -X GET "https://api.ailin.one/v1/threads/sample/runs/sample/steps" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/runs/sample/steps", {
  method: "GET",
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
    "GET",
    "https://api.ailin.one/v1/threads/sample/runs/sample/steps",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/threads/{thread_id}/runs/{run_id}/steps/{step_id}`

### Purpose

Get run step.

Retrieves detailed information about a specific step within a run. Steps represent individual operations performed during run execution, such as message creation or tool call execution. Returns step type, status, execution details (tool calls, message creation), and any errors that occurred during step processing. Use this to inspect individual operations within a run.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |
| `run_id` | path | yes | string | The ID of the run |
| `step_id` | path | yes | string | The ID of the step to retrieve |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Run step retrieved successfully |
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
curl -X GET "https://api.ailin.one/v1/threads/sample/runs/sample/steps/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/runs/sample/steps/sample", {
  method: "GET",
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
    "GET",
    "https://api.ailin.one/v1/threads/sample/runs/sample/steps/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/threads/{thread_id}/runs/{run_id}/submit_tool_outputs`

### Purpose

Submit tool outputs.

Submits tool execution results for a run that is waiting for action (status "requires_action"). When an assistant uses function/tool calling during a run, the run pauses and requires tool outputs to continue. This endpoint allows providing those outputs to resume the run execution. Each tool_output must correspond to a tool_call_id from the run's required_action.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `thread_id` | path | yes | string | The ID of the thread |
| `run_id` | path | yes | string | The ID of the run |

### Request Body

```json
{
  "tool_outputs": [
    {
      "tool_call_id": "string",
      "output": "string",
      "error": "string"
    }
  ],
  "stream": true
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Tool outputs submitted successfully, run will continue |
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
curl -X POST "https://api.ailin.one/v1/threads/sample/runs/sample/submit_tool_outputs" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tool_outputs":[{"tool_call_id":"string","output":"string","error":"string"}],"stream":true}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/threads/sample/runs/sample/submit_tool_outputs", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "tool_outputs": [
    {
      "tool_call_id": "string",
      "output": "string",
      "error": "string"
    }
  ],
  "stream": true
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/threads/sample/runs/sample/submit_tool_outputs",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "tool_outputs": [
        {
            "tool_call_id": "string",
            "output": "string",
            "error": "string"
        }
    ],
    "stream": true
},
)
print(response.status_code)
print(response.text)
```

