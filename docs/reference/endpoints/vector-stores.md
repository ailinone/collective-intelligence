<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Vector Stores Endpoints

Total operations: 8

## GET `/v1/vector_stores`

### Purpose

List vector stores.

List all vector stores for the organization. Supports pagination using cursor-based navigation with `after` and `before` parameters.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `limit` | query | no | object | Maximum number of vector stores to return (1-100, default: 20) |
| `order` | query | no | string | Sort order: asc (oldest first) or desc (newest first, default) |
| `after` | query | no | string | Cursor for pagination. Return results after this vector store ID. |
| `before` | query | no | string | Cursor for pagination. Return results before this vector store ID. |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Vector stores listed successfully |
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
curl -X GET "https://api.ailin.one/v1/vector_stores" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores", {
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
    "https://api.ailin.one/v1/vector_stores",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/vector_stores`

### Purpose

Create vector store.

Create a new vector store for RAG (Retrieval-Augmented Generation). Vector stores enable efficient similarity search over large collections of documents for knowledge retrieval.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "name": "string",
  "file_ids": [
    "string"
  ],
  "expires_after": {
    "anchor": "last_active_at",
    "days": 1
  },
  "metadata": {}
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Vector store created successfully |
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
curl -X POST "https://api.ailin.one/v1/vector_stores" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"string","file_ids":["string"],"expires_after":{"anchor":"last_active_at","days":1},"metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "name": "string",
  "file_ids": [
    "string"
  ],
  "expires_after": {
    "anchor": "last_active_at",
    "days": 1
  },
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
    "https://api.ailin.one/v1/vector_stores",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "name": "string",
    "file_ids": [
        "string"
    ],
    "expires_after": {
        "anchor": "last_active_at",
        "days": 1
    },
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/vector_stores/{vector_store_id}`

### Purpose

Delete vector store.

Permanently delete a vector store and all associated files. This action cannot be undone. All embeddings and indexed data will be removed.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `vector_store_id` | path | yes | string | Unique identifier of the vector store to delete |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Vector store deleted successfully |
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
curl -X DELETE "https://api.ailin.one/v1/vector_stores/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores/sample", {
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
    "https://api.ailin.one/v1/vector_stores/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/vector_stores/{vector_store_id}`

### Purpose

Get vector store.

Retrieve a specific vector store by ID. Returns complete details including status, file counts, and expiration information.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `vector_store_id` | path | yes | string | Unique identifier of the vector store to retrieve |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Vector store retrieved successfully |
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
curl -X GET "https://api.ailin.one/v1/vector_stores/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores/sample", {
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
    "https://api.ailin.one/v1/vector_stores/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/vector_stores/{vector_store_id}`

### Purpose

Modify vector store.

Update an existing vector store. Can modify name, expiration settings, and metadata. Note: file associations cannot be modified through this endpoint; use file-specific endpoints.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `vector_store_id` | path | yes | string | Unique identifier of the vector store to modify |

### Request Body

```json
{
  "name": null,
  "expires_after": null,
  "metadata": {}
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Vector store modified successfully |
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
curl -X POST "https://api.ailin.one/v1/vector_stores/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":null,"expires_after":null,"metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores/sample", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "name": null,
  "expires_after": null,
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
    "https://api.ailin.one/v1/vector_stores/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "name": null,
    "expires_after": null,
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/vector_stores/{vector_store_id}/files`

### Purpose

List vector store files.

List all files associated with a vector store. Supports filtering by status and pagination using cursor-based navigation.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `limit` | query | no | object | Maximum number of files to return (1-100) |
| `order` | query | no | string | Sort order: asc (oldest first) or desc (newest first) |
| `after` | query | no | string | Cursor for pagination. Return results after this file ID. |
| `before` | query | no | string | Cursor for pagination. Return results before this file ID. |
| `filter` | query | no | string | Filter files by processing status |
| `vector_store_id` | path | yes | string | Unique identifier of the vector store |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Vector store files listed successfully |
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
curl -X GET "https://api.ailin.one/v1/vector_stores/sample/files" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores/sample/files", {
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
    "https://api.ailin.one/v1/vector_stores/sample/files",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/vector_stores/{vector_store_id}/files`

### Purpose

Create vector store file.

Associate a file with a vector store. The file will be processed and its embeddings will be added to the vector store for similarity search. Processing happens asynchronously.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `vector_store_id` | path | yes | string | Unique identifier of the vector store |

### Request Body

```json
{
  "file_id": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | File associated with vector store successfully |
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
curl -X POST "https://api.ailin.one/v1/vector_stores/sample/files" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"file_id":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores/sample/files", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "file_id": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/vector_stores/sample/files",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "file_id": "string"
},
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/vector_stores/{vector_store_id}/files/{file_id}`

### Purpose

Delete vector store file.

Remove a file association from a vector store. The file embeddings will be removed from the vector store, but the original file remains in the system.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `vector_store_id` | path | yes | string | Unique identifier of the vector store |
| `file_id` | path | yes | string | Unique identifier of the file to remove from the vector store |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | File removed from vector store successfully |
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
curl -X DELETE "https://api.ailin.one/v1/vector_stores/sample/files/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/vector_stores/sample/files/sample", {
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
    "https://api.ailin.one/v1/vector_stores/sample/files/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

