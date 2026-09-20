import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_MAX_WORDS,
  emailSchema,
  importBodySchema,
  listWordsQuerySchema,
  loginBodySchema,
  mergeWordFields,
  progressScoreSchema,
  progressStageSchema,
  updateWordBodySchema,
  wordInputSchema,
} from "../src/schemas.ts";

test("邮箱规范化：去空格并转小写", () => {
  assert.equal(emailSchema.parse("  Someone@Example.COM "), "someone@example.com");
});

test("非法邮箱必须拒绝", () => {
  for (const value of ["", "no-at-sign", "a b@example.com", "@example.com", "a@b"]) {
    assert.equal(emailSchema.safeParse(value).success, false, `应拒绝：${value}`);
  }
});

test("单词规范化与 localStore 一致（trim + 小写），其它字段去空格", () => {
  const parsed = wordInputSchema.parse({
    word: "  Retain  ",
    phonetic: " /rɪˈteɪn/ ",
    meaning: " v. 保留 ",
    source: " 测试 ",
  });
  assert.equal(parsed.word, "retain");
  assert.equal(parsed.normalizedWord, "retain");
  assert.equal(parsed.phonetic, "/rɪˈteɪn/");
  assert.equal(parsed.meaning, "v. 保留");
  assert.equal(parsed.source, "测试");
  assert.equal(parsed.type, "added");
});

test("单词为空或只有空白必须拒绝", () => {
  assert.equal(wordInputSchema.safeParse({ word: "" }).success, false);
  assert.equal(wordInputSchema.safeParse({ word: "   " }).success, false);
});

test("type 只接受 marked / added", () => {
  assert.equal(wordInputSchema.parse({ word: "retain", type: "marked" }).type, "marked");
  assert.equal(wordInputSchema.safeParse({ word: "retain", type: "unknown" }).success, false);
});

test("导入请求体拒绝额外的 userId 字段", () => {
  const parsed = importBodySchema.safeParse({ words: [{ word: "retain" }], userId: "someone-else" });
  assert.equal(parsed.success, false);
});

test("导入请求体要有内容且不超过上限", () => {
  assert.equal(importBodySchema.safeParse({ words: [] }).success, false);
  const tooMany = Array.from({ length: IMPORT_MAX_WORDS + 1 }, () => ({ word: "retain" }));
  assert.equal(importBodySchema.safeParse({ words: tooMany }).success, false);
  assert.equal(importBodySchema.safeParse({ words: [{ word: "retain" }] }).success, true);
});

test("列表查询拒绝 userId 参数，并给出受控分页默认值", () => {
  assert.equal(listWordsQuerySchema.safeParse({ userId: "other-user" }).success, false);
  assert.deepEqual(listWordsQuerySchema.parse({}), { limit: 50, offset: 0 });
  assert.deepEqual(listWordsQuerySchema.parse({ limit: "10", offset: "20" }), { limit: 10, offset: 20 });
  assert.equal(listWordsQuerySchema.safeParse({ limit: "1000" }).success, false);
  assert.equal(listWordsQuerySchema.safeParse({ offset: "-1" }).success, false);
});

test("登录请求体拒绝额外字段", () => {
  assert.equal(
    loginBodySchema.safeParse({ email: "a@example.com", password: "x", userId: "u" }).success,
    false,
  );
  assert.equal(loginBodySchema.safeParse({ email: "A@Example.com", password: "x" }).success, true);
});

test("进度边界值固定为 0—6 / 0—5", () => {
  for (const value of [0, 3, 6]) assert.equal(progressStageSchema.safeParse(value).success, true);
  for (const value of [-1, 7, 2.5]) assert.equal(progressStageSchema.safeParse(value).success, false);
  for (const value of [0, 5]) assert.equal(progressScoreSchema.safeParse(value).success, true);
  for (const value of [-1, 6, 1.5]) assert.equal(progressScoreSchema.safeParse(value).success, false);
});

test("更新词条只接受音标和释义，并沿用前端的音标格式", () => {
  assert.deepEqual(updateWordBodySchema.parse({ phonetic: " /retain/ " }), { phonetic: "/retain/", meaning: undefined });
  assert.equal(updateWordBodySchema.safeParse({}).success, false);
  assert.equal(updateWordBodySchema.safeParse({ phonetic: "retain" }).success, false);
  assert.equal(updateWordBodySchema.safeParse({ meaning: "   " }).success, false);
  assert.equal(updateWordBodySchema.safeParse({ phonetic: "/re/", word: "retain" }).success, false);
});

test("mergeWordFields 与 localStore.importWords 的合并规则一致", () => {
  const existing = {
    phonetic: "/old/",
    meaning: "旧释义",
    phrase: "old phrase",
    sentence: "old sentence",
    sentenceCn: "旧例句",
    source: "旧来源",
    type: "added" as const,
  };
  const merged = mergeWordFields(existing, {
    phonetic: "",
    meaning: "新释义",
    phrase: "",
    sentence: "",
    sentenceCn: "",
    source: "",
    type: "marked",
  });
  assert.equal(merged.phonetic, "/old/");
  assert.equal(merged.meaning, "新释义");
  assert.equal(merged.phrase, "old phrase");
  assert.equal(merged.type, "marked");

  const keptMarked = mergeWordFields({ ...existing, type: "marked" as const }, {
    ...existing,
    type: "added" as const,
  });
  assert.equal(keptMarked.type, "marked");
});
