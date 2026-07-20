<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Codebase Endpoints

Total operations: 6

## POST `/v1/codebase/analysis/sync`

### Purpose

Sync code analysis results (symbols, dependencies).

Receives parsed symbols and dependencies from CLI Tree-sitter analysis

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "projectId": "string",
  "branch": "string",
  "commitSha": "string",
  "isIncremental": true,
  "previousChecksum": "string",
  "files": [
    {
      "filePath": "string",
      "checksum": "string",
      "lineCount": 1,
      "symbols": [
        {}
      ],
      "dependencies": [
        {}
      ]
    }
  ]
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Default Response |
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
curl -X POST "https://api.ailin.one/v1/codebase/analysis/sync" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"string","branch":"string","commitSha":"string","isIncremental":true,"previousChecksum":"string","files":[{"filePath":"string","checksum":"string","lineCount":1,"symbols":[{}],"dependencies":[{}]}]}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/codebase/analysis/sync", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "projectId": "string",
  "branch": "string",
  "commitSha": "string",
  "isIncremental": true,
  "previousChecksum": "string",
  "files": [
    {
      "filePath": "string",
      "checksum": "string",
      "lineCount": 1,
      "symbols": [
        {}
      ],
      "dependencies": [
        {}
      ]
    }
  ]
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/codebase/analysis/sync",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "projectId": "string",
    "branch": "string",
    "commitSha": "string",
    "isIncremental": true,
    "previousChecksum": "string",
    "files": [
        {
            "filePath": "string",
            "checksum": "string",
            "lineCount": 1,
            "symbols": [
                {}
            ],
            "dependencies": [
                {}
            ]
        }
    ]
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/codebase/files/symbols`

### Purpose

Get symbols for a specific file.

Get symbols for a specific file. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `projectId` | query | yes | string | - |
| `filePath` | query | yes | string | - |
| `branch` | query | no | string | - |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Default Response |
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
curl -X GET "https://api.ailin.one/v1/codebase/files/symbols" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/codebase/files/symbols", {
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
    "https://api.ailin.one/v1/codebase/files/symbols",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/codebase/search/semantic`

### Purpose

Semantic search across codebase.

Search symbols, content, and dependencies with semantic understanding

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "projectId": "string",
  "branch": "string",
  "query": "string",
  "limit": 1,
  "includeSymbols": true,
  "includeContent": true,
  "symbolTypes": [
    "string"
  ]
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Default Response |
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
curl -X POST "https://api.ailin.one/v1/codebase/search/semantic" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"string","branch":"string","query":"string","limit":1,"includeSymbols":true,"includeContent":true,"symbolTypes":["string"]}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/codebase/search/semantic", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "projectId": "string",
  "branch": "string",
  "query": "string",
  "limit": 1,
  "includeSymbols": true,
  "includeContent": true,
  "symbolTypes": [
    "string"
  ]
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/codebase/search/semantic",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "projectId": "string",
    "branch": "string",
    "query": "string",
    "limit": 1,
    "includeSymbols": true,
    "includeContent": true,
    "symbolTypes": [
        "string"
    ]
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/codebase/symbols/references`

### Purpose

Find all references to a symbol.

Find all references to a symbol. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `projectId` | query | yes | string | - |
| `symbolName` | query | yes | string | - |
| `symbolType` | query | no | string | - |
| `branch` | query | no | string | - |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Default Response |
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
curl -X GET "https://api.ailin.one/v1/codebase/symbols/references" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/codebase/symbols/references", {
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
    "https://api.ailin.one/v1/codebase/symbols/references",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/codebase/sync`

### Purpose

Synchronize codebase chunk.

Synchronize codebase chunk. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "projectId": "string",
  "rootPath": "string",
  "branch": "string",
  "commitSha": "string",
  "sequence": 1,
  "totalSequences": 1,
  "isFinalChunk": true,
  "files": [
    {
      "path": "string",
      "size": 1,
      "checksum": "string",
      "lastModified": 1,
      "language": "string",
      "content": "string",
      "encoding": "utf-8",
      "executable": true
    }
  ]
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Default Response |
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
curl -X POST "https://api.ailin.one/v1/codebase/sync" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"string","rootPath":"string","branch":"string","commitSha":"string","sequence":1,"totalSequences":1,"isFinalChunk":true,"files":[{"path":"string","size":1,"checksum":"string","lastModified":1,"language":"string","content":"string","encoding":"utf-8","executable":true}]}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/codebase/sync", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "projectId": "string",
  "rootPath": "string",
  "branch": "string",
  "commitSha": "string",
  "sequence": 1,
  "totalSequences": 1,
  "isFinalChunk": true,
  "files": [
    {
      "path": "string",
      "size": 1,
      "checksum": "string",
      "lastModified": 1,
      "language": "string",
      "content": "string",
      "encoding": "utf-8",
      "executable": true
    }
  ]
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/codebase/sync",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "projectId": "string",
    "rootPath": "string",
    "branch": "string",
    "commitSha": "string",
    "sequence": 1,
    "totalSequences": 1,
    "isFinalChunk": true,
    "files": [
        {
            "path": "string",
            "size": 1,
            "checksum": "string",
            "lastModified": 1,
            "language": "string",
            "content": "string",
            "encoding": "utf-8",
            "executable": true
        }
    ]
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/search/codebase`

### Purpose

Search codebase.

Search codebase. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "projectId": "string",
  "branch": "string",
  "query": "string",
  "limit": 1,
  "fileTypes": [
    "string"
  ],
  "includeContext": true
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Default Response |
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
curl -X POST "https://api.ailin.one/v1/search/codebase" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"string","branch":"string","query":"string","limit":1,"fileTypes":["string"],"includeContext":true}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/search/codebase", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "projectId": "string",
  "branch": "string",
  "query": "string",
  "limit": 1,
  "fileTypes": [
    "string"
  ],
  "includeContext": true
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/search/codebase",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "projectId": "string",
    "branch": "string",
    "query": "string",
    "limit": 1,
    "fileTypes": [
        "string"
    ],
    "includeContext": true
},
)
print(response.status_code)
print(response.text)
```

