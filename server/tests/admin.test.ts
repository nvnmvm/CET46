import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestApp, sampleWord, seedUser, sessionCookie } from "./helpers.ts";
import { RepositorySessionRejectedError } from "../src/repository.ts";
import { hashPassword } from "../src/auth.ts";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "Admin-Password-1949!";
const LEARNER_EMAIL = "learner@example.com";
const LEARNER_PASSWORD = "Learner-Password-1949!";

async function login(app: FastifyInstance, email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  return sessionCookie(response);
}

test("登录验证后发生密码重置或禁用，不能再签发旧凭据会话", async () => {
  const { app, repository } = await createTestApp();
  try {
    const admin = await seedUser(repository, ADMIN_EMAIL, ADMIN_PASSWORD);
    await repository.promoteUserToAdmin(admin.id);
    const learner = await seedUser(repository, LEARNER_EMAIL, LEARNER_PASSWORD);
    const input = { id: "race-session", userId: learner.id, tokenHash: "race-token",
      expiresAt: new Date(Date.now() + 60000).toISOString(), expectedPasswordHash: learner.passwordHash };
    await repository.adminResetUserPassword(admin.id, learner.id, await hashPassword("New-Password-1949!"));
    await assert.rejects(repository.createSession(input), RepositorySessionRejectedError);
    const refreshed = await repository.findUserByEmail(LEARNER_EMAIL);
    assert.ok(refreshed);
    await repository.adminSetUserDisabled(admin.id, learner.id, true);
    await assert.rejects(repository.createSession({ ...input, expectedPasswordHash: refreshed.passwordHash }), RepositorySessionRejectedError);
  } finally {
    await app.close();
  }
});

test("管理员身份与普通身份隔离，并且管理写操作必须同源", async () => {
  const { app, repository, config } = await createTestApp();
  try {
    const admin = await seedUser(repository, ADMIN_EMAIL, ADMIN_PASSWORD);
    const learner = await seedUser(repository, LEARNER_EMAIL, LEARNER_PASSWORD);
    await repository.promoteUserToAdmin(admin.id);
    const adminCookie = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const learnerCookie = await login(app, LEARNER_EMAIL, LEARNER_PASSWORD);

    const learnerWords = await app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: learnerCookie },
      payload: { words: [sampleWord({ word: "admin-boundary" })] },
    });
    assert.equal(learnerWords.statusCode, 200);
    const beforeManagement = repository.snapshotWords(learner.id);

    assert.equal((await app.inject({ method: "GET", url: "/api/admin/me" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: learnerCookie } })).statusCode, 403);
    assert.deepEqual(
      (await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: adminCookie } })).json(),
      { isAdmin: true },
    );

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
      payload: { email: "new@example.com", username: "new", password: "New-Password-1949!" },
    });
    assert.equal(missingOrigin.statusCode, 403);
    assert.equal(missingOrigin.json().error.code, "origin_forbidden");

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie, origin: "https://attacker.example" },
      payload: { email: "new@example.com", username: "new", password: "New-Password-1949!" },
    });
    assert.equal(wrongOrigin.statusCode, 403);

    const learnerWrite = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: learnerCookie, origin: config.appOrigin },
      payload: { email: "new@example.com", username: "new", password: "New-Password-1949!" },
    });
    assert.equal(learnerWrite.statusCode, 403);

    for (const request of [
      { method: "GET", url: "/api/admin/users" },
      { method: "PATCH", url: `/api/admin/users/${learner.id}/status`, payload: { disabled: true } },
      { method: "POST", url: `/api/admin/users/${learner.id}/password-reset`, payload: { password: "Reset-Password-1949!" } },
    ] as const) {
      const response = await app.inject({
        ...request,
        headers: { cookie: learnerCookie, origin: config.appOrigin },
      });
      assert.equal(response.statusCode, 403);
    }

    const profileEscalation = await app.inject({
      method: "PATCH",
      url: "/api/account/profile",
      headers: { cookie: learnerCookie },
      payload: { username: "still learner", avatar: null, role: "admin" },
    });
    assert.equal(profileEscalation.statusCode, 400);
    assert.deepEqual(repository.snapshotWords(learner.id), beforeManagement);
  } finally {
    await app.close();
  }
});

test("管理员创建、分页、禁用启用、重置密码会撤销目标会话并写入最小审计", async () => {
  const { app, repository, config } = await createTestApp();
  try {
    const admin = await seedUser(repository, ADMIN_EMAIL, ADMIN_PASSWORD);
    const existingLearner = await seedUser(repository, LEARNER_EMAIL, LEARNER_PASSWORD);
    await repository.promoteUserToAdmin(admin.id);
    const adminCookie = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const learnerCookie = await login(app, LEARNER_EMAIL, LEARNER_PASSWORD);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie, origin: config.appOrigin },
      payload: { email: "created@example.com", username: "Created learner", password: "Created-Password-1949!" },
    });
    assert.equal(created.statusCode, 200);
    const createdUser = created.json().user;
    assert.equal(createdUser.role, "learner");
    assert.equal("passwordHash" in createdUser, false);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie, origin: config.appOrigin },
      payload: { email: "created@example.com", username: "other", password: "Created-Password-1949!" },
    });
    assert.equal(duplicate.statusCode, 409);

    const invalidBody = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie, origin: config.appOrigin },
      payload: { email: "bad@example.com", username: "bad", password: "Created-Password-1949!", role: "admin" },
    });
    assert.equal(invalidBody.statusCode, 400);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/users?limit=1&offset=0",
      headers: { cookie: adminCookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().total, 3);
    assert.equal(listed.json().users.length, 1);
    assert.equal("passwordHash" in listed.json().users[0], false);

    const searched = await app.inject({
      method: "GET",
      url: "/api/admin/users?limit=20&offset=0&search=created",
      headers: { cookie: adminCookie },
    });
    assert.equal(searched.statusCode, 200);
    assert.equal(searched.json().total, 1);
    assert.equal(searched.json().users[0].email, "created@example.com");

    const noMatch = await app.inject({
      method: "GET",
      url: "/api/admin/users?limit=20&offset=0&search=missing",
      headers: { cookie: adminCookie },
    });
    assert.equal(noMatch.statusCode, 200);
    assert.equal(noMatch.json().total, 0);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${existingLearner.id}/status`,
      headers: { cookie: adminCookie, origin: config.appOrigin },
      payload: { disabled: true },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().user.disabledAt !== null, true);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: learnerCookie } })).statusCode, 401);
    assert.equal((await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: LEARNER_EMAIL, password: LEARNER_PASSWORD },
    })).statusCode, 401);

    const enabled = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${existingLearner.id}/status`,
      headers: { cookie: adminCookie, origin: config.appOrigin },
      payload: { disabled: false },
    });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.json().user.disabledAt, null);

    const freshLearnerCookie = await login(app, LEARNER_EMAIL, LEARNER_PASSWORD);
    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${existingLearner.id}/password-reset`,
      headers: { cookie: adminCookie, origin: config.appOrigin },
      payload: { password: "Reset-Password-1949!" },
    });
    assert.equal(reset.statusCode, 200);
    assert.equal("passwordHash" in reset.json().user, false);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: freshLearnerCookie } })).statusCode, 401);
    assert.equal((await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: LEARNER_EMAIL, password: LEARNER_PASSWORD },
    })).statusCode, 401);
    assert.equal((await login(app, LEARNER_EMAIL, "Reset-Password-1949!")).length > 10, true);

    assert.equal((await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${admin.id}/status`,
      headers: { cookie: adminCookie, origin: config.appOrigin },
      payload: { disabled: true },
    })).statusCode, 403);

    const audit = repository.snapshotAdminAudit();
    assert.deepEqual(audit.map((entry) => entry.action), ["create_user", "disable_user", "enable_user", "reset_password"]);
    assert.equal(audit.every((entry) => !("password" in entry) && !("passwordHash" in entry)), true);
  } finally {
    await app.close();
  }
});
