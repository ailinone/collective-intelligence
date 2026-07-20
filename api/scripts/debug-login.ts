// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import 'dotenv/config';
import { createServer } from '../src/server';
import { connectDatabase, disconnectDatabase } from '../src/database/client';
import { registerAuthRoutes } from '../src/routes/auth/auth-routes';

async function main() {
  process.env.TEST_USE_LOCAL_SERVICES = 'true';
  await connectDatabase();
  const server = await createServer();
  server.addHook('preValidation', async (request, _reply) => {
    if (request.url === '/v1/auth/login') {
      console.log('preValidation body', request.body);
    }
  });
  await registerAuthRoutes(server);
  await server.ready();
  const success = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'test@ailin.dev', password: 'password123' }
  });
  console.log('success status', success.statusCode, success.body);
  const fail = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'test@ailin.dev', password: 'wrong' }
  });
  console.log('fail status', fail.statusCode, fail.body);
  await server.close();
  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
