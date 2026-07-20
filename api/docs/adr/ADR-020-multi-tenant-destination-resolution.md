<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-020: Multi-Tenant Destination Resolution (Org + User)

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature, multi-tenant configuration

## Context

Destinations can be configured at two tenant levels:
- **Organization level**: set by org admin, applies to all members
- **User level**: set by individual user, applies to their own API keys only

Multiple possible semantics:
1. **Union**: all org destinations + all user destinations receive traces
2. **Override**: user destinations replace org destinations (if present)
3. **Explicit scope**: each destination declares whether it's org-scoped or user-scoped; both apply independently

## Decision

**Option 3 (explicit scope) + union semantics** for delivery.

Each row in `broadcast_destination` has:
- `tenant_type`: `'organization' | 'user'`
- `tenant_id`: the org UUID or user UUID
- `api_key_filter`: optional allowlist of API key IDs

**Resolution at publish time**:

```
For a request made with API key K belonging to user U in org O:
  destinations_to_notify = []
  
  FOR EACH d IN broadcast_destination WHERE d.enabled = true:
    # Org-level match
    IF d.tenant_type = 'organization' AND d.tenant_id = O
       AND (d.api_key_filter IS NULL OR K ∈ d.api_key_filter):
       destinations_to_notify += [d]
    
    # User-level match
    IF d.tenant_type = 'user' AND d.tenant_id = U
       AND (d.api_key_filter IS NULL OR K ∈ d.api_key_filter):
       destinations_to_notify += [d]
  
  return destinations_to_notify
```

No deduplication: if org and user both configure a Langfuse destination with different credentials, **both** receive traces (they're logically distinct destinations).

## Rationale

- **Org admins get centralized observability** (compliance, cost tracking)
- **Users get personal debugging** (their own Langfuse sandbox)
- **No hidden precedence**: additive semantics are the easiest mental model
- **Aligns with OpenRouter's model**: both org and user scope supported independently
- **API key filter is orthogonal**: works the same at either scope

## Edge Cases

| Scenario | Resolution |
|---|---|
| User has no destinations, org has 2 | 2 destinations notified |
| User has 1 destination, org has 2 | 3 destinations notified (all) |
| User's destination filter excludes current key | Skip that destination, org's still applies |
| Same destination type (e.g., 2 Langfuses) at both scopes | Both fire — treated as independent sinks |
| User leaves org | User-scoped destinations remain; org-scoped become inapplicable to that user |

## Authorization

- Users can CRUD their own user-scoped destinations
- Org admins can CRUD org-scoped destinations (role check: `organization_admin`)
- Regular org members can READ org-scoped destinations (for visibility) but NOT write
- Chatroom requests (no API key): use org-scoped destinations of the owning org; user-scoped destinations do NOT apply

## Schema Impact

```sql
-- Tenant resolution requires an index on (tenant_type, tenant_id, enabled):
CREATE INDEX broadcast_destination_resolution_idx
  ON broadcast_destination (tenant_type, tenant_id, enabled)
  WHERE enabled = true;

-- Row-level security (RLS) for tenant isolation:
CREATE POLICY broadcast_destination_isolation ON broadcast_destination
  USING (
    (tenant_type = 'organization' AND tenant_id = current_setting('app.current_org_id')::uuid) OR
    (tenant_type = 'user' AND tenant_id = current_setting('app.current_user_id')::uuid)
  );
```

## Consequences

### Positive
- Simple, additive mental model
- Clear ownership per row (tenant_type + tenant_id)
- RLS provides defense-in-depth against cross-tenant leakage

### Negative
- A user can accidentally trigger double-billing if org and user both have (different credentials to) same observability provider. Mitigated: UI warns about duplicate destination types.
- Fan-out at publish can be larger than at other single-scope systems. Bounded: a tenant can have max 20 active destinations (soft quota).

## Implementation Notes

- Resolution at `BroadcastOutboxPoller.drain()` time, not at request time (avoid latency on hot path).
- Cache destination list per `(user_id, org_id)` with TTL=60s; invalidate on destination CRUD events.
- Respect `api_key_filter` AFTER cache lookup (filter is cheap set membership).
