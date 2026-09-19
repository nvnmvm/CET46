import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./helpers.ts";

test("GET /api/health 不依赖数据库即可返回 200", async () => {
  const { app } = await createTestApp({ ready: false });
  try {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test("GET /api/ready 在数据库不可用时返回 503 且不是 HTML", async () => {
  const { app } = await createTestApp({ ready: false });
  try {
    const response = await app.inject({ method: "GET", url: "/api/ready" });
    assert.equal(response.statusCode, 503);
    assert.match(String(response.headers["content-type"]), /application\/json/);
    assert.deepEqual(response.json(), { ok: false, database: "down" });
    assert.equal(response.body.includes("<html"), false);
  } finally {
    await app.close();
  }
});

test("GET /api/ready 在数据库可用时返回 200", async () => {
  const { app } = await createTestApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/ready" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, database: "up" });
  } finally {
    await app.close();
  }
});

test("未知的 /api 路径返回 JSON 404，不回退到 index.html", async () => {
  const { app } = await createTestApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    assert.equal(response.statusCode, 404);
    assert.match(String(response.headers["content-type"]), /application\/json/);
    assert.equal(response.body.includes("<html"), false);
  } finally {
    await app.close();
  }
});

test("本批不提供公开注册入口", async () => {
  const { app } = await createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: { email: "someone@example.com", password: "whatever-1234" },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});
