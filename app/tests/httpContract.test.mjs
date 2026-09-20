import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/data/apiClient.ts';
import { createTestApp, seedUser, sessionCookie } from '../../server/tests/helpers.ts';

test('real apiClient and Fastify agree on bodyless logout and revoke the session', async () => {
  const { app, repository } = await createTestApp();
  try {
    await seedUser(repository, 'contract@example.test', 'Contract-Password-2026');
    let cookie;
    const client = createApiClient({ baseUrl: '', fetchImpl: async (url, init) => {
      const result = await app.inject({ method: init.method, url,
        headers: { ...init.headers, ...(cookie ? { cookie } : {}) }, payload: init.body });
      if (url === '/api/auth/login' && result.statusCode === 200) cookie = sessionCookie(result);
      return new Response(result.statusCode === 204 ? null : result.body, { status: result.statusCode });
    } });
    await client.login('contract@example.test', 'Contract-Password-2026');
    assert.ok(await client.session());
    await client.logout();
    // Retain the old cookie in the adapter to verify server revocation, not just browser clearing.
    assert.equal(await client.session(), null);
  } finally {
    await app.close();
  }
});
