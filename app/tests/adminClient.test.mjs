import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../src/data/apiClient.ts';

const user = { id: 'u1', email: 'learner@example.test', username: 'Learner', role: 'learner', disabledAt: null, createdAt: '2026-09-20T00:00:00Z' };
function setup(payload, status = 200) {
  const calls = [];
  const client = createApiClient({ baseUrl: '', fetchImpl: async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(status === 204 ? null : JSON.stringify(payload), { status });
  } });
  return { client, calls };
}

test('admin list uses cookie identity, pagination and only safe metadata', async () => {
  const { client, calls } = setup({ users: [{ ...user, passwordHash: 'must-not-return', learningEvents: [] }], total: 1 });
  assert.deepEqual(await client.adminUsers({ limit: 20, offset: 0 }), { users: [user], total: 1 });
  assert.equal(calls[0].url, '/api/admin/users?limit=20&offset=0');
  assert.equal(calls[0].credentials, 'include');
  assert.equal(calls[0].body, undefined);
});

test('admin create sends whitelisted fields, never client-specified role', async () => {
  const { client, calls } = setup(null, 204);
  await client.adminCreateUser({ email: user.email, username: 'Learner', password: 'test-password-only', role: 'admin', userId: 'other' });
  assert.equal(calls[0].url, '/api/admin/users');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { email: user.email, username: 'Learner', password: 'test-password-only' });
});

test('admin status and reset have explicit methods and encode target IDs', async () => {
  const { client, calls } = setup(null, 204);
  await client.adminSetDisabled('a/b', true);
  await client.adminResetPassword('a/b', 'test-new-password');
  assert.equal(calls[0].url, '/api/admin/users/a%2Fb/status');
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { disabled: true });
  assert.equal(calls[1].url, '/api/admin/users/a%2Fb/password-reset');
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].body, { password: 'test-new-password' });
});

test('only permission-denied hides admin entry; session and network failures remain errors', async () => {
  assert.equal(await setup({ isAdmin: true }).client.adminStatus(), true);
  assert.equal(await setup({ error: { code: 'forbidden', message: '无权限' } }, 403).client.adminStatus(), false);
  await assert.rejects(setup({ error: { code: 'unauthorized', message: '会话失效' } }, 401).client.adminStatus(), e => e instanceof ApiError && e.status === 401);
  const client = createApiClient({ fetchImpl: async () => { throw new Error('private network detail'); } });
  await assert.rejects(client.adminStatus(), e => e instanceof ApiError && e.status === 0 && !e.message.includes('private'));
});

test('admin mutations do not swallow conflicts or permissions; malformed lists fail closed', async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    const { client } = setup({ error: { code: 'failed', message: '未完成' } }, status);
    await assert.rejects(client.adminSetDisabled('u1', true), e => e instanceof ApiError && e.status === status);
  }
  await assert.rejects(setup({ users: [{ ...user, role: 'unexpected' }], total: 1 }).client.adminUsers(), ApiError);
});
