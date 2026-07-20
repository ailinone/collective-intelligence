<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Fine-tuning Endpoints

Total operations: 7

## GET `/fine_tuning/jobs`

### Purpose

List fine-tuning jobs.

Enterprise contract notes:
- Purpose: exposes /fine_tuning/jobs as a governed API capability inside the CI Fabric.
- Preconditions: Requires valid bearer or API key credentials scoped to the target tenant and permitted resource domain.
- Side-effects: Read-oriented operation with no intended resource mutation beyond telemetry and audit traces.
- Consistency and idempotency: Operation is expected to be idempotent when repeated with the same inputs and resource version.
- Limits: subject to tenant quotas, payload limits, and rate limiting controls.
- Observability: request and correlation identifiers are propagated for tracing and forensic analysis.
- Security and privacy: data handling follows tenant isolation, policy enforcement, retention, and redaction requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | List of fine-tuning jobs |
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
curl -X GET "https://api.ailin.one/fine_tuning/jobs" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/fine_tuning/jobs", {
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
    "https://api.ailin.one/fine_tuning/jobs",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/fine_tuning/jobs`

### Purpose

Create fine-tuning job.

Enterprise contract notes:
- Purpose: exposes /fine_tuning/jobs as a governed API capability inside the CI Fabric.
- Preconditions: Requires valid bearer or API key credentials scoped to the target tenant and permitted resource domain.
- Side-effects: May mutate persisted artifacts, queue asynchronous work, and emit audit and telemetry records.
- Consistency and idempotency: Idempotency depends on client-supplied identifiers and server policy; retries should include stable request identifiers when supported.
- Limits: subject to tenant quotas, payload limits, and rate limiting controls.
- Observability: request and correlation identifiers are propagated for tracing and forensic analysis.
- Security and privacy: data handling follows tenant isolation, policy enforcement, retention, and redaction requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "training_file": "string",
  "model": "string",
  "hyperparameters": {}
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Fine-tuning job created |
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
curl -X POST "https://api.ailin.one/fine_tuning/jobs" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"training_file":"string","model":"string","hyperparameters":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/fine_tuning/jobs", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "training_file": "string",
  "model": "string",
  "hyperparameters": {}
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/fine_tuning/jobs",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "training_file": "string",
    "model": "string",
    "hyperparameters": {}
},
)
print(response.status_code)
print(response.text)
```

## DELETE `/fine_tuning/jobs/{job_id}`

### Purpose

Delete fine-tuning job.

Enterprise contract notes:
- Purpose: exposes /fine_tuning/jobs/{job_id} as a governed API capability inside the CI Fabric.
- Preconditions: Requires valid bearer or API key credentials scoped to the target tenant and permitted resource domain.
- Side-effects: May mutate persisted artifacts, queue asynchronous work, and emit audit and telemetry records.
- Consistency and idempotency: Operation is expected to be idempotent when repeated with the same inputs and resource version.
- Limits: subject to tenant quotas, payload limits, and rate limiting controls.
- Observability: request and correlation identifiers are propagated for tracing and forensic analysis.
- Security and privacy: data handling follows tenant isolation, policy enforcement, retention, and redaction requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `job_id` | path | yes | string | - |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Job deleted |
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
curl -X DELETE "https://api.ailin.one/fine_tuning/jobs/:job_id" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/fine_tuning/jobs/:job_id", {
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
    "https://api.ailin.one/fine_tuning/jobs/:job_id",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/fine_tuning/jobs/{job_id}`

### Purpose

Retrieve fine-tuning job.

Enterprise contract notes:
- Purpose: exposes /fine_tuning/jobs/{job_id} as a governed API capability inside the CI Fabric.
- Preconditions: Requires valid bearer or API key credentials scoped to the target tenant and permitted resource domain.
- Side-effects: Read-oriented operation with no intended resource mutation beyond telemetry and audit traces.
- Consistency and idempotency: Operation is expected to be idempotent when repeated with the same inputs and resource version.
- Limits: subject to tenant quotas, payload limits, and rate limiting controls.
- Observability: request and correlation identifiers are propagated for tracing and forensic analysis.
- Security and privacy: data handling follows tenant isolation, policy enforcement, retention, and redaction requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `job_id` | path | yes | string | - |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Fine-tuning job details |
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
curl -X GET "https://api.ailin.one/fine_tuning/jobs/:job_id" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/fine_tuning/jobs/:job_id", {
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
    "https://api.ailin.one/fine_tuning/jobs/:job_id",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/fine_tuning/jobs/{job_id}/cancel`

### Purpose

Cancel fine-tuning job.

Enterprise contract notes:
- Purpose: exposes /fine_tuning/jobs/{job_id}/cancel as a governed API capability inside the CI Fabric.
- Preconditions: Requires valid bearer or API key credentials scoped to the target tenant and permitted resource domain.
- Side-effects: May mutate persisted artifacts, queue asynchronous work, and emit audit and telemetry records.
- Consistency and idempotency: Idempotency depends on client-supplied identifiers and server policy; retries should include stable request identifiers when supported.
- Limits: subject to tenant quotas, payload limits, and rate limiting controls.
- Observability: request and correlation identifiers are propagated for tracing and forensic analysis.
- Security and privacy: data handling follows tenant isolation, policy enforcement, retention, and redaction requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `job_id` | path | yes | string | - |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | Job cancelled |
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
curl -X POST "https://api.ailin.one/fine_tuning/jobs/:job_id/cancel" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/fine_tuning/jobs/:job_id/cancel", {
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
    "https://api.ailin.one/fine_tuning/jobs/:job_id/cancel",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/fine_tuning/jobs/{job_id}/checkpoints`

### Purpose

List fine-tuning checkpoints.

Enterprise contract notes:
- Purpose: exposes /fine_tuning/jobs/{job_id}/checkpoints as a governed API capability inside the CI Fabric.
- Preconditions: Requires valid bearer or API key credentials scoped to the target tenant and permitted resource domain.
- Side-effects: Read-oriented operation with no intended resource mutation beyond telemetry and audit traces.
- Consistency and idempotency: Operation is expected to be idempotent when repeated with the same inputs and resource version.
- Limits: subject to tenant quotas, payload limits, and rate limiting controls.
- Observability: request and correlation identifiers are propagated for tracing and forensic analysis.
- Security and privacy: data handling follows tenant isolation, policy enforcement, retention, and redaction requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `job_id` | path | yes | string | - |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | List of checkpoints |
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
curl -X GET "https://api.ailin.one/fine_tuning/jobs/:job_id/checkpoints" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/fine_tuning/jobs/:job_id/checkpoints", {
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
    "https://api.ailin.one/fine_tuning/jobs/:job_id/checkpoints",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/fine_tuning/jobs/{job_id}/events`

### Purpose

List fine-tuning events.

Enterprise contract notes:
- Purpose: exposes /fine_tuning/jobs/{job_id}/events as a governed API capability inside the CI Fabric.
- Preconditions: Requires valid bearer or API key credentials scoped to the target tenant and permitted resource domain.
- Side-effects: Read-oriented operation with no intended resource mutation beyond telemetry and audit traces.
- Consistency and idempotency: Operation is expected to be idempotent when repeated with the same inputs and resource version.
- Limits: subject to tenant quotas, payload limits, and rate limiting controls.
- Observability: request and correlation identifiers are propagated for tracing and forensic analysis.
- Security and privacy: data handling follows tenant isolation, policy enforcement, retention, and redaction requirements.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `job_id` | path | yes | string | - |

### Request Body

No JSON request body is required.

### Responses

| Status | Description |
|---|---|
| `200` | List of events |
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
curl -X GET "https://api.ailin.one/fine_tuning/jobs/:job_id/events" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/fine_tuning/jobs/:job_id/events", {
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
    "https://api.ailin.one/fine_tuning/jobs/:job_id/events",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

