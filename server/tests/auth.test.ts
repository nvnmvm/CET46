import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCookieValue, generateSessionToken, hashSessionToken } from "../src/auth.ts";
import { newId } from "../src/ids.ts";
import {
  TEST_SESSION_SECRET,
  cookieName,
  createTestApp,
  sampleWord,
  seedUser,
  sessionCookie,
} from "./helpers.ts";

const EMAIL = "learner@example.com";
const PASSWORD = "Correct-Horse-1949";

test("登录成功后下发 HttpOnly 会话 Cookie，响应里没有密码摘要", async () => {
  const { app, repository } = await createTestApp();
  try {
    await seedUser(repository, EMAIL, PASSWORD);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    const setCookie = String(response.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Max-Age=\d+/);
    assert.equal(setCookie.includes("Secure"), false, "开发/测试环境不下发 Secure");

    const body = response.json();
    assert.equal(body.user.email, EMAIL);
    assert.equal(JSON.stringify(body).includes("password"), false);

    const cookie = sessionCookie(response);
    assert.ok(cookie.startsWith(`${cookieName()}=`));
    // 会话 token 原文只应出现在 Cookie 里；不是数据库里存的哈希。
    const token = cookie.slice(cookieName().length + 1).split(".")[0] ?? "";
    assert.ok(token.length > 20);
  } finally {
    await app.close();
  }
});

test("生产配置下会话 Cookie 带 Secure", async () => {
  const { app, repository } = await createTestApp({ configOverrides: { COOKIE_SECURE: "true" } });
  try {
    await seedUser(repository, EMAIL, PASSWORD);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    assert.match(String(response.headers["set-cookie"]), /Secure/);
  } finally {
    await app.close();
  }
});

test("密码错误与账号不存在都返回 401，不泄露账号是否存在", async () => {
  const { app, repository } = await createTestApp();
  try {
    await seedUser(repository, EMAIL, PASSWORD);
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: "wrong-password" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: PASSWORD },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownEmail.statusCode, 401);
    assert.deepEqual(wrongPassword.json(), unknownEmail.json());
  } finally {
    await app.close();
  }
});

test("禁用账号使用正确密码时返回明确错误，错误密码仍不泄露账号状态", async () => {
  const { app, repository } = await createTestApp();
  try {
    const admin = await seedUser(repository, "admin@example.com", "Admin-Password-1949!");
    const learner = await seedUser(repository, EMAIL, PASSWORD);
    await repository.promoteUserToAdmin(admin.id);
    await repository.adminSetUserDisabled(admin.id, learner.id, true);

    const correctPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    assert.equal(correctPassword.statusCode, 401);
    assert.equal(correctPassword.json().error.code, "account_disabled");

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: "wrong-password" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: PASSWORD },
    });
    assert.deepEqual(wrongPassword.json(), unknownEmail.json());
    assert.equal(wrongPassword.json().error.code, "invalid_credentials");
  } finally {
    await app.close();
  }
});

test("登录请求体非法时返回 400", async () => {
  const { app } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "not-an-email", password: "" },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("GET /api/auth/me 未登录返回 401，登录后返回当前用户", async () => {
  const { app, repository } = await createTestApp();
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/auth/me" });
    assert.equal(anonymous.statusCode, 401);

    const user = await seedUser(repository, EMAIL, PASSWORD);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookie = sessionCookie(login);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, user.id);
  } finally {
    await app.close();
  }
});

test("当前用户只能读写自己的资料，资料更新不会影响另一账号", async () => {
  const { app, repository } = await createTestApp();
  try {
    const first = await seedUser(repository, EMAIL, PASSWORD);
    const second = await seedUser(repository, "friend@example.com", "Friend-Pass-1949");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookie = sessionCookie(login);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/account/profile",
      headers: { cookie },
      payload: { username: "学习伙伴", avatar: "✦" },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().user, {
      id: first.id,
      email: EMAIL,
      username: "学习伙伴",
      avatar: "✦",
      timezone: "Asia/Shanghai",
      createdAt: first.createdAt,
    });

    const ownProfile = await app.inject({ method: "GET", url: "/api/account/profile", headers: { cookie } });
    assert.equal(ownProfile.statusCode, 200);
    assert.equal(ownProfile.json().user.username, "学习伙伴");
    assert.equal((await repository.findUserById(second.id))?.username, null);

    const injectedIdentity = await app.inject({
      method: "PATCH",
      url: "/api/account/profile",
      headers: { cookie },
      payload: { username: "越权", avatar: "◎", userId: second.id },
    });
    assert.equal(injectedIdentity.statusCode, 400);
    assert.equal((await repository.findUserById(second.id))?.username, null);
  } finally {
    await app.close();
  }
});

test("登出会撤销会话：旧 Cookie 之后无法再访问", async () => {
  const { app, repository } = await createTestApp();
  try {
    await seedUser(repository, EMAIL, PASSWORD);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookie = sessionCookie(login);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    assert.equal(logout.statusCode, 200);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);

    const afterLogout = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    assert.equal(afterLogout.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("签名被篡改的 Cookie 无法通过校验", async () => {
  const { app, repository } = await createTestApp();
  try {
    await seedUser(repository, EMAIL, PASSWORD);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookie = sessionCookie(login);
    const [name, value = ""] = cookie.split("=");
    const [token = ""] = value.split(".");
    const forged = `${name}=${token}.forged-signature`;

    const response = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: forged } });
    assert.equal(response.statusCode, 401);

    const unsigned = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${name}=${token}` },
    });
    assert.equal(unsigned.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("过期会话即使签名正确也返回 401", async () => {
  const { app, repository } = await createTestApp();
  try {
    const user = await seedUser(repository, EMAIL, PASSWORD);
    const token = generateSessionToken();
    await repository.createSession({
      id: newId("sess"),
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const cookie = `${cookieName()}=${formatCookieValue(token, TEST_SESSION_SECRET)}`;
    const response = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("登录后可以访问自己的词库", async () => {
  const { app, repository } = await createTestApp();
  try {
    await seedUser(repository, EMAIL, PASSWORD);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    const cookie = sessionCookie(login);
    const imported = await app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie },
      payload: { words: [sampleWord()] },
    });
    assert.equal(imported.statusCode, 200);
    const listed = await app.inject({ method: "GET", url: "/api/words", headers: { cookie } });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().words.length, 1);
  } finally {
    await app.close();
  }
});
