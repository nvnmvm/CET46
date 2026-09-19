import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { hashPassword } from "../src/auth.ts";
import { loadConfig, SESSION_COOKIE_NAME } from "../src/config.ts";
import type { AppConfig } from "../src/config.ts";
import { newId } from "../src/ids.ts";
import { createFakeRepository } from "../src/testing/fakeRepository.ts";
import type { FakeRepository } from "../src/testing/fakeRepository.ts";
import type { UserRecord } from "../src/repository.ts";

/**
 * 测试公共装置：一律使用注入的 fake repository —— 本文件不连接任何数据库。
 */

export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: "test", SESSION_SECRET: TEST_SESSION_SECRET, ...overrides });
}

export type TestContext = {
  app: FastifyInstance;
  repository: FakeRepository;
  config: AppConfig;
};

export async function createTestApp(
  options: { ready?: boolean; configOverrides?: Record<string, string> } = {},
): Promise<TestContext> {
  const repository = createFakeRepository({ ready: options.ready ?? true });
  const config = testConfig(options.configOverrides);
  const app = buildApp({ config, repository });
  await app.ready();
  return { app, repository, config };
}

export async function seedUser(
  repository: FakeRepository,
  email: string,
  password: string,
): Promise<UserRecord> {
  return repository.seedUser({
    id: newId("user"),
    email,
    passwordHash: await hashPassword(password),
  });
}

export function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") throw new Error("响应没有下发 Set-Cookie。");
  return raw.split(";")[0] ?? "";
}

export function cookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function sampleWord(overrides: Record<string, unknown> = {}) {
  return {
    word: "retain",
    phonetic: "/rɪˈteɪn/",
    meaning: "v. 保留",
    phrase: "",
    sentence: "",
    sentenceCn: "",
    source: "测试",
    type: "marked",
    ...overrides,
  };
}
