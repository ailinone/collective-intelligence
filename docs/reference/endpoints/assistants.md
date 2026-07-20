<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Assistants Endpoints

Total operations: 9

## GET `/v1/assistants`

### Purpose

Retrieve assistants.

Retrieve assistants.

Enterprise contract notes:
- Purpose: exposes /v1/assistants as a governed API capability inside the CI Fabric.
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
curl -X GET "https://api.ailin.one/v1/assistants" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants", {
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
    "https://api.ailin.one/v1/assistants",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/assistants`

### Purpose

Create or execute assistants.

Create or execute assistants.

Enterprise contract notes:
- Purpose: exposes /v1/assistants as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/assistants" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants", {
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
    "https://api.ailin.one/v1/assistants",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/assistants/{assistant_id}`

### Purpose

Delete assistants assistant id.

Delete assistants assistant id.

Enterprise contract notes:
- Purpose: exposes /v1/assistants/{assistant_id} as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `assistant_id` | path | yes | string | - |

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
curl -X DELETE "https://api.ailin.one/v1/assistants/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants/sample", {
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
    "https://api.ailin.one/v1/assistants/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/assistants/{assistant_id}`

### Purpose

Retrieve assistants assistant id.

Retrieve assistants assistant id.

Enterprise contract notes:
- Purpose: exposes /v1/assistants/{assistant_id} as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `assistant_id` | path | yes | string | - |

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
curl -X GET "https://api.ailin.one/v1/assistants/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants/sample", {
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
    "https://api.ailin.one/v1/assistants/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/assistants/{assistant_id}`

### Purpose

Create or execute assistants assistant id.

Create or execute assistants assistant id.

Enterprise contract notes:
- Purpose: exposes /v1/assistants/{assistant_id} as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `assistant_id` | path | yes | string | - |

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
curl -X POST "https://api.ailin.one/v1/assistants/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants/sample", {
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
    "https://api.ailin.one/v1/assistants/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/assistants/{assistant_id}/files`

### Purpose

Retrieve assistants assistant id files.

Retrieve assistants assistant id files.

Enterprise contract notes:
- Purpose: exposes /v1/assistants/{assistant_id}/files as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `assistant_id` | path | yes | string | - |

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
curl -X GET "https://api.ailin.one/v1/assistants/sample/files" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants/sample/files", {
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
    "https://api.ailin.one/v1/assistants/sample/files",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/assistants/{assistant_id}/files`

### Purpose

Create or execute assistants assistant id files.

Create or execute assistants assistant id files.

Enterprise contract notes:
- Purpose: exposes /v1/assistants/{assistant_id}/files as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `assistant_id` | path | yes | string | - |

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
curl -X POST "https://api.ailin.one/v1/assistants/sample/files" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants/sample/files", {
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
    "https://api.ailin.one/v1/assistants/sample/files",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/assistants/{assistant_id}/files/{file_id}`

### Purpose

Delete assistants assistant id files file id.

Delete assistants assistant id files file id.

Enterprise contract notes:
- Purpose: exposes /v1/assistants/{assistant_id}/files/{file_id} as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `assistant_id` | path | yes | string | - |
| `file_id` | path | yes | string | - |

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
curl -X DELETE "https://api.ailin.one/v1/assistants/sample/files/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants/sample/files/sample", {
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
    "https://api.ailin.one/v1/assistants/sample/files/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/assistants/{assistant_id}/files/{file_id}`

### Purpose

Retrieve assistants assistant id files file id.

Retrieve assistants assistant id files file id.

Enterprise contract notes:
- Purpose: exposes /v1/assistants/{assistant_id}/files/{file_id} as a governed API capability inside the CI Fabric.
- Preconditions: requires valid authentication unless explicitly marked as public.
- Side-effects: may emit telemetry/audit signals and mutate artifacts depending on method semantics.
- Limits: subject to tenant quotas, payload constraints, and rate-limit policies.
- Observability: request and correlation identifiers are propagated for traceability.
- Security and privacy: tenant isolation, policy enforcement, retention, and redaction controls apply.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `assistant_id` | path | yes | string | - |
| `file_id` | path | yes | string | - |

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
curl -X GET "https://api.ailin.one/v1/assistants/sample/files/sample" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/assistants/sample/files/sample", {
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
    "https://api.ailin.one/v1/assistants/sample/files/sample",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

