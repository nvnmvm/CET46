import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, SESSION_TTL_SECONDS, loadConfig } from "../src/config.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

test("测试环境的最小配置可以解析，并且允许没有数据库", () => {
  const config = loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET });
  assert.equal(config.nodeEnv, "test");
  assert.equal(config.apiPort, 3000);
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.cookieSecure, false);
  assert.equal(config.sessionTtlSeconds, SESSION_TTL_SECONDS);
  assert.equal(config.database, null);
  assert.equal(config.migrationDatabase, null);
});

test("缺少或过短的 SESSION_SECRET 必须失败", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "test" }), ConfigError);
  assert.throws(
    () => loadConfig({ NODE_ENV: "test", SESSION_SECRET: "too-short" }),
    /至少需要 32 个字符/,
  );
});

test("非法端口必须失败", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, API_PORT: "70000" }), ConfigError);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, API_PORT: "abc" }), ConfigError);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, API_PORT: "0" }), ConfigError);
});

test("API 仅允许回环或容器内绑定地址", () => {
  assert.equal(
    loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, API_HOST: "0.0.0.0" }).apiHost,
    "0.0.0.0",
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, API_HOST: "192.168.1.10" }),
    ConfigError,
  );
});

test("非法 Cookie 配置必须失败", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, COOKIE_SECURE: "yes" }),
    ConfigError,
  );
});

test("非法 APP_ORIGIN 必须失败", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, APP_ORIGIN: "localhost:4173" }),
    /APP_ORIGIN/,
  );
});

test("生产环境必须开启 Secure Cookie", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        SESSION_SECRET: SECRET,
        COOKIE_SECURE: "false",
        MYSQL_HOST: "127.0.0.1",
        MYSQL_DATABASE: "cet_words",
        MYSQL_USER: "app",
        MYSQL_PASSWORD: "placeholder",
      }),
    /COOKIE_SECURE/,
  );

  const config = loadConfig({
    NODE_ENV: "production",
    SESSION_SECRET: SECRET,
    COOKIE_SECURE: "true",
    MYSQL_HOST: "127.0.0.1",
    MYSQL_DATABASE: "cet_words",
    MYSQL_USER: "app",
    MYSQL_PASSWORD: "placeholder",
  });
  assert.equal(config.isProduction, true);
  assert.equal(config.cookieSecure, true);
  assert.equal(config.database?.database, "cet_words");
});

test("非测试环境缺少数据库配置必须失败，且只报变量名", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "development", SESSION_SECRET: SECRET }),
    /缺少数据库配置：MYSQL_HOST、MYSQL_DATABASE、MYSQL_USER、MYSQL_PASSWORD/,
  );
});

test("秘密变量使用 VITE_ 前缀必须失败", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "test", SESSION_SECRET: SECRET, VITE_MYSQL_PASSWORD: "leak" }),
    /VITE_/,
  );
});

test("配置报错信息不得包含秘密值", () => {
  try {
    loadConfig({ NODE_ENV: "development", SESSION_SECRET: SECRET, MYSQL_PASSWORD: "super-secret-value" });
    assert.fail("缺少数据库主机时应当报错");
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    assert.equal(message.includes(SECRET), false);
    assert.equal(message.includes("super-secret-value"), false);
  }
});

test("迁移账号只在显式提供时才存在", () => {
  const base = {
    NODE_ENV: "development",
    SESSION_SECRET: SECRET,
    MYSQL_HOST: "127.0.0.1",
    MYSQL_DATABASE: "cet_words",
    MYSQL_USER: "app",
    MYSQL_PASSWORD: "placeholder",
  };
  assert.equal(loadConfig(base).migrationDatabase, null);
  const config = loadConfig({
    ...base,
    MYSQL_MIGRATION_USER: "migrator",
    MYSQL_MIGRATION_PASSWORD: "placeholder2",
  });
  assert.equal(config.migrationDatabase?.user, "migrator");
});
