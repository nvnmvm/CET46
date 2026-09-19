import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { hashPassword } from "../src/auth.ts";
import { createPool } from "../src/db.ts";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { newId } from "../src/ids.ts";
import { createMysqlRepository } from "../src/repository.mysql.ts";
import { sessionCookie } from "./helpers.ts";

const enabled = process.env.RUN_MYSQL_TESTS === "1";
const password = "Correct-Horse-1949";
const secret = "mysql-integration-session-secret-0123456789";

function integrationConfig(): AppConfig {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`缺少真实 MySQL 集成测试变量：${name}`);
    return value;
  };

  return loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: secret,
    MYSQL_HOST: required("MYSQL_HOST"),
    MYSQL_PORT: process.env.MYSQL_PORT ?? "3306",
    MYSQL_DATABASE: required("MYSQL_DATABASE"),
    MYSQL_USER: required("MYSQL_USER"),
    MYSQL_PASSWORD: required("MYSQL_PASSWORD"),
  });
}

test(
  "真实 MySQL repository：迁移后的 SQL、用户隔离、草稿、幂等和学习提交",
  { skip: !enabled },
  async () => {
    const config = integrationConfig();
    assert.ok(config.database, "集成测试必须有数据库配置");
    const pool = createPool(config.database, { connectionLimit: 4 });
    const repository = createMysqlRepository(pool);
    const app = buildApp({ config, repository });
    const userId = newId("mysqltest");
    const email = `${userId}@example.test`;

    try {
      const [columns] = await pool.execute<
        (RowDataPacket & { table_name: string; column_name: string })[]
      >(
        `SELECT
           TABLE_NAME AS table_name,
           COLUMN_NAME AS column_name
         FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'user_settings'
           AND column_name = 'daily_plan_configured'`,
      );
      assert.equal(columns.length, 1);

      const [workflowTables] = await pool.execute<
        (RowDataPacket & { table_name: string })[]
      >(
        `SELECT TABLE_NAME AS table_name
         FROM information_schema.tables
         WHERE table_schema = DATABASE()
           AND table_name IN ('review_drafts', 'review_submissions')`,
      );
      assert.deepEqual(
        workflowTables.map((row) => row.table_name).sort(),
        ["review_drafts", "review_submissions"],
      );

      await repository.createUser({
        id: userId,
        email,
        passwordHash: await hashPassword(password),
      });
      await app.ready();

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password },
      });
      assert.equal(login.statusCode, 200);
      const cookie = sessionCookie(login);

      const initialSettings = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { cookie },
      });
      assert.equal(initialSettings.statusCode, 200);
      assert.equal(initialSettings.json().settings.dailyPlanConfigured, false);

      const updatedSettings = await app.inject({
        method: "PATCH",
        url: "/api/settings",
        headers: { cookie },
        payload: {
          dailyTarget: 30,
          dailyGroups: 3,
          dailyGroupWords: 4,
          timezone: "Asia/Shanghai",
          countdown: { label: "考试", targetDate: "2026-12-12" },
        },
      });
      assert.equal(updatedSettings.statusCode, 200);
      assert.equal(updatedSettings.json().settings.dailyPlanConfigured, true);
      assert.equal(updatedSettings.json().settings.dailyGroups, 3);
      assert.deepEqual(updatedSettings.json().settings.countdown, { label: "考试", targetDate: "2026-12-12" });

      const firstDraft = await app.inject({
        method: "PUT",
        url: "/api/review/draft",
        headers: { cookie },
        payload: {
          key: "mysql-daily",
          revision: 0,
          mode: "new",
          scope: "daily",
          phase: "learning",
          payload: { itemIds: ["pending"] },
        },
      });
      assert.equal(firstDraft.statusCode, 200);
      assert.equal(firstDraft.json().draft.revision, 1);

      const staleDraft = await app.inject({
        method: "PUT",
        url: "/api/review/draft",
        headers: { cookie },
        payload: {
          key: "mysql-daily",
          revision: 0,
          payload: { itemIds: ["stale"] },
        },
      });
      assert.equal(staleDraft.statusCode, 409);

      const imported = await app.inject({
        method: "POST",
        url: "/api/words/import",
        headers: { cookie },
        payload: {
          words: [
            { word: "mysql-retain", phonetic: "/rɪˈteɪn/", meaning: "保留", type: "marked" },
            { word: "mysql-revise", phonetic: "/rɪˈvaɪz/", meaning: "复习", type: "added" },
          ],
        },
      });
      assert.equal(imported.statusCode, 200);

      const listed = await app.inject({
        method: "GET",
        url: "/api/words",
        headers: { cookie },
      });
      assert.equal(listed.statusCode, 200);
      const words = listed.json().words as Array<{
        id: string;
        word: string;
        progress: { updatedAt: string; nextReviewAt: string };
      }>;
      assert.equal(words.length, 2);

      const newEntries = words.map((word) => ({
        wordId: word.id,
        updatedAt: word.progress.updatedAt,
        nextReviewAt: word.progress.nextReviewAt,
      }));
      const newCompletion = await app.inject({
        method: "POST",
        url: "/api/study/new/complete",
        headers: { cookie },
        payload: { submissionKey: "mysql-new-001", entries: newEntries },
      });
      assert.equal(newCompletion.statusCode, 200);
      assert.equal(newCompletion.json().completed, 2);

      const duplicateCompletion = await app.inject({
        method: "POST",
        url: "/api/study/new/complete",
        headers: { cookie },
        payload: { submissionKey: "mysql-new-001", entries: newEntries },
      });
      assert.equal(duplicateCompletion.statusCode, 200);
      assert.equal(duplicateCompletion.json().duplicate, true);
      assert.equal(duplicateCompletion.json().completed, 2);

      const afterNew = (await app.inject({
        method: "GET",
        url: "/api/words",
        headers: { cookie },
      })).json().words as typeof words;
      const target = afterNew[0];
      assert.ok(target);

      const dishonestSpelling = await app.inject({
        method: "POST",
        url: "/api/spelling/complete",
        headers: { cookie },
        payload: {
          submissionKey: "mysql-spell-001",
          entries: [{
            wordId: target.id,
            updatedAt: target.progress.updatedAt,
            nextReviewAt: target.progress.nextReviewAt,
            spelling: { input: "definitely-wrong", correct: true, hadError: false },
          }],
        },
      });
      assert.equal(dishonestSpelling.statusCode, 200);
      assert.equal(dishonestSpelling.json().completed, 0);
      assert.equal(dishonestSpelling.json().skipped, 1);

      const current = (await app.inject({
        method: "GET",
        url: "/api/words",
        headers: { cookie },
      })).json().words.find((word: typeof target) => word.id === target.id) as typeof target;
      const spelling = await app.inject({
        method: "POST",
        url: "/api/spelling/complete",
        headers: { cookie },
        payload: {
          submissionKey: "mysql-spell-002",
          entries: [{
            wordId: current.id,
            updatedAt: current.progress.updatedAt,
            nextReviewAt: current.progress.nextReviewAt,
            spelling: { input: current.word, correct: true, hadError: true },
          }],
        },
      });
      assert.equal(spelling.statusCode, 200);
      assert.equal(spelling.json().completed, 1);
      assert.equal(spelling.json().corrected, 1);

      const afterSpelling = (await app.inject({
        method: "GET",
        url: "/api/words",
        headers: { cookie },
      })).json().words.find((word: typeof target) => word.id === target.id) as typeof target;
      const review = await app.inject({
        method: "POST",
        url: "/api/review/complete",
        headers: { cookie },
        payload: {
          submissionKey: "mysql-review-001",
          entries: [{
            wordId: afterSpelling.id,
            updatedAt: afterSpelling.progress.updatedAt,
            nextReviewAt: afterSpelling.progress.nextReviewAt,
            recognition: { firstChoice: "known", hadError: false, attempts: 1 },
            spelling: { input: afterSpelling.word, correct: true, hadError: false },
          }],
        },
      });
      assert.equal(review.statusCode, 200);
      assert.equal(review.json().completed, 1);
      assert.equal(review.json().grades.good, 1);

      const events = await app.inject({
        method: "GET",
        url: "/api/events",
        headers: { cookie },
      });
      assert.equal(events.statusCode, 200);
      assert.equal(events.json().total, 3);
    } finally {
      await app.close();
      await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
      await repository.close();
    }
  },
);
