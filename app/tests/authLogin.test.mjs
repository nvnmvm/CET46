import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, createApiClient } from '../src/data/apiClient.ts';

/**
 * 聚焦认证入口（App.tsx 的登录/会话探测/退出）：
 * 1) 用真实 apiClient + fake fetch 验证登录页依赖的请求契约与错误处理；
 * 2) 用源码断言保证 App.tsx 不再把本机档案当作登录态，也不把密码写进持久化存储。
 */

const BASE_URL = 'https://api.example.test';
const APP_SOURCE = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

const stored = new Map();
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
};
beforeEach(() => stored.clear());

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 队列式 fake fetch：按调用顺序返回响应，并记录 URL / init / 解析后的 body。 */
function createClient(responses = []) {
  const queue = [...responses];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { client: createApiClient({ baseUrl: BASE_URL, fetchImpl }), calls };
}

test('启动探测：未登录（401）返回 null，请求只带 cookie 不含身份参数', async () => {
  const { client, calls } = createClient([
    jsonResponse(401, { error: { code: 'unauthorized', message: '未登录或会话已失效' } }),
  ]);

  assert.equal(await client.session(), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/api/auth/me`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].body, undefined, 'session() 不得提交 userId 或任何身份字段');
});

test('启动探测：已有会话时返回服务器用户资料', async () => {
  const { client } = createClient([
    jsonResponse(200, { user: { id: 'u-1', email: 'a@example.com', username: '小一', avatar: '◎' } }),
  ]);

  assert.deepEqual(await client.session(), {
    id: 'u-1',
    email: 'a@example.com',
    username: '小一',
    avatar: '◎',
  });
});

test('登录：POST /api/auth/login 提交邮箱与密码，成功返回服务器用户', async () => {
  const { client, calls } = createClient([
    jsonResponse(200, { user: { id: 'u-1', email: 'a@example.com' } }),
  ]);

  const user = await client.login('a@example.com', 'secret-password');
  assert.equal(calls[0].url, `${BASE_URL}/api/auth/login`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(calls[0].body, { email: 'a@example.com', password: 'secret-password' });
  assert.equal(user.email, 'a@example.com');
  assert.equal(user.id, 'u-1');
});

test('登录失败：抛出受控 ApiError（服务端消息），且不写入本地存储', async () => {
  const { client } = createClient([
    jsonResponse(401, { error: { code: 'invalid_credentials', message: '邮箱或密码不正确' } }),
  ]);

  await assert.rejects(client.login('a@example.com', 'wrong-password'), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'invalid_credentials');
    assert.equal(error.message, '邮箱或密码不正确');
    return true;
  });
  assert.equal(stored.size, 0, '认证失败后不应有本机档案或密码残留');
});

test('网络故障：登录抛出受控 ApiError，供登录页显示通用文案', async () => {
  const { client } = createClient([() => { throw new TypeError('fetch failed'); }]);

  await assert.rejects(client.login('a@example.com', 'secret-password'), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    assert.equal(error.code, 'network_error');
    return true;
  });
});

test('退出登录：POST /api/auth/logout 且不带 body', async () => {
  const { client, calls } = createClient([new Response(null, { status: 204 })]);

  await client.logout();
  assert.equal(calls[0].url, `${BASE_URL}/api/auth/logout`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].body, undefined);
});

test('App 认证入口已切到 apiClient，不再把本机档案当作登录态', () => {
  assert.match(APP_SOURCE, /apiClient\.session\(\)/, '启动时应探测服务器会话');
  assert.match(APP_SOURCE, /apiClient\.login\(/, '登录应调用服务器接口');
  assert.match(APP_SOURCE, /apiClient\.logout\(/, '退出应调用服务器接口');
  assert.doesNotMatch(APP_SOURCE, /wordRepository\.(signIn|signOut|getSession)\(/, '不得再使用 localStore 的登录接口');
  assert.doesNotMatch(APP_SOURCE, /localStorage/, 'App.tsx 不得直接读写本地存储（密码只留在组件 state）');
});

test('登录相关文案不再宣传本地演示模式', () => {
  for (const text of ['本机演示模式', '本地登录', '数据会保存在这台设备', '前端本地测试模式']) {
    assert.doesNotMatch(APP_SOURCE, new RegExp(text), `不应再出现“${text}”`);
  }
  assert.match(APP_SOURCE, /正在检查登录状态/, '探测期间应显示登录状态检查文案');
  assert.match(APP_SOURCE, /服务器账号登录/, '登录页应说明这是服务器账号登录');
  assert.match(APP_SOURCE, /不提供公开注册/, '登录页应说明不开放注册');
});
