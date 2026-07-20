<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Files Endpoints

Total operations: 5

## GET `/v1/files`

### Purpose

List files.

Returns a paginated list of files that belong to the user's organization. Supports filtering by purpose and cursor-based pagination. Use this endpoint to browse uploaded files for fine-tuning, assistants, batch processing, or vision tasks.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `purpose` | query | no | string | Filter files by purpose (e.g., "assistants", "fine-tune", "batch") |
| `limit` | query | no | integer | Number of files to return (1-100, default: 20) |
| `after` | query | no | string | Cursor for pagination (after this file ID) |
| `before` | query | no | string | Cursor for pagination (before this file ID) |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Files listed successfully |
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
curl -X GET "https://api.ailin.one/v1/files" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/files", {
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
    "https://api.ailin.one/v1/files",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/files`

### Purpose

Upload file.

Uploads a file that can be used for various purposes (fine-tuning, assistants, vision, batch processing, etc.). Files are stored securely in GCS.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | File uploaded successfully |
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
curl -X POST "https://api.ailin.one/v1/files" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/files", {
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
    "https://api.ailin.one/v1/files",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/files/{file_id}`

### Purpose

Delete file.

Permanently delete a file from the system. This action cannot be undone. The file will be removed from all associated assistants and vector stores. File ID will no longer be valid after deletion.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `file_id` | path | yes | string | The ID of the file to delete |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | File deleted successfully |
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
curl -X DELETE "https://api.ailin.one/v1/files/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/files/sample", {
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
    "https://api.ailin.one/v1/files/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/files/{file_id}`

### Purpose

Retrieve file metadata.

Returns detailed information about a specific file, including size, purpose, processing status, and metadata. Use this endpoint to check file upload status and retrieve file details before using it with assistants or fine-tuning jobs.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `file_id` | path | yes | string | The ID of the file to retrieve |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | File metadata retrieved successfully |
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
curl -X GET "https://api.ailin.one/v1/files/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/files/sample", {
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
    "https://api.ailin.one/v1/files/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/files/{file_id}/content`

### Purpose

Retrieve file content.

Downloads and returns the binary content of a specific file. The response includes appropriate Content-Type and Content-Disposition headers for file download. Use this endpoint to retrieve the actual file data after uploading.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `file_id` | path | yes | string | The ID of the file to retrieve content from |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | File content retrieved successfully (returns binary content with appropriate Content-Type header) |
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
curl -X GET "https://api.ailin.one/v1/files/sample/content" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/files/sample/content", {
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
    "https://api.ailin.one/v1/files/sample/content",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

