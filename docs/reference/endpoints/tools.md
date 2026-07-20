<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Tools Endpoints

Total operations: 6

## POST `/v1/tools/google-maps`

### Purpose

Google Maps integration (legacy).

Legacy endpoint. Use specific endpoints: /search, /geocode, /directions, /place-details

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "operation": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Google Maps service status |
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
curl -X POST "https://api.ailin.one/v1/tools/google-maps" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"operation":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/google-maps", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "operation": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/google-maps",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "operation": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/google-maps/directions`

### Purpose

Get directions.

Retrieves detailed turn-by-turn directions between two locations using the Google Maps Directions API. Supports multiple travel modes (driving, walking, bicycling, transit), route optimization, waypoints, and alternative routes. Returns step-by-step directions, distances, durations, and route geometry for mapping applications.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "origin": "string",
  "destination": "string",
  "mode": "driving",
  "language": "string",
  "alternatives": true,
  "avoid": [
    "tolls"
  ]
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Directions retrieved successfully |
| `400` | #/components/responses/BadRequest |
| `401` | #/components/responses/Unauthorized |
| `403` | #/components/responses/Forbidden |
| `404` | #/components/responses/NotFound |
| `409` | #/components/responses/Conflict |
| `422` | #/components/responses/UnprocessableEntity |
| `429` | #/components/responses/TooManyRequests |
| `500` | #/components/responses/InternalServerError |
| `503` | Service unavailable (Google Maps API not configured) |

### Error Handling

Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.

### Rate Limits

Subject to tenant-level quota and platform-level rate-limit policies.

### Observability

Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.

### Examples

```bash
curl -X POST "https://api.ailin.one/v1/tools/google-maps/directions" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"origin":"string","destination":"string","mode":"driving","language":"string","alternatives":true,"avoid":["tolls"]}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/google-maps/directions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "origin": "string",
  "destination": "string",
  "mode": "driving",
  "language": "string",
  "alternatives": true,
  "avoid": [
    "tolls"
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
    "https://api.ailin.one/v1/tools/google-maps/directions",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "origin": "string",
    "destination": "string",
    "mode": "driving",
    "language": "string",
    "alternatives": true,
    "avoid": [
        "tolls"
    ]
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/google-maps/geocode`

### Purpose

Geocode address.

Converts a human-readable address or place name into geographic coordinates (latitude and longitude). Supports addresses in various formats and languages. Returns precise location data along with formatted addresses, location types, and place IDs. Essential for mapping applications and location-based services.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "address": "string",
  "language": "string",
  "region": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Geocoding completed successfully |
| `400` | #/components/responses/BadRequest |
| `401` | #/components/responses/Unauthorized |
| `403` | #/components/responses/Forbidden |
| `404` | #/components/responses/NotFound |
| `409` | #/components/responses/Conflict |
| `422` | #/components/responses/UnprocessableEntity |
| `429` | #/components/responses/TooManyRequests |
| `500` | #/components/responses/InternalServerError |
| `503` | Service unavailable (Google Maps API not configured) |

### Error Handling

Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.

### Rate Limits

Subject to tenant-level quota and platform-level rate-limit policies.

### Observability

Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.

### Examples

```bash
curl -X POST "https://api.ailin.one/v1/tools/google-maps/geocode" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"address":"string","language":"string","region":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/google-maps/geocode", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "address": "string",
  "language": "string",
  "region": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/google-maps/geocode",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "address": "string",
    "language": "string",
    "region": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/google-maps/place-details`

### Purpose

Get place details.

Retrieves comprehensive information about a specific place using its place ID. Returns detailed data including address, phone number, website, opening hours, ratings, reviews, photos, and amenities. Supports field filtering to request only needed information, optimizing response size and API costs. Essential for building detailed place profile pages.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "place_id": "string",
  "fields": [
    "string"
  ],
  "language": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Place details retrieved successfully |
| `400` | #/components/responses/BadRequest |
| `401` | #/components/responses/Unauthorized |
| `403` | #/components/responses/Forbidden |
| `404` | #/components/responses/NotFound |
| `409` | #/components/responses/Conflict |
| `422` | #/components/responses/UnprocessableEntity |
| `429` | #/components/responses/TooManyRequests |
| `500` | #/components/responses/InternalServerError |
| `503` | Service unavailable (Google Maps API not configured) |

### Error Handling

Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.

### Rate Limits

Subject to tenant-level quota and platform-level rate-limit policies.

### Observability

Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.

### Examples

```bash
curl -X POST "https://api.ailin.one/v1/tools/google-maps/place-details" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"place_id":"string","fields":["string"],"language":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/google-maps/place-details", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "place_id": "string",
  "fields": [
    "string"
  ],
  "language": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/google-maps/place-details",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "place_id": "string",
    "fields": [
        "string"
    ],
    "language": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/google-maps/reverse-geocode`

### Purpose

Reverse geocode coordinates.

Converts geographic coordinates (latitude and longitude) into human-readable addresses and location information. Returns formatted addresses, location components, place IDs, and administrative boundaries. Useful for displaying user-friendly location information from GPS coordinates or map clicks.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "lat": 1,
  "lng": 1,
  "language": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Reverse geocoding completed successfully |
| `400` | #/components/responses/BadRequest |
| `401` | #/components/responses/Unauthorized |
| `403` | #/components/responses/Forbidden |
| `404` | #/components/responses/NotFound |
| `409` | #/components/responses/Conflict |
| `422` | #/components/responses/UnprocessableEntity |
| `429` | #/components/responses/TooManyRequests |
| `500` | #/components/responses/InternalServerError |
| `503` | Service unavailable (Google Maps API not configured) |

### Error Handling

Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.

### Rate Limits

Subject to tenant-level quota and platform-level rate-limit policies.

### Observability

Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.

### Examples

```bash
curl -X POST "https://api.ailin.one/v1/tools/google-maps/reverse-geocode" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"lat":1,"lng":1,"language":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/google-maps/reverse-geocode", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "lat": 1,
  "lng": 1,
  "language": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/google-maps/reverse-geocode",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "lat": 1,
    "lng": 1,
    "language": "string"
},
)
print(response.status_code)
print(response.text)
```

## POST `/v1/tools/google-maps/search`

### Purpose

Search places.

Searches for places (businesses, points of interest, landmarks) using the Google Maps Places API. Supports text queries with optional location bias, radius filtering, and place type filtering. Returns detailed place information including names, addresses, ratings, and place IDs for further operations.

### Authentication

Requires: Bearer token or API key.

### Parameters

This operation does not declare explicit parameters.

### Request Body

```json
{
  "query": "string",
  "location": {
    "lat": 1,
    "lng": 1
  },
  "radius": 1,
  "type": "string",
  "language": "string"
}
```

### Responses

| Status | Description |
|---|---|
| `200` | Places search completed successfully |
| `400` | #/components/responses/BadRequest |
| `401` | #/components/responses/Unauthorized |
| `403` | #/components/responses/Forbidden |
| `404` | #/components/responses/NotFound |
| `409` | #/components/responses/Conflict |
| `422` | #/components/responses/UnprocessableEntity |
| `429` | #/components/responses/TooManyRequests |
| `500` | #/components/responses/InternalServerError |
| `503` | Service unavailable (Google Maps API not configured) |

### Error Handling

Client errors generally follow 4xx contracts (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity`, `TooManyRequests`). Server failures return `500`.

### Rate Limits

Subject to tenant-level quota and platform-level rate-limit policies.

### Observability

Propagate and log `X-Request-Id` and `X-Correlation-Id` for traceability, debugging, and audit workflows.

### Examples

```bash
curl -X POST "https://api.ailin.one/v1/tools/google-maps/search" \
  -H "Authorization: Bearer $AILIN_TOKEN" \
  -H "X-API-Key: $AILIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"string","location":{"lat":1,"lng":1},"radius":1,"type":"string","language":"string"}'
```

```ts
const response = await fetch("https://api.ailin.one/v1/tools/google-maps/search", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.AILIN_TOKEN}`,
    "X-API-Key": process.env.AILIN_API_KEY || "",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  "query": "string",
  "location": {
    "lat": 1,
    "lng": 1
  },
  "radius": 1,
  "type": "string",
  "language": "string"
}),
});
const data = await response.json();
```

```python
import os
import requests

response = requests.request(
    "POST",
    "https://api.ailin.one/v1/tools/google-maps/search",
    headers={
        "Authorization": f"Bearer {os.environ.get('AILIN_TOKEN', '')}",
        "X-API-Key": os.environ.get("AILIN_API_KEY", ""),
        "Content-Type": "application/json",
    },
    json={
    "query": "string",
    "location": {
        "lat": 1,
        "lng": 1
    },
    "radius": 1,
    "type": "string",
    "language": "string"
},
)
print(response.status_code)
print(response.text)
```

