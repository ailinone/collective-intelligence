<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Installation

Quick guide to run `ci/api` locally with OpenAPI/docs validation.

## Prerequisites

- Node.js 20+
- npm 10+ (or pnpm in the `api` subproject)
- Docker (optional, for local database/redis)
- Test provider credentials (optional)

### Steps

```bash
cd <repo-root>
npm ci
cd api
pnpm install
pnpm run ensure-local-db
pnpm run start
```

### Validate OpenAPI and docs

```bash
cd <repo-root>
npm run check:openapi
npm run generate:docs
npm run check:docs
```
