<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# ADR-017: Destination Config uses KMS-backed Envelope Encryption

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Broadcast feature, credential storage

## Context

Each configured destination holds secrets (API keys, signing tokens). These must be encrypted at rest. Options:

1. **Plain AES-256-GCM with a single static key** (from env var)
2. **Envelope encryption** with a KMS-managed Key Encryption Key (KEK) wrapping per-row Data Encryption Keys (DEKs)
3. **Full KMS encryption** (every row decrypted via KMS API call)

## Decision

**Envelope encryption** (option 2) using GCP KMS as the Key Encryption Key provider, with AES-256-GCM Data Encryption Keys generated per destination row.

## Rationale

- **Key rotation without re-encryption**: rotating the KMS KEK only requires re-wrapping DEKs (O(rows)) — not re-encrypting the actual payloads.
- **Auditable via GCP Cloud Audit Logs**: every KEK use is logged.
- **Isolated blast radius**: compromise of a single DEK exposes one row; compromise of the KEK does not expose DEKs (stored wrapped).
- **Performance**: per-request decryption is local AES (fast); KMS call happens only on destination load (cached per-process with TTL).
- **Consistent with existing stack**: ci/api already uses GCP Secret Manager; KMS is in the same trust boundary.

## Why Not Option 1

- Single-key compromise = total compromise of all configs
- Rotation requires re-encrypting every row atomically (operational risk)
- Difficult to audit per-row access

## Why Not Option 3

- Every trace publish would hit KMS quota (1000s/sec)
- KMS API latency (30-80ms) would dominate publish time
- Cost: KMS charges per 10k operations; at our volume this is significant

## Schema

```sql
broadcast_destination:
  config_dek_wrapped    BYTEA NOT NULL    -- AES key, wrapped by KMS KEK
  config_kek_resource   TEXT  NOT NULL    -- 'projects/P/locations/L/keyRings/R/cryptoKeys/K/cryptoKeyVersions/V'
  config_ciphertext     BYTEA NOT NULL    -- JSON config, encrypted with DEK
  config_iv             BYTEA NOT NULL    -- AES-GCM IV (12 bytes)
  config_auth_tag       BYTEA NOT NULL    -- AES-GCM auth tag (16 bytes)
  config_aad            TEXT  NOT NULL    -- Additional Authenticated Data (destination_id + tenant_id)
```

## Threat Model

| Threat | Mitigation |
|---|---|
| DB backup leak | Ciphertext only; DEK is wrapped by KMS KEK not accessible from backup |
| Application memory dump | DEK lives in memory briefly during decrypt; use `sodium_malloc` for sensitive buffers |
| Log leakage | Structured logger redacts `config` fields by regex |
| Cross-tenant decryption | AAD binds ciphertext to `destination_id + tenant_id`; decryption fails if rebound |
| KMS KEK compromise | Rotate KEK; all DEKs re-wrapped via admin job; ciphertext unaffected |

## Implementation Notes

- Module: `src/broadcast/infrastructure/encryption/destination-config-cipher.ts`
- Interface:
  ```typescript
  encrypt(plaintext: object, tenantId: string, destinationId: string): Promise<EncryptedBlob>
  decrypt(blob: EncryptedBlob, tenantId: string, destinationId: string): Promise<object>
  rotateDEK(destinationId: string): Promise<void>   // admin job
  rotateKEK(): Promise<void>                         // rewraps all DEKs
  ```
- KMS integration uses `@google-cloud/kms`. Local dev uses a mock KEK from env var.
- Decrypted configs cached in-memory (LRU, TTL=5min). Cache is per-process; Kubernetes pod restart forces re-decrypt.

## Consequences

### Positive
- Industry-standard envelope encryption (same pattern as AWS KMS, Azure Key Vault, Google KMS docs)
- Key rotation is operationally safe
- Auditable

### Negative
- +1 infrastructure dependency (KMS must be available at destination-load time). Mitigated: cached decrypted configs survive brief KMS outages.
- Local dev complexity: mock KEK path required.

---

## Addendum (2026-04-24): Multi-cloud KEK abstraction

The original decision named GCP KMS as the KEK provider. A follow-up refactor generalized the contract so the application core remains **cloud-agnostic** and GCP is just one of four possible backends. The decision itself (envelope encryption) is unchanged; this addendum documents the abstraction seam.

### Backend-selection contract

The runtime selects a backend via a single env var:

| `BROADCAST_KEK_PROVIDER` | Provider class | Optional NPM dep | Status |
|---|---|---|---|
| `local`                 | `LocalKekProvider`        | —                         | dev/test only |
| `gcp-kms`               | `GcpKmsKekProvider`       | `@google-cloud/kms`       | production (GCP) |
| `aws-kms`               | `AwsKmsKekProvider`       | `@aws-sdk/client-kms`     | seam reserved (throws "not yet implemented") |
| `azure-keyvault`        | `AzureKeyVaultKekProvider`| `@azure/keyvault-keys`    | seam reserved (throws "not yet implemented") |

The cloud SDK is **declared as an `optionalDependency`** in `package.json`. Deployments targeting a single cloud never install SDKs for the other three. When the selected backend's SDK is absent at runtime, the provider throws an operator-facing error naming the missing package and the env-var fix; see `isPackageMissingError` in `src/broadcast/infrastructure/encryption/gcp-kms-kek-provider.ts` for the cross-runtime detection (Node ESM/CJS, Vite/Vitest, tsx/ts-node).

### Runtime ↔ Terraform env-var mapping

Terraform (or any IaC) provisions the managed KEK in the target cloud and writes the resource identifier to the deployment's secret store under these abstract names:

| Cloud | Terraform resource | Output → env var | Additional env vars |
|---|---|---|---|
| **GCP**   | `google_kms_crypto_key`        | `.id`  → `BROADCAST_KMS_KEK_RESOURCE` | — |
| **AWS**   | `aws_kms_key` + optional alias | `.arn` → `BROADCAST_KMS_KEK_RESOURCE` | `BROADCAST_KMS_REGION` (optional; falls back to the SDK default chain) |
| **Azure** | `azurerm_key_vault_key`        | `.versionless_id` prefix → `BROADCAST_KV_VAULT_URL` + `.name` → `BROADCAST_KV_KEY_NAME` | `BROADCAST_KV_KEY_VERSION` (optional; falls back to the vault's latest) |
| **Local** | n/a                           | `BROADCAST_LOCAL_KEK_B64` (>= 32 base64-encoded bytes) | — |

### Runtime resolution flow

```
process.env
   │
   ▼
parseKekConfigFromEnv(env)           ← tolerates missing vars with clear errors
   │   returns KekProviderConfig =
   │     | { backend: 'local';          masterSecretB64; resourceId? }
   │     | { backend: 'gcp-kms';        keyResource }
   │     | { backend: 'aws-kms';        keyResource; region? }
   │     | { backend: 'azure-keyvault'; vaultUrl; keyName; keyVersion? }
   ▼
resolveKekProviderFromConfig(config) ← sync factory, lazy SDK load per branch
   │
   ▼
[optional] CircuitBreakerKekProvider ← wraps unless BROADCAST_KEK_BREAKER_DISABLED=true
   │
   ▼
KekProvider (wrap/unwrap contract)
```

The factory is **synchronous** because `broadcast-composition-root.ts` constructs providers at module-eval time. SDK loading is deferred to the first `wrap()`/`unwrap()` call inside each cloud provider (memoized `Promise<Client> | null`), so adding a new backend never turns app-boot into an async operation.

### Invariants (enforced by `kek-provider-factory.test.ts`)

1. `resolveKekProviderFromConfig({backend:'local', …})` works with **no cloud SDK installed at all**.
2. `resolveKekProviderFromConfig({backend:'gcp-kms', …})` constructs a provider **without touching `@google-cloud/kms`** (construction-time lazy).
3. `resolveKekProviderFromConfig({backend:'aws-kms'|'azure-keyvault', …})` throws a "not yet implemented" error — the seam is reserved but an operator trying to use it is told explicitly, not silently defaulted.
4. `parseKekConfigFromEnv` refuses to fall back to local in production (`NODE_ENV=production` with `BROADCAST_KEK_PROVIDER` unset → throws).
5. When the optional dep for the selected backend is absent, the first `wrap`/`unwrap` throws an error naming the package and the fix — regardless of whether the underlying Node runtime reports `ERR_MODULE_NOT_FOUND`, `MODULE_NOT_FOUND`, or a Vite-/Vitest-style resolver message.

### Forbidden patterns

- Direct `import` of a cloud SDK anywhere outside the corresponding provider file.
- Promotion of `@google-cloud/kms` / `@aws-sdk/client-kms` / `@azure/keyvault-keys` from `optionalDependencies` to `dependencies` — that would drag one cloud's SDK into every deployment.
- `@ts-expect-error` on the dynamic SDK import. The correct approach is *local type modeling* of the minimal SDK surface the adapter consumes (see `KmsClient`/`KmsModuleShape` in `gcp-kms-kek-provider.ts`) and a runtime shape-check at the import boundary.
