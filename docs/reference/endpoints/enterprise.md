<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Enterprise Endpoints

Total operations: 22

## GET `/v1/enterprise/billing/config`

### Purpose

Get billing configuration.

Get billing configuration. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

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
curl -X GET "https://api.ailin.one/v1/enterprise/billing/config" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/config", {
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
    "https://api.ailin.one/v1/enterprise/billing/config",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## PUT `/v1/enterprise/billing/config`

### Purpose

Update billing configuration.

Update billing configuration. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "billingEmail": "user@example.com",
  "paymentMethod": "string",
  "defaultPaymentMethodId": "string",
  "autoPay": true,
  "taxRate": 1,
  "currency": "string",
  "metadata": {}
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
curl -X PUT "https://api.ailin.one/v1/enterprise/billing/config" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"billingEmail":"user@example.com","paymentMethod":"string","defaultPaymentMethodId":"string","autoPay":true,"taxRate":1,"currency":"string","metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/config", {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "billingEmail": "user@example.com",
  "paymentMethod": "string",
  "defaultPaymentMethodId": "string",
  "autoPay": true,
  "taxRate": 1,
  "currency": "string",
  "metadata": {}
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "PUT",
    "https://api.ailin.one/v1/enterprise/billing/config",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "billingEmail": "user@example.com",
    "paymentMethod": "string",
    "defaultPaymentMethodId": "string",
    "autoPay": true,
    "taxRate": 1,
    "currency": "string",
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/billing/invoices`

### Purpose

List invoices.

List invoices. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

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
curl -X GET "https://api.ailin.one/v1/enterprise/billing/invoices" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/invoices", {
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
    "https://api.ailin.one/v1/enterprise/billing/invoices",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/billing/invoices`

### Purpose

Create invoice.

Create invoice. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "organizationId": "string",
  "periodStart": 1,
  "periodEnd": 1,
  "costMetrics": {},
  "costEvents": [
    {}
  ],
  "items": [
    {
      "id": "string",
      "description": "string",
      "quantity": 1,
      "unitPrice": 1,
      "total": 1,
      "metadata": {}
    }
  ],
  "currency": "string",
  "metadata": {}
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
curl -X POST "https://api.ailin.one/v1/enterprise/billing/invoices" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"organizationId":"string","periodStart":1,"periodEnd":1,"costMetrics":{},"costEvents":[{}],"items":[{"id":"string","description":"string","quantity":1,"unitPrice":1,"total":1,"metadata":{}}],"currency":"string","metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/invoices", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "organizationId": "string",
  "periodStart": 1,
  "periodEnd": 1,
  "costMetrics": {},
  "costEvents": [
    {}
  ],
  "items": [
    {
      "id": "string",
      "description": "string",
      "quantity": 1,
      "unitPrice": 1,
      "total": 1,
      "metadata": {}
    }
  ],
  "currency": "string",
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
    "https://api.ailin.one/v1/enterprise/billing/invoices",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "organizationId": "string",
    "periodStart": 1,
    "periodEnd": 1,
    "costMetrics": {},
    "costEvents": [
        {}
    ],
    "items": [
        {
            "id": "string",
            "description": "string",
            "quantity": 1,
            "unitPrice": 1,
            "total": 1,
            "metadata": {}
        }
    ],
    "currency": "string",
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/billing/invoices/{invoiceId}`

### Purpose

Get invoice by ID.

Get invoice by ID. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `invoiceId` | path | yes | string | - |

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
curl -X GET "https://api.ailin.one/v1/enterprise/billing/invoices/:invoiceId" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/invoices/:invoiceId", {
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
    "https://api.ailin.one/v1/enterprise/billing/invoices/:invoiceId",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/billing/invoices/{invoiceId}/pay`

### Purpose

Mark invoice as paid.

Mark invoice as paid. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `invoiceId` | path | yes | string | - |

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
curl -X POST "https://api.ailin.one/v1/enterprise/billing/invoices/:invoiceId/pay" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/invoices/:invoiceId/pay", {
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
    "https://api.ailin.one/v1/enterprise/billing/invoices/:invoiceId/pay",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/billing/payment-methods`

### Purpose

List payment methods.

List payment methods. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

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
curl -X GET "https://api.ailin.one/v1/enterprise/billing/payment-methods" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/payment-methods", {
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
    "https://api.ailin.one/v1/enterprise/billing/payment-methods",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## DELETE `/v1/enterprise/billing/payment-methods/{paymentMethodId}`

### Purpose

Detach payment method.

Detach payment method. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `paymentMethodId` | path | yes | string | - |

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
curl -X DELETE "https://api.ailin.one/v1/enterprise/billing/payment-methods/:paymentMethodId" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/payment-methods/:paymentMethodId", {
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
    "https://api.ailin.one/v1/enterprise/billing/payment-methods/:paymentMethodId",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/billing/payment-methods/attach`

### Purpose

Attach payment method to organization.

Attach payment method to organization. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "paymentMethodId": "string",
  "setDefault": true
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
curl -X POST "https://api.ailin.one/v1/enterprise/billing/payment-methods/attach" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethodId":"string","setDefault":true}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/payment-methods/attach", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "paymentMethodId": "string",
  "setDefault": true
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/enterprise/billing/payment-methods/attach",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "paymentMethodId": "string",
    "setDefault": true
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/billing/payment-methods/setup-intent`

### Purpose

Create payment method setup intent.

Create payment method setup intent. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

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
curl -X POST "https://api.ailin.one/v1/enterprise/billing/payment-methods/setup-intent" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/payment-methods/setup-intent", {
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
    "https://api.ailin.one/v1/enterprise/billing/payment-methods/setup-intent",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/billing/plans`

### Purpose

List available billing plans.

List available billing plans. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `refresh` | query | no | string | - |

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
curl -X GET "https://api.ailin.one/v1/enterprise/billing/plans" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/plans", {
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
    "https://api.ailin.one/v1/enterprise/billing/plans",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/billing/subscriptions`

### Purpose

List subscriptions.

List subscriptions. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

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
curl -X GET "https://api.ailin.one/v1/enterprise/billing/subscriptions" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/subscriptions", {
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
    "https://api.ailin.one/v1/enterprise/billing/subscriptions",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/billing/subscriptions`

### Purpose

Create subscription.

Create subscription. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "organizationId": "string",
  "plan": "string",
  "billingCycle": "monthly",
  "amount": 1,
  "currency": "string",
  "paymentMethodId": "string",
  "priceId": "string",
  "trialDays": 1,
  "cancelAtPeriodEnd": true,
  "metadata": {}
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
curl -X POST "https://api.ailin.one/v1/enterprise/billing/subscriptions" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"organizationId":"string","plan":"string","billingCycle":"monthly","amount":1,"currency":"string","paymentMethodId":"string","priceId":"string","trialDays":1,"cancelAtPeriodEnd":true,"metadata":{}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/subscriptions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "organizationId": "string",
  "plan": "string",
  "billingCycle": "monthly",
  "amount": 1,
  "currency": "string",
  "paymentMethodId": "string",
  "priceId": "string",
  "trialDays": 1,
  "cancelAtPeriodEnd": true,
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
    "https://api.ailin.one/v1/enterprise/billing/subscriptions",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "organizationId": "string",
    "plan": "string",
    "billingCycle": "monthly",
    "amount": 1,
    "currency": "string",
    "paymentMethodId": "string",
    "priceId": "string",
    "trialDays": 1,
    "cancelAtPeriodEnd": true,
    "metadata": {}
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/billing/subscriptions/{subscriptionId}/cancel`

### Purpose

Cancel subscription.

Cancel subscription. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `subscriptionId` | path | yes | string | - |

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
curl -X POST "https://api.ailin.one/v1/enterprise/billing/subscriptions/:subscriptionId/cancel" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/billing/subscriptions/:subscriptionId/cancel", {
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
    "https://api.ailin.one/v1/enterprise/billing/subscriptions/:subscriptionId/cancel",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/quotas`

### Purpose

List usage quotas for the organization.

List usage quotas for the organization. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

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
curl -X GET "https://api.ailin.one/v1/enterprise/quotas" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/quotas", {
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
    "https://api.ailin.one/v1/enterprise/quotas",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/quotas`

### Purpose

Configure usage quotas.

Configure usage quotas. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "organizationId": "string",
  "limits": {
    "period": "minute",
    "maxRequests": 1,
    "maxTokens": 1,
    "maxCost": 1,
    "maxFiles": 1,
    "maxFileSize": 1
  }
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
curl -X POST "https://api.ailin.one/v1/enterprise/quotas" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"organizationId":"string","limits":{"period":"minute","maxRequests":1,"maxTokens":1,"maxCost":1,"maxFiles":1,"maxFileSize":1}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/quotas", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "organizationId": "string",
  "limits": {
    "period": "minute",
    "maxRequests": 1,
    "maxTokens": 1,
    "maxCost": 1,
    "maxFiles": 1,
    "maxFileSize": 1
  }
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/enterprise/quotas",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "organizationId": "string",
    "limits": {
        "period": "minute",
        "maxRequests": 1,
        "maxTokens": 1,
        "maxCost": 1,
        "maxFiles": 1,
        "maxFileSize": 1
    }
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/quotas/check`

### Purpose

Check if an operation fits within quota limits.

Check if an operation fits within quota limits. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "period": "minute",
  "operation": {
    "requests": 1,
    "tokens": 1,
    "cost": 1,
    "files": 1
  }
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
curl -X POST "https://api.ailin.one/v1/enterprise/quotas/check" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"period":"minute","operation":{"requests":1,"tokens":1,"cost":1,"files":1}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/quotas/check", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "period": "minute",
  "operation": {
    "requests": 1,
    "tokens": 1,
    "cost": 1,
    "files": 1
  }
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/enterprise/quotas/check",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "period": "minute",
    "operation": {
        "requests": 1,
        "tokens": 1,
        "cost": 1,
        "files": 1
    }
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/quotas/current`

### Purpose

Get current quota usage for the active period.

Get current quota usage for the active period. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `period` | query | no | string | - |

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
curl -X GET "https://api.ailin.one/v1/enterprise/quotas/current" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/quotas/current", {
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
    "https://api.ailin.one/v1/enterprise/quotas/current",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/quotas/reset`

### Purpose

Reset quota usage for the current period.

Reset quota usage for the current period. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "period": "minute"
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
curl -X POST "https://api.ailin.one/v1/enterprise/quotas/reset" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"period":"minute"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/quotas/reset", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "period": "minute"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/enterprise/quotas/reset",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "period": "minute"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/quotas/usage`

### Purpose

Record quota usage for an operation.

Record quota usage for an operation. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "period": "minute",
  "operation": {
    "requests": 1,
    "tokens": 1,
    "cost": 1,
    "files": 1
  }
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
curl -X POST "https://api.ailin.one/v1/enterprise/quotas/usage" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"period":"minute","operation":{"requests":1,"tokens":1,"cost":1,"files":1}}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/quotas/usage", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "period": "minute",
  "operation": {
    "requests": 1,
    "tokens": 1,
    "cost": 1,
    "files": 1
  }
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/enterprise/quotas/usage",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "period": "minute",
    "operation": {
        "requests": 1,
        "tokens": 1,
        "cost": 1,
        "files": 1
    }
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/enterprise/usage/events`

### Purpose

Record usage analytics events.

Record usage analytics events. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "events": [
    {
      "userId": "string",
      "teamId": "string",
      "eventType": "string",
      "timestamp": 1,
      "metadata": {}
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
curl -X POST "https://api.ailin.one/v1/enterprise/usage/events" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"userId":"string","teamId":"string","eventType":"string","timestamp":1,"metadata":{}}]}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/usage/events", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "events": [
    {
      "userId": "string",
      "teamId": "string",
      "eventType": "string",
      "timestamp": 1,
      "metadata": {}
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
    "https://api.ailin.one/v1/enterprise/usage/events",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "events": [
        {
            "userId": "string",
            "teamId": "string",
            "eventType": "string",
            "timestamp": 1,
            "metadata": {}
        }
    ]
},
)
print(response.status_code)
print(response.text)
```

## GET `/v1/enterprise/usage/metrics`

### Purpose

Get aggregated usage analytics metrics.

Get aggregated usage analytics metrics. Enterprise contract: tenant-scoped auth, policy enforcement, quota limits, and request/correlation observability headers.

### Authentication

Requires: Bearer token or API key.

### Parameters

| Name | In | Required | Type | Description |
|---|---|---|---|---|
| `start` | query | no | integer | - |
| `end` | query | no | integer | - |
| `userId` | query | no | string | - |
| `teamId` | query | no | string | - |

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
curl -X GET "https://api.ailin.one/v1/enterprise/usage/metrics" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY"
```

```ts
const response = await fetch("https://api.ailin.one/v1/enterprise/usage/metrics", {
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
    "https://api.ailin.one/v1/enterprise/usage/metrics",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
    },
)
print(response.status_code)
print(response.text)
```

