<!--
Copyright (C) 2026 Ailin One, Inc.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Releasing & versioning

## Versioning policy (pre-1.0)

The project follows SemVer with the pre-1.0 caveat stated in
[CHANGELOG.md](CHANGELOG.md): **minor versions may break compatibility**, and
every breaking change is called out explicitly in the changelog entry.

**What counts as public API** (breaking changes here bump the minor pre-1.0,
the major post-1.0):

- The OpenAI-compatible HTTP surface (`/v1/*` request/response contracts,
  including `ailin_metadata` field semantics)
- Documented environment variables and their defaults
- The `docker compose` quickstart contract (service names, required env)

**Not public API** (may change in any release): internal module layout,
database schema (migrations are applied automatically), undocumented
endpoints, experiment tooling.

## Release procedure

1. Update `CHANGELOG.md`; call out breaking changes and migration notes.
2. Tag `vX.Y.Z` on `main` (signed) and publish a GitHub Release.
3. The `release-provenance` workflow attaches, fail-closed: source tarball,
   `SHA256SUMS`, SPDX SBOM, and a SLSA build-provenance attestation
   (Sigstore). A release without a valid SBOM does not ship.
4. Verify: `gh attestation verify <artifact> --repo ailinone/collective-intelligence`.

## Rollback

Releases are immutable tags — rolling back means pinning the previous tag.
Deployments that track `main` should pin tags instead. Database migrations
are forward-only; a release that ships a migration documents its rollback
path (or the absence of one) in the changelog entry.

## Deprecation

Deprecated surface is announced in the changelog at least one minor version
before removal, with the replacement named. Deprecations ship as runtime
warnings where the surface allows it.
