<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Authentication Endpoints

Total operations: 11

## GET `/.well-known/jwks.json`

### Purpose

Retrieve JWKS public keys.

Returns public JSON Web Keys used to validate signed JWTs. This endpoint is public and cache-friendly.

### Authentication

Public (no authentication required).

### Parameters

This operation does not declare explicit parameters.

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | JWKS retrieved successfully. |
| `400` | #/components/responses/BadRequest |
| `401` | #/components/responses/Unauthorized |
| `403` | #/components/responses/Forbidden |
| `404` | #/components/responses/NotFound |
| `409` | #/components/responses/Conflict |
| `422` | #/components/responses/UnprocessableEntity |
| `429` | #/components/responses/TooManyRequests |
| `500` | #/components/responses/InternalServerError |
| `503` | JWKS service unavailable. |

### Error Handling

Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.

### Rate Limits

Subject to tenant-level quota and platform-level rate-limit policies.

### Observability

Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.

### Examples

```bash
curl -X GET "https://api.ailin.one/.well-known/jwks.json" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/.well-known/jwks.json", {
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
    "https://api.ailin.one/.well-known/jwks.json",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/auth/api-keys`

### Purpose

Retrieve auth api keys.

Retrieve auth api keys.

Enterprise contract notes:
- Purpose: exposes /v1/auth/api-keys as a governed API capability inside the CI Fabric.
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
curl -X GET "https://api.ailin.one/v1/auth/api-keys" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/api-keys", {
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
    "https://api.ailin.one/v1/auth/api-keys",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/api-keys`

### Purpose

Create or execute auth api keys.

Create or execute auth api keys.

Enterprise contract notes:
- Purpose: exposes /v1/auth/api-keys as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/api-keys" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/api-keys", {
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
    "https://api.ailin.one/v1/auth/api-keys",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/auth/api-keys/{id}`

### Purpose

Delete auth api keys id.

Delete auth api keys id.

Enterprise contract notes:
- Purpose: exposes /v1/auth/api-keys/{id} as a governed API capability inside the CI Fabric.
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
| `id` | path | yes | string | - |

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
curl -X DELETE "https://api.ailin.one/v1/auth/api-keys/:id" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/api-keys/:id", {
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
    "https://api.ailin.one/v1/auth/api-keys/:id",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/challenge`

### Purpose

Create or execute auth challenge.

Create or execute auth challenge.

Enterprise contract notes:
- Purpose: exposes /v1/auth/challenge as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/challenge" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/challenge", {
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
    "https://api.ailin.one/v1/auth/challenge",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/email-challenge`

### Purpose

Create or execute auth email challenge.

Create or execute auth email challenge.

Enterprise contract notes:
- Purpose: exposes /v1/auth/email-challenge as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/email-challenge" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/email-challenge", {
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
    "https://api.ailin.one/v1/auth/email-challenge",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/login`

### Purpose

Create or execute auth login.

Create or execute auth login.

Enterprise contract notes:
- Purpose: exposes /v1/auth/login as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/login" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/login", {
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
    "https://api.ailin.one/v1/auth/login",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/login-with-code`

### Purpose

Create or execute auth login with code.

Create or execute auth login with code.

Enterprise contract notes:
- Purpose: exposes /v1/auth/login-with-code as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/login-with-code" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/login-with-code", {
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
    "https://api.ailin.one/v1/auth/login-with-code",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/logout`

### Purpose

Create or execute auth logout.

Create or execute auth logout.

Enterprise contract notes:
- Purpose: exposes /v1/auth/logout as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/logout" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/logout", {
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
    "https://api.ailin.one/v1/auth/logout",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/refresh`

### Purpose

Create or execute auth refresh.

Create or execute auth refresh.

Enterprise contract notes:
- Purpose: exposes /v1/auth/refresh as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/refresh" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/refresh", {
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
    "https://api.ailin.one/v1/auth/refresh",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/auth/register`

### Purpose

Create or execute auth register.

Create or execute auth register.

Enterprise contract notes:
- Purpose: exposes /v1/auth/register as a governed API capability inside the CI Fabric.
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
curl -X POST "https://api.ailin.one/v1/auth/register" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/auth/register", {
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
    "https://api.ailin.one/v1/auth/register",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

