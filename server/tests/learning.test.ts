import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReview,
  applySpelling,
  applyNewStudy,
  decideReviewGrade,
  selectDueQueue,
} from "../src/learningRules.ts";
import { createTestApp, sampleWord, seedUser, sessionCookie } from "./helpers.ts";
import type { TestContext } from "./helpers.ts";

const PASSWORD = "Correct-Horse-1949";

async function login(context: TestContext, email: string): Promise<string> {
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  return sessionCookie(response);
}

async function oneUser(): Promise<{ context: TestContext; cookie: string }> {
  const context = await createTestApp();
  await seedUser(context.repository, "learning@example.com", PASSWORD);
  return { context, cookie: await login(context, "learning@example.com") };
}

test("学习纯函数保持 localStore 的 grade、stage、score 和日期规则", () => {
  const base = {
    reviewStage: 3,
    recognitionScore: 3,
    spellingScore: 3,
    firstLearnedAt: null,
    lastReviewAt: "2026-09-18T00:00:00.000Z",
    nextReviewAt: "2026-09-19T00:00:00.000Z",
    lastRecognitionChoice: null,
    lastRecognitionResult: null,
    lastSpellingResult: null,
    lastGrade: null,
    reviewCount: 2,
    correctCount: 2,
    wrongCount: 0,
    updatedAt: "2026-09-18T00:00:00.000Z",
  } as const;
  const at = new Date("2026-09-19T00:00:00.000Z");
  assert.deepEqual(decideReviewGrade(base, { firstChoice: "known", hadError: false, attempts: 1 }, { input: "x", correct: true, hadError: false }), { grade: "easy", reviewStage: 5 });
  assert.equal(decideReviewGrade(base, { firstChoice: "unknown", hadError: true, attempts: 2 }, { input: "x", correct: true, hadError: false }).grade, "again");
  assert.equal(decideReviewGrade(base, { firstChoice: "known", hadError: false, attempts: 1 }, { input: "x", correct: true, hadError: true }).grade, "hard");
  assert.equal(applyReview(base, { firstChoice: "known", hadError: false, attempts: 1 }, { input: "x", correct: true, hadError: false }, at).state.nextReviewAt, "2026-10-19T00:00:00.000Z");
  assert.equal(applyNewStudy({ ...base, lastReviewAt: null }, at).nextReviewAt, "2026-09-20T00:00:00.000Z");
  assert.equal(applySpelling({ ...base, nextReviewAt: "2026-10-20T00:00:00.000Z" }, { input: "x", correct: true, hadError: true }, at).state.nextReviewAt, "2026-09-20T00:00:00.000Z");
});

test("到期队列先复习后新词，并按每日新词剩余额度限制", () => {
  const item = (id: string, learned: boolean, nextReviewAt: string) => ({ progress: { lastReviewAt: learned ? "2026-09-18T00:00:00.000Z" : null, nextReviewAt }, id });
  const queue = selectDueQueue([item("new", false, "2026-09-19T00:00:00.000Z"), item("review", true, "2026-09-20T00:00:00.000Z")], { learnedToday: 1, dailyNewLimit: 2, limit: 10 });
  assert.deepEqual(queue.reviewWords.map((entry) => entry.id), ["review"]);
  assert.deepEqual(queue.newWords.map((entry) => entry.id), ["new"]);
  assert.equal(queue.newLimit, 1);
});

test("设置按会话用户隔离，默认值和每日计划切换语义正确", async () => {
  const context = await createTestApp();
  await seedUser(context.repository, "alice@example.com", PASSWORD);
  await seedUser(context.repository, "bob@example.com", PASSWORD);
  const alice = await login(context, "alice@example.com");
  const bob = await login(context, "bob@example.com");
  try {
    const initial = await context.app.inject({ method: "GET", url: "/api/settings", headers: { cookie: alice } });
    assert.equal(initial.json().settings.dailyTarget, 20);
    const updated = await context.app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: alice }, payload: { dailyTarget: 30, dailyGroups: 3, dailyGroupWords: 4, timezone: "Asia/Shanghai", countdown: { label: "考试", targetDate: "2026-12-12" } } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().settings.dailyPlanConfigured, true);
    assert.equal(updated.json().settings.dailyGroups, 3);
    const bobSettings = await context.app.inject({ method: "GET", url: "/api/settings", headers: { cookie: bob } });
    assert.equal(bobSettings.json().settings.dailyTarget, 20);
    assert.equal(bobSettings.json().settings.dailyPlanConfigured, false);
  } finally { await context.app.close(); }
});

test("草稿按用户和 key 隔离，并拒绝旧 revision 覆盖", async () => {
  const context = await createTestApp();
  await seedUser(context.repository, "alice@example.com", PASSWORD);
  await seedUser(context.repository, "bob@example.com", PASSWORD);
  const alice = await login(context, "alice@example.com");
  const bob = await login(context, "bob@example.com");
  try {
    const first = await context.app.inject({ method: "PUT", url: "/api/review/draft", headers: { cookie: alice }, payload: { key: "daily", revision: 0, mode: "new", scope: "daily", phase: "learning", payload: { itemIds: ["w1"] } } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().draft.revision, 1);
    const conflict = await context.app.inject({ method: "PUT", url: "/api/review/draft", headers: { cookie: alice }, payload: { key: "daily", revision: 0, payload: { itemIds: ["stale"] } } });
    assert.equal(conflict.statusCode, 409);
    const bobRead = await context.app.inject({ method: "GET", url: "/api/review/draft?key=daily", headers: { cookie: bob } });
    assert.equal(bobRead.json().draft, null);
  } finally { await context.app.close(); }
});

async function importWords(context: TestContext, cookie: string, count = 1): Promise<Array<{ id: string; progress: { updatedAt: string; nextReviewAt: string } }>> {
  const words = Array.from({ length: count }, (_, index) => sampleWord({ word: `retain-${index}`, meaning: `释义${index}` }));
  const imported = await context.app.inject({ method: "POST", url: "/api/words/import", headers: { cookie }, payload: { words } });
  assert.equal(imported.statusCode, 200);
  const listed = await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie } });
  return listed.json().words;
}

test("新学完成写事件且 submissionKey 重试幂等，旧版本提交冲突", async () => {
  const { context, cookie } = await oneUser();
  try {
    const [word] = await importWords(context, cookie);
    const entry = { wordId: word.id, updatedAt: word.progress.updatedAt, nextReviewAt: word.progress.nextReviewAt };
    const first = await context.app.inject({ method: "POST", url: "/api/study/new/complete", headers: { cookie }, payload: { submissionKey: "new-submit-1", entries: [entry] } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().completed, 1);
    assert.equal(first.json().duplicate, false);
    assert.equal(context.repository.snapshotEvents("unused").length, 0);
    const retry = await context.app.inject({ method: "POST", url: "/api/study/new/complete", headers: { cookie }, payload: { submissionKey: "new-submit-1", entries: [entry] } });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().duplicate, true);
    assert.equal(retry.json().completed, 1);
    const after = (await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie } })).json().words[0];
    assert.ok(after.progress.firstLearnedAt);
    const events = (await context.app.inject({ method: "GET", url: "/api/events", headers: { cookie } })).json().events;
    assert.equal(events.length, 1);
    const stale = await context.app.inject({ method: "POST", url: "/api/review/complete", headers: { cookie }, payload: { submissionKey: "review-stale-1", entries: [{ ...entry, recognition: { firstChoice: "known", hadError: false, attempts: 1 }, spelling: { input: "retain-0", correct: true, hadError: false } }] } });
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.json().conflicts, 1);
    assert.equal(stale.json().completed, 0);
  } finally { await context.app.close(); }
});

test("学习提交严格按会话用户隔离，submissionKey 只在当前用户内幂等", async () => {
  const context = await createTestApp();
  await seedUser(context.repository, "alice-submit@example.com", PASSWORD);
  await seedUser(context.repository, "bob-submit@example.com", PASSWORD);
  const alice = await login(context, "alice-submit@example.com");
  const bob = await login(context, "bob-submit@example.com");
  try {
    const [aliceWord] = await importWords(context, alice);
    const [bobWord] = await importWords(context, bob);
    const aliceEntry = { wordId: aliceWord.id, updatedAt: aliceWord.progress.updatedAt, nextReviewAt: aliceWord.progress.nextReviewAt };
    const bobEntry = { wordId: bobWord.id, updatedAt: bobWord.progress.updatedAt, nextReviewAt: bobWord.progress.nextReviewAt };

    const aliceDone = await context.app.inject({
      method: "POST",
      url: "/api/study/new/complete",
      headers: { cookie: alice },
      payload: { submissionKey: "same-key", entries: [aliceEntry] },
    });
    assert.equal(aliceDone.statusCode, 200);
    assert.equal(aliceDone.json().completed, 1);
    assert.equal(aliceDone.json().duplicate, false);

    // Bob may use the same idempotency key, but it must be a separate submission.
    const bobDone = await context.app.inject({
      method: "POST",
      url: "/api/study/new/complete",
      headers: { cookie: bob },
      payload: { submissionKey: "same-key", entries: [bobEntry] },
    });
    assert.equal(bobDone.statusCode, 200);
    assert.equal(bobDone.json().completed, 1);
    assert.equal(bobDone.json().duplicate, false);

    // A known Alice word ID submitted by Bob is ignored and cannot mutate Alice's progress.
    const crossUser = await context.app.inject({
      method: "POST",
      url: "/api/review/complete",
      headers: { cookie: bob },
      payload: {
        submissionKey: "bob-cross-user",
        entries: [{
          ...aliceEntry,
          recognition: { firstChoice: "known", hadError: false, attempts: 1 },
          spelling: { input: "retain-0", correct: true, hadError: false },
        }],
      },
    });
    assert.equal(crossUser.statusCode, 200);
    assert.equal(crossUser.json().completed, 0);
    assert.equal(crossUser.json().skipped, 1);
    assert.equal(crossUser.json().results[0].reason, "not_found");

    const aliceAfter = (await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: alice } })).json().words;
    const bobAfter = (await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie: bob } })).json().words;
    assert.ok(aliceAfter[0].progress.firstLearnedAt);
    assert.ok(bobAfter[0].progress.firstLearnedAt);
    assert.equal((await context.app.inject({ method: "GET", url: "/api/events", headers: { cookie: alice } })).json().total, 1);
    assert.equal((await context.app.inject({ method: "GET", url: "/api/events", headers: { cookie: bob } })).json().total, 1);
    assert.deepEqual(context.repository.snapshotSubmissions("missing-user"), []);
  } finally { await context.app.close(); }
});

test("复习、独立拼写和事务失败分别保持规则与原子性", async () => {
  const { context, cookie } = await oneUser();
  try {
    const words = await importWords(context, cookie, 2);
    const newEntry = (word: typeof words[number]) => ({ wordId: word.id, updatedAt: word.progress.updatedAt, nextReviewAt: word.progress.nextReviewAt });
    const newDone = await context.app.inject({ method: "POST", url: "/api/study/new/complete", headers: { cookie }, payload: { submissionKey: "new-submit-2", entries: words.map(newEntry) } });
    assert.equal(newDone.json().completed, 2);
    const reviewed = (await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie } })).json().words;
    const reviewEntry = { wordId: reviewed[0].id, updatedAt: reviewed[0].progress.updatedAt, nextReviewAt: reviewed[0].progress.nextReviewAt, recognition: { firstChoice: "known", hadError: false, attempts: 1 }, spelling: { input: reviewed[0].word, correct: true, hadError: false } };
    const review = await context.app.inject({ method: "POST", url: "/api/review/complete", headers: { cookie }, payload: { submissionKey: "review-submit-1", entries: [reviewEntry] } });
    assert.equal(review.json().completed, 1);
    assert.equal(review.json().grades.good, 1);
    const current = (await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie } })).json().words.find((item: { id: string }) => item.id === reviewed[0].id);
    const dishonest = await context.app.inject({ method: "POST", url: "/api/spelling/complete", headers: { cookie }, payload: { submissionKey: "spell-fake-1", entries: [{ wordId: current.id, updatedAt: current.progress.updatedAt, nextReviewAt: current.progress.nextReviewAt, spelling: { input: "wrong-answer", correct: true, hadError: false } }] } });
    assert.equal(dishonest.statusCode, 200);
    assert.equal(dishonest.json().completed, 0);
    assert.equal(dishonest.json().skipped, 1);

    const spelling = await context.app.inject({ method: "POST", url: "/api/spelling/complete", headers: { cookie }, payload: { submissionKey: "spell-submit-1", entries: [{ wordId: current.id, updatedAt: current.progress.updatedAt, nextReviewAt: current.progress.nextReviewAt, spelling: { input: current.word, correct: true, hadError: true } }] } });
    assert.equal(spelling.json().completed, 1);
    assert.equal(spelling.json().corrected, 1);

    const before = (await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie } })).json().words;
    context.repository.setCompletionFailureAfter(1);
    const failed = await context.app.inject({ method: "POST", url: "/api/review/complete", headers: { cookie }, payload: { submissionKey: "review-fails-1", entries: before.map((word: any) => ({ wordId: word.id, updatedAt: word.progress.updatedAt, nextReviewAt: word.progress.nextReviewAt, recognition: { firstChoice: "known", hadError: false, attempts: 1 }, spelling: { input: word.word, correct: true, hadError: false } })) } });
    assert.equal(failed.statusCode, 500);
    const after = (await context.app.inject({ method: "GET", url: "/api/words", headers: { cookie } })).json().words;
    assert.deepEqual(after.map((word: any) => [word.id, word.progress.updatedAt]), before.map((word: any) => [word.id, word.progress.updatedAt]));
    assert.equal(context.repository.snapshotSubmissions("missing-user").length, 0);
  } finally { await context.app.close(); }
});
