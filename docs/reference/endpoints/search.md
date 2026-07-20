<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Search Endpoints

Total operations: 2

## POST `/v1/grounding/extract`

### Purpose

Extract content from URLs.

Extracts and processes content from provided URLs for grounding/RAG purposes.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "urls": [
    "string"
  ],
  "include_images": false
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Content extracted successfully |
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
curl -X POST "https://api.ailin.one/v1/grounding/extract" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["string"],"include_images":false}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/grounding/extract", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "urls": [
    "string"
  ],
  "include_images": false
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/grounding/extract",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "urls": [
        "string"
    ],
    "include_images": false
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/search`

### Purpose

Web search with AI grounding.

Performs web search using multi-provider orchestration (Tavily, models with web_search capability like Perplexity, Google Search Grounding, etc.). Automatically selects the best search provider/model based on query type and depth requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "query": "string",
  "model": "auto",
  "search_depth": "basic",
  "max_results": 10,
  "include_images": false,
  "include_answer": true,
  "include_raw_content": false,
  "include_domains": [
    "string"
  ],
  "exclude_domains": [
    "string"
  ],
  "topic": "general"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Search completed successfully |
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
curl -X POST "https://api.ailin.one/v1/search" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"string","model":"auto","search_depth":"basic","max_results":10,"include_images":false,"include_answer":true,"include_raw_content":false,"include_domains":["string"],"exclude_domains":["string"],"topic":"general"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/search", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "query": "string",
  "model": "auto",
  "search_depth": "basic",
  "max_results": 10,
  "include_images": false,
  "include_answer": true,
  "include_raw_content": false,
  "include_domains": [
    "string"
  ],
  "exclude_domains": [
    "string"
  ],
  "topic": "general"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/search",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "query": "string",
    "model": "auto",
    "search_depth": "basic",
    "max_results": 10,
    "include_images": false,
    "include_answer": true,
    "include_raw_content": false,
    "include_domains": [
        "string"
    ],
    "exclude_domains": [
        "string"
    ],
    "topic": "general"
},
)
print(response.status_code)
print(response.text)
```

