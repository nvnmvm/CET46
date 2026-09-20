import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, sampleWord, seedUser, sessionCookie } from "./helpers.ts";
import type { TestContext } from "./helpers.ts";

const PASSWORD = "Correct-Horse-1949";

async function loginAs(context: TestContext, email: string): Promise<string> {
  const login = await context.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, `登录失败：${email}`);
  return sessionCookie(login);
}

async function twoUsers(): Promise<{ context: TestContext; alice: string; bob: string }> {
  const context = await createTestApp();
  await seedUser(context.repository, "alice@example.com", PASSWORD);
  await seedUser(context.repository, "bob@example.com", PASSWORD);
  const alice = await loginAs(context, "alice@example.com");
  const bob = await loginAs(context, "bob@example.com");
  return { context, alice, bob };
}

test("未登录时词库接口一律 401", async () => {
  const { context } = await twoUsers();
  try {
    const requests = [
      { method: "GET" as const, url: "/api/words" },
      { method: "POST" as const, url: "/api/words/import", payload: { words: [sampleWord()] } },
      { method: "PATCH" as const, url: "/api/words/word_x", payload: { meaning: "新" } },
      { method: "DELETE" as const, url: "/api/words/word_x" },
      { method: "POST" as const, url: "/api/words/word_x/kill" },
      { method: "POST" as const, url: "/api/words/word_x/restore" },
      { method: "POST" as const, url: "/api/words/word_x/undo-kill" },
    ];
    for (const request of requests) {
      const response = await context.app.inject(request);
      assert.equal(response.statusCode, 401, `${request.method} ${request.url} 应要求登录`);
    }
  } finally {
    await context.app.close();
  }
});

test("列表只包含当前会话用户的词条", async () => {
  const { context, alice, bob } = await twoUsers();
  try {
    const aliceImport = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord()] },
    });
    assert.deepEqual(aliceImport.json(), { added: 1, existing: 0, total: 1 });

    await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: bob },
      payload: { words: [sampleWord({ word: "allocate", meaning: "v. 分配" })] },
    });

    const aliceList = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    assert.deepEqual(aliceList.json().words.map((word: { word: string }) => word.word), ["retain"]);
    assert.equal(aliceList.json().total, 1);

    const bobList = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: bob } });
    assert.deepEqual(bobList.json().words.map((word: { word: string }) => word.word), ["allocate"]);
  } finally {
    await context.app.close();
  }
});

test("响应不回传 userId，服务端会话才是身份来源", async () => {
  const { context, alice } = await twoUsers();
  try {
    await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord()] },
    });
    const listed = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    const [word] = listed.json().words;
    assert.equal(Object.hasOwn(word, "userId"), false);
    assert.equal(Object.hasOwn(word.progress, "userId"), false);
  } finally {
    await context.app.close();
  }
});

test("重复导入幂等：不重复建词，也不重置已有进度", async () => {
  const { context, alice } = await twoUsers();
  try {
    const first = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord()] },
    });
    assert.deepEqual(first.json(), { added: 1, existing: 0, total: 1 });

    const listed = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    const wordId = listed.json().words[0].id;

    // 先制造“已有进度”：kill 之后 killedAt 不应被重复导入清掉。
    const killed = await context.app.inject({
      method: "POST",
      url: `/api/words/${wordId}/kill`,
      headers: { cookie: alice },
    });
    assert.equal(killed.statusCode, 200);
    const killedAt = killed.json().progress.killedAt;
    assert.ok(killedAt);

    // 大小写不同、内容更完整，仍应命中同一个词。
    const second = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord({ word: "RETAIN", meaning: "v. 保留；保持", sentence: "Retain control." })] },
    });
    assert.deepEqual(second.json(), { added: 0, existing: 1, total: 1 });

    const afterListing = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    assert.equal(afterListing.json().words.length, 1);
    const [word] = afterListing.json().words;
    assert.equal(word.word, "retain");
    assert.equal(word.meaning, "v. 保留；保持");
    assert.equal(word.progress.killedAt, killedAt, "重复导入不得重置进度");
  } finally {
    await context.app.close();
  }
});

test("同一批次里的重复词条也只建一条记录", async () => {
  const { context, alice } = await twoUsers();
  try {
    const response = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord(), sampleWord({ word: " retain " })] },
    });
    assert.deepEqual(response.json(), { added: 1, existing: 1, total: 1 });
  } finally {
    await context.app.close();
  }
});

test("不能读写他人的词条：一律 404，不泄露存在性", async () => {
  const { context, alice, bob } = await twoUsers();
  try {
    await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord()] },
    });
    const listed = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    const aliceWordId = listed.json().words[0].id;

    const attempts = [
      { method: "PATCH" as const, url: `/api/words/${aliceWordId}`, payload: { meaning: "越权修改" } },
      { method: "DELETE" as const, url: `/api/words/${aliceWordId}` },
      { method: "POST" as const, url: `/api/words/${aliceWordId}/kill` },
      { method: "POST" as const, url: `/api/words/${aliceWordId}/restore` },
      { method: "POST" as const, url: `/api/words/${aliceWordId}/undo-kill` },
    ];
    for (const attempt of attempts) {
      const response = await context.app.inject({ ...attempt, headers: { cookie: bob } });
      assert.equal(response.statusCode, 404, `Bob 不应能访问 Alice 的词条：${attempt.method} ${attempt.url}`);
      assert.deepEqual(response.json(), { error: { code: "not_found", message: "词条不存在" } });
    }

    // Alice 的数据没有被动过。
    const aliceList = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    assert.equal(aliceList.json().words.length, 1);
    assert.equal(aliceList.json().words[0].meaning, "v. 保留");
    assert.equal(aliceList.json().words[0].progress.killedAt, null);

    // 他人的词条 ID 与不存在的 ID 响应完全一致。
    const missing = await context.app.inject({
      method: "DELETE",
      url: "/api/words/word_does_not_exist",
      headers: { cookie: bob },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await context.app.close();
  }
});

test("请求体或查询串里的 userId 不参与授权，且会被直接拒绝", async () => {
  const { context, alice, bob } = await twoUsers();
  try {
    const importWithUserId = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: bob },
      payload: { words: [sampleWord()], userId: "user_someone_else" },
    });
    assert.equal(importWithUserId.statusCode, 400);

    const listWithUserId = await context.app.inject({
      method: "GET",
      url: "/api/words?userId=user_someone_else",
      headers: { cookie: bob },
    });
    assert.equal(listWithUserId.statusCode, 400);

    // 词条对象里的 userId 会被忽略，记录仍归属当前会话用户。
    const sneaky = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: bob },
      payload: { words: [{ ...sampleWord(), userId: "user_alice" }] },
    });
    assert.equal(sneaky.statusCode, 200);
    const aliceList = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    assert.equal(aliceList.json().total, 0, "Alice 不应看到 Bob 导入的词");
    const bobList = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: bob } });
    assert.equal(bobList.json().total, 1);
  } finally {
    await context.app.close();
  }
});

test("PATCH 只更新音标和释义，并沿用音标格式校验", async () => {
  const { context, alice } = await twoUsers();
  try {
    await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord()] },
    });
    const listed = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    const wordId = listed.json().words[0].id;

    const updated = await context.app.inject({
      method: "PATCH",
      url: `/api/words/${wordId}`,
      headers: { cookie: alice },
      payload: { phonetic: "/rɪˈteɪn/", meaning: "v. 保留；留住" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().word.meaning, "v. 保留；留住");

    const badPhonetic = await context.app.inject({
      method: "PATCH",
      url: `/api/words/${wordId}`,
      headers: { cookie: alice },
      payload: { phonetic: "retain" },
    });
    assert.equal(badPhonetic.statusCode, 400);

    const extraField = await context.app.inject({
      method: "PATCH",
      url: `/api/words/${wordId}`,
      headers: { cookie: alice },
      payload: { meaning: "新释义", word: "hacked" },
    });
    assert.equal(extraField.statusCode, 400);
  } finally {
    await context.app.close();
  }
});

test("删除是幂等的，重复删除返回 404 且不动别人的记录", async () => {
  const { context, alice, bob } = await twoUsers();
  try {
    for (const [cookie, word] of [
      [alice, sampleWord()],
      [bob, sampleWord({ word: "allocate" })],
    ] as const) {
      await context.app.inject({
        method: "POST",
        url: "/api/words/import",
        headers: { cookie },
        payload: { words: [word] },
      });
    }
    const aliceList = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    const wordId = aliceList.json().words[0].id;

    const first = await context.app.inject({
      method: "DELETE",
      url: `/api/words/${wordId}`,
      headers: { cookie: alice },
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { ok: true, deleted: true });

    const second = await context.app.inject({
      method: "DELETE",
      url: `/api/words/${wordId}`,
      headers: { cookie: alice },
    });
    assert.equal(second.statusCode, 404);

    const bobList = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: bob } });
    assert.equal(bobList.json().total, 1);
  } finally {
    await context.app.close();
  }
});

test("kill / restore / undo-kill 保持现有语义", async () => {
  const { context, alice } = await twoUsers();
  try {
    await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord()] },
    });
    const listed = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } });
    const wordId = listed.json().words[0].id;

    const killed = await context.app.inject({
      method: "POST",
      url: `/api/words/${wordId}/kill`,
      headers: { cookie: alice },
    });
    assert.equal(killed.statusCode, 200);
    assert.ok(killed.json().progress.killedAt);
    assert.equal(killed.json().progress.reviewStage, 0);

    const undone = await context.app.inject({
      method: "POST",
      url: `/api/words/${wordId}/undo-kill`,
      headers: { cookie: alice },
    });
    assert.equal(undone.json().progress.killedAt, null);
    assert.equal(undone.json().progress.lastRestoredAt, null, "undo-kill 不写 lastRestoredAt");

    await context.app.inject({ method: "POST", url: `/api/words/${wordId}/kill`, headers: { cookie: alice } });
    const restored = await context.app.inject({
      method: "POST",
      url: `/api/words/${wordId}/restore`,
      headers: { cookie: alice },
    });
    assert.equal(restored.json().progress.killedAt, null);
    assert.ok(restored.json().progress.lastRestoredAt);
    assert.equal(restored.json().progress.reviewStage, 0);

    const unknown = await context.app.inject({
      method: "POST",
      url: "/api/words/word_unknown/kill",
      headers: { cookie: alice },
    });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await context.app.close();
  }
});

test("词库列表支持有限分页", async () => {
  const { context, alice } = await twoUsers();
  try {
    const words = Array.from({ length: 5 }, (_, index) =>
      sampleWord({ word: `word${String(index).padStart(2, "0")}` }),
    );
    await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words },
    });

    const page = await context.app.inject({
      method: "GET",
      url: "/api/words?limit=2&offset=1",
      headers: { cookie: alice },
    });
    const body = page.json();
    assert.equal(body.total, 5);
    assert.equal(body.limit, 2);
    assert.equal(body.offset, 1);
    assert.deepEqual(body.words.map((word: { word: string }) => word.word), ["word01", "word02"]);

    const tooLarge = await context.app.inject({
      method: "GET",
      url: "/api/words?limit=500",
      headers: { cookie: alice },
    });
    assert.equal(tooLarge.statusCode, 400);
  } finally {
    await context.app.close();
  }
});

test("导入请求体非法（空数组、坏 type）返回 400", async () => {
  const { context, alice } = await twoUsers();
  try {
    const empty = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [] },
    });
    assert.equal(empty.statusCode, 400);

    const badType = await context.app.inject({
      method: "POST",
      url: "/api/words/import",
      headers: { cookie: alice },
      payload: { words: [sampleWord({ type: "unknown" })] },
    });
    assert.equal(badType.statusCode, 400);
  } finally {
    await context.app.close();
  }
});
