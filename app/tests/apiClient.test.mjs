import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, DEFAULT_DRAFT_KEY, createApiClient } from '../src/data/apiClient.ts';

const BASE_URL = 'https://api.example.test';

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status, body) {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

function parseBody(init) {
  if (init?.body === undefined) return undefined;
  return JSON.parse(init.body);
}

/** 队列式 fake fetch：按调用顺序返回响应，并记录每次 URL / init / body。 */
function createClient(responses = []) {
  const queue = [...responses];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: parseBody(init) });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });
  return { client, calls };
}

test('profile uses the authenticated account endpoints and never sends identity fields', async () => {
  const { client, calls } = createClient([
    jsonResponse(200, { user: { id: 'u1', email: 'learner@example.com', username: '学习者', avatar: '✦' } }),
    jsonResponse(200, { user: { id: 'u1', email: 'learner@example.com', username: '新昵称', avatar: null } }),
  ]);

  const current = await client.getProfile();
  const updated = await client.updateProfile({ username: '新昵称', avatar: null });

  assert.equal(current.username, '学习者');
  assert.equal(updated.avatar, undefined);
  assert.equal(calls[0].url, `${BASE_URL}/api/account/profile`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(calls[1].body, { username: '新昵称', avatar: null });
  assert.equal(JSON.stringify(calls[1].body).includes('userId'), false);
  assert.equal(calls[1].init.credentials, 'include');
});

function serverWord(overrides = {}) {
  return {
    id: 'w1',
    word: 'retain',
    normalizedWord: 'retain',
    phonetic: '/rɪˈteɪn/',
    meaning: 'v. 保留',
    phrase: '',
    sentence: '',
    sentenceCn: '',
    source: '测试',
    type: 'marked',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    progress: {
      id: 'p1',
      wordId: 'w1',
      reviewStage: 2,
      recognitionScore: 3,
      spellingScore: 4,
      firstLearnedAt: null,
      nextReviewAt: '2026-09-20T00:00:00.000Z',
      lastReviewAt: null,
      lastRecognitionChoice: null,
      lastRecognitionResult: null,
      lastSpellingResult: null,
      lastGrade: null,
      killedAt: null,
      lastRestoredAt: null,
      reviewCount: 5,
      correctCount: 3,
      wrongCount: 2,
      version: 7,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
    ...overrides,
  };
}

function localWord(id = 'w1') {
  return {
    id,
    userId: 'local-user',
    word: 'retain',
    phonetic: '/rɪˈteɪn/',
    meaning: 'v. 保留',
    phrase: '',
    sentence: '',
    sentenceCn: '',
    source: '',
    type: 'marked',
    createdAt: '2026-09-01T00:00:00.000Z',
    progress: {
      id: `p-${id}`,
      userId: 'local-user',
      wordId: id,
      reviewStage: 2,
      recognitionScore: 3,
      spellingScore: 4,
      nextReviewAt: '2026-09-20T00:00:00.000Z',
      lastReviewAt: null,
      lastRecognitionChoice: null,
      lastRecognitionResult: null,
      lastSpellingResult: null,
      lastGrade: null,
      killedAt: null,
      lastRestoredAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
  };
}

function draftInput(overrides = {}) {
  return {
    version: 1,
    mode: 'review',
    itemIds: ['w1'],
    recognitionQueueIds: ['w1'],
    phase: 'recognition',
    index: 0,
    recognition: { w1: { firstChoice: 'known', result: 'correct', hadError: false, attempts: 1 } },
    spelling: { w1: { input: 'retain', correct: true, hadError: false } },
    hadSpellingError: false,
    currentWordId: 'w1',
    firstChoice: 'known',
    answer: 'retain',
    spellingChecked: null,
    ...overrides,
  };
}

function serverDraft(overrides = {}) {
  return {
    key: 'active',
    revision: 3,
    version: 1,
    mode: 'review',
    scope: 'daily',
    phase: 'recognition',
    payload: { ...draftInput(), scope: 'daily' },
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T01:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

test('login posts credentials with cookies and maps the user response', async () => {
  const { client, calls } = createClient([
    jsonResponse(200, {
      user: {
        id: 'u1',
        email: 'a@example.com',
        username: null,
        avatar: null,
        timezone: 'Asia/Shanghai',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    }),
  ]);

  const user = await client.login('a@example.com', 'secret-password');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/api/auth/login`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(calls[0].body, { email: 'a@example.com', password: 'secret-password' });
  assert.equal('userId' in calls[0].body, false);
  // username / avatar 为 null 时映射为 undefined，且不写本地存储。
  assert.deepEqual(Object.keys(user).sort(), ['avatar', 'email', 'id', 'username']);
  assert.equal(user.id, 'u1');
  assert.equal(user.username, undefined);
  assert.equal(user.avatar, undefined);
});

test('session returns null on 401 and throws ApiError on other failures', async () => {
  const unauthorized = createClient([
    jsonResponse(401, { error: { code: 'unauthorized', message: '未登录或会话已失效' } }),
  ]);
  assert.equal(await unauthorized.client.session(), null);

  const broken = createClient([jsonResponse(500, { error: { code: 'internal_error', message: '服务器内部错误' } })]);
  await assert.rejects(broken.client.session(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.equal(error.code, 'internal_error');
    return true;
  });

  const signedIn = createClient([
    jsonResponse(200, { user: { id: 'u1', email: 'a@example.com', username: '小一', avatar: 'x.png' } }),
  ]);
  const user = await signedIn.client.session();
  assert.deepEqual(user, { id: 'u1', email: 'a@example.com', username: '小一', avatar: 'x.png' });
});

test('logout posts without a body', async () => {
  const { client, calls } = createClient([jsonResponse(200, { ok: true })]);
  await client.logout();
  assert.equal(calls[0].url, `${BASE_URL}/api/auth/logout`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body, undefined);
});

// ---------------------------------------------------------------------------
// 词库
// ---------------------------------------------------------------------------

test('listWords sends only limit/offset as query and maps words without a userId in the response', async () => {
  const { client, calls } = createClient([
    jsonResponse(200, {
      total: 1,
      limit: 2,
      offset: 5,
      words: [serverWord()],
    }),
  ]);

  const result = await client.listWords('local-user', { limit: 2, offset: 5 });

  assert.equal(calls[0].url, `${BASE_URL}/api/words?limit=2&offset=5`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(result.total, 1);
  assert.equal(result.words.length, 1);
  assert.equal(result.words[0].userId, 'local-user');
  assert.equal(result.words[0].progress.userId, 'local-user');
  assert.equal(result.words[0].progress.wordId, 'w1');
  // firstLearnedAt 为 null 时映射为 undefined，其余 nullable 字段保持 null。
  assert.equal(result.words[0].progress.firstLearnedAt, undefined);
  assert.equal(result.words[0].progress.killedAt, null);
  assert.equal(result.words[0].progress.version, undefined);
  // 服务端版本信息原样保留，供完成提交做冲突判定。
  assert.equal(result.words[0].progress.updatedAt, '2026-09-02T00:00:00.000Z');
  assert.equal(result.words[0].progress.nextReviewAt, '2026-09-20T00:00:00.000Z');
});

test('listWords omits query parameters that were not provided', async () => {
  const { client, calls } = createClient([jsonResponse(200, { total: 0, words: [] })]);
  await client.listWords('local-user');
  assert.equal(calls[0].url, `${BASE_URL}/api/words`);
});

test('importWords sends only the eight editable fields', async () => {
  const { client, calls } = createClient([jsonResponse(200, { added: 1, existing: 0, total: 1 })]);
  const dirty = {
    ...localWord('leak-me'),
    word: 'retain',
    phonetic: '/rɪˈteɪn/',
    meaning: 'v. 保留',
    phrase: 'retain control',
    sentence: 'Retain it.',
    sentenceCn: '记住它。',
    source: '导入',
  };

  const result = await client.importWords([dirty]);

  assert.equal(calls[0].url, `${BASE_URL}/api/words/import`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body.words.length, 1);
  assert.deepEqual(Object.keys(calls[0].body.words[0]).sort(), [
    'meaning',
    'phonetic',
    'phrase',
    'sentence',
    'sentenceCn',
    'source',
    'type',
    'word',
  ]);
  assert.equal(calls[0].init.body.includes('userId'), false);
  assert.equal(calls[0].init.body.includes('leak-me'), false);
  assert.deepEqual(result, { added: 1, existing: 0, total: 1 });
});

test('updateWord patched path and body exclude identity fields', async () => {
  const { client, calls } = createClient([jsonResponse(200, { word: serverWord() })]);

  const word = await client.updateWord('local-user', 'w1', '/rɪˈteɪn/', 'v. 保留；保持');

  assert.equal(calls[0].url, `${BASE_URL}/api/words/w1`);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(calls[0].body, { phonetic: '/rɪˈteɪn/', meaning: 'v. 保留；保持' });
  assert.equal(word.userId, 'local-user');
});

test('deleteWord and progressAction use the documented paths', async () => {
  const deleted = createClient([jsonResponse(200, { ok: true, deleted: true })]);
  await deleted.client.deleteWord('local-user', 'w1');
  assert.equal(deleted.calls[0].url, `${BASE_URL}/api/words/w1`);
  assert.equal(deleted.calls[0].init.method, 'DELETE');
  assert.equal(deleted.calls[0].body, undefined);

  for (const action of ['kill', 'restore', 'undo-kill']) {
    const { client, calls } = createClient([
      jsonResponse(200, { ok: true, progress: serverWord().progress }),
    ]);
    const progress = await client.progressAction('local-user', 'w1', action);
    assert.equal(calls[0].url, `${BASE_URL}/api/words/w1/${action}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(progress.userId, 'local-user');
    assert.equal(progress.wordId, 'w1');
  }
});

// ---------------------------------------------------------------------------
// 设置与事件
// ---------------------------------------------------------------------------

test('settings round trip keeps server fields and never sends a userId', async () => {
  const settings = {
    dailyTarget: 20,
    dailyGroups: 2,
    dailyGroupWords: 10,
    dailyPlanConfigured: true,
    timezone: 'Asia/Shanghai',
    countdown: { label: '六级考试', targetDate: '2026-12-01' },
    updatedAt: '2026-09-19T00:00:00.000Z',
  };

  const read = createClient([jsonResponse(200, { settings })]);
  const loaded = await read.client.getSettings();
  assert.equal(read.calls[0].url, `${BASE_URL}/api/settings`);
  assert.deepEqual(loaded, settings);

  const patched = createClient([jsonResponse(200, { settings: { ...settings, dailyTarget: 30 } })]);
  const updated = await patched.client.updateSettings({ dailyTarget: 30 });
  assert.equal(patched.calls[0].init.method, 'PATCH');
  assert.deepEqual(patched.calls[0].body, { dailyTarget: 30 });
  assert.equal(updated.dailyTarget, 30);

  const cleared = createClient([jsonResponse(200, { settings: { ...settings, countdown: null } })]);
  await cleared.client.updateSettings({ countdown: null });
  assert.deepEqual(cleared.calls[0].body, { countdown: null });
});

test('updateSettings rejects an empty patch before hitting the network', async () => {
  const { client, calls } = createClient();
  await assert.rejects(client.updateSettings({}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_request');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('listEvents sends only limit/offset and injects the local userId', async () => {
  const { client, calls } = createClient([
    jsonResponse(200, {
      total: 1,
      limit: 10,
      offset: 0,
      events: [
        { id: 'e1', wordId: 'w1', occurredAt: '2026-09-19T00:00:00.000Z', kind: 'review', reviewStage: 2 },
      ],
    }),
  ]);

  const result = await client.listEvents('local-user', { limit: 10 });

  assert.equal(calls[0].url, `${BASE_URL}/api/events?limit=10`);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(result.total, 1);
  assert.deepEqual(result.events[0], {
    id: 'e1',
    userId: 'local-user',
    wordId: 'w1',
    occurredAt: '2026-09-19T00:00:00.000Z',
    kind: 'review',
    reviewStage: 2,
  });
});

// ---------------------------------------------------------------------------
// 学习队列
// ---------------------------------------------------------------------------

test('getDue maps both queues and passes only limit', async () => {
  const { client, calls } = createClient([
    jsonResponse(200, {
      limit: 5,
      dailyNewLimit: 20,
      learnedToday: 3,
      remainingNew: 17,
      dueReviewTotal: 1,
      dueNewTotal: 1,
      reviewWords: [serverWord({ id: 'w1' })],
      newWords: [serverWord({ id: 'w2' })],
    }),
  ]);

  const due = await client.getDue('local-user', 5);

  assert.equal(calls[0].url, `${BASE_URL}/api/review/due?limit=5`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(due.remainingNew, 17);
  assert.equal(due.dueReviewTotal, 1);
  assert.deepEqual(due.reviewWords.map((word) => word.id), ['w1']);
  assert.deepEqual(due.newWords.map((word) => word.id), ['w2']);
  assert.equal(due.newWords[0].userId, 'local-user');
});

test('getSpelling passes scope/filter/limit and maps the queue', async () => {
  const { client, calls } = createClient([
    jsonResponse(200, {
      scope: 'library',
      limit: 20,
      filter: 're',
      dailyMaxLimit: 20,
      words: [serverWord()],
    }),
  ]);

  const words = await client.getSpelling('local-user', { scope: 'library', filter: 're', limit: 20 });

  assert.equal(calls[0].url, `${BASE_URL}/api/spelling?scope=library&filter=re&limit=20`);
  assert.equal(words.length, 1);
  assert.equal(words[0].progress.userId, 'local-user');

  const daily = createClient([jsonResponse(200, { scope: 'daily', words: [] })]);
  await daily.client.getSpelling('local-user');
  assert.equal(daily.calls[0].url, `${BASE_URL}/api/spelling`);
});

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

test('getDraft returns null when the server has no draft, and maps the payload otherwise', async () => {
  const empty = createClient([jsonResponse(200, { draft: null })]);
  assert.equal(await empty.client.getDraft('local-user', 'active'), null);
  assert.equal(empty.calls[0].url, `${BASE_URL}/api/review/draft?key=active`);

  const found = createClient([jsonResponse(200, { draft: serverDraft() })]);
  const draft = await found.client.getDraft('local-user');
  assert.equal(found.calls[0].url, `${BASE_URL}/api/review/draft?key=${DEFAULT_DRAFT_KEY}`);
  assert.equal(draft.userId, 'local-user');
  assert.equal(draft.key, 'active');
  assert.equal(draft.revision, 3);
  assert.equal(draft.version, 1);
  assert.equal(draft.phase, 'recognition');
  assert.deepEqual(draft.itemIds, ['w1']);
  assert.deepEqual(draft.recognition, {
    w1: { firstChoice: 'known', result: 'correct', hadError: false, attempts: 1 },
  });
  assert.equal(draft.updatedAt, '2026-09-19T01:00:00.000Z');
});

test('getDraft drops a structurally invalid payload instead of throwing', async () => {
  const broken = createClient([
    jsonResponse(200, { draft: serverDraft({ payload: { itemIds: 'not-a-list' } }) }),
  ]);
  assert.equal(await broken.client.getDraft('local-user'), null);

  const wrongPhase = createClient([
    jsonResponse(200, {
      draft: serverDraft({ payload: { ...draftInput(), phase: 'learning', mode: 'review' } }),
    }),
  ]);
  assert.equal(await wrongPhase.client.getDraft('local-user'), null);
});

test('saveDraft puts key/revision/payload and keeps identity out of the body', async () => {
  const { client, calls } = createClient([jsonResponse(200, { draft: serverDraft() })]);

  const saved = await client.saveDraft('local-user', draftInput(), { key: 'session-1', revision: 2 });

  assert.equal(calls[0].url, `${BASE_URL}/api/review/draft`);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].body.key, 'session-1');
  assert.equal(calls[0].body.revision, 2);
  assert.equal(calls[0].body.mode, 'review');
  assert.equal(calls[0].body.phase, 'recognition');
  assert.equal(calls[0].body.payload.phase, 'recognition');
  assert.deepEqual(calls[0].body.payload.itemIds, ['w1']);
  assert.equal('userId' in calls[0].body, false);
  assert.equal(calls[0].init.body.includes('local-user'), false);
  assert.equal(saved.version, 1);
  assert.equal(saved.key, 'active');
  assert.equal(saved.revision, 3);
  assert.equal(saved.userId, 'local-user');
});

test('clearDraft deletes by key and defaults to the active draft key', async () => {
  const { client, calls } = createClient([jsonResponse(200, { ok: true, deleted: true })]);
  await client.clearDraft();
  assert.equal(calls[0].url, `${BASE_URL}/api/review/draft?key=${DEFAULT_DRAFT_KEY}`);
  assert.equal(calls[0].init.method, 'DELETE');
});

// ---------------------------------------------------------------------------
// 完成提交
// ---------------------------------------------------------------------------

function completionOutcome(overrides = {}) {
  return {
    submissionKey: 'unused-by-client',
    duplicate: false,
    completed: 1,
    conflicts: 0,
    skipped: 0,
    earliestNextReviewAt: '2026-10-01T00:00:00.000Z',
    results: [{ wordId: 'w1', status: 'completed', reason: null }],
    ...overrides,
  };
}

test('completeNewStudy sends only versions and a well-formed submissionKey', async () => {
  const { client, calls } = createClient([jsonResponse(200, completionOutcome())]);

  const result = await client.completeNewStudy('local-user', [localWord('w1')]);

  assert.equal(calls[0].url, `${BASE_URL}/api/study/new/complete`);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].body.submissionKey, /^[A-Za-z0-9_-]{8,64}$/);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['entries', 'submissionKey']);
  assert.deepEqual(calls[0].body.entries, [
    {
      wordId: 'w1',
      updatedAt: '2026-09-02T00:00:00.000Z',
      nextReviewAt: '2026-09-20T00:00:00.000Z',
    },
  ]);
  assert.equal(calls[0].init.body.includes('local-user'), false);
  assert.deepEqual(result, {
    completed: 1,
    conflicts: 0,
    skipped: 0,
    earliestNextReviewAt: '2026-10-01T00:00:00.000Z',
  });
});

test('finishReview forwards user input only and never client-side results', async () => {
  const { client, calls } = createClient([
    jsonResponse(
      200,
      completionOutcome({
        grades: { again: 0, hard: 1, good: 0, easy: 0 },
        corrected: undefined,
        conflicts: 1,
        skipped: 2,
      }),
    ),
  ]);

  const result = await client.finishReview(
    'local-user',
    [localWord('w1'), localWord('w2')],
    {
      w1: { firstChoice: 'known', result: 'wrong', hadError: true, attempts: 2 },
      w2: { firstChoice: 'unknown', result: 'correct', hadError: false, attempts: 1 },
    },
    {
      w1: { input: 'retian', correct: false, hadError: true },
      w2: { input: 'retain', correct: true, hadError: false },
    },
  );

  assert.equal(calls[0].url, `${BASE_URL}/api/review/complete`);
  const raw = calls[0].init.body;
  assert.equal(raw.includes('userId'), false);
  assert.equal(raw.includes('local-user'), false);
  assert.equal(raw.includes('reviewStage'), false);
  assert.equal(raw.includes('recognitionScore'), false);
  assert.equal(raw.includes('"result"'), false);

  const [first, second] = calls[0].body.entries;
  assert.deepEqual(Object.keys(first).sort(), [
    'nextReviewAt',
    'recognition',
    'spelling',
    'updatedAt',
    'wordId',
  ]);
  assert.deepEqual(first.recognition, { firstChoice: 'known', hadError: true, attempts: 2 });
  assert.deepEqual(first.spelling, { input: 'retian', correct: false, hadError: true });
  assert.equal(second.wordId, 'w2');
  assert.deepEqual(second.recognition, { firstChoice: 'unknown', hadError: false, attempts: 1 });

  assert.deepEqual(result, {
    completed: 1,
    earliestNextReviewAt: '2026-10-01T00:00:00.000Z',
    grades: { again: 0, hard: 1, good: 0, easy: 0 },
    conflicts: 1,
    skipped: 2,
  });
});

test('finishReview rejects a response without grades', async () => {
  const { client } = createClient([jsonResponse(200, completionOutcome())]);
  await assert.rejects(
    client.finishReview(
      'local-user',
      [localWord('w1')],
      { w1: { firstChoice: 'known', result: 'correct', hadError: false, attempts: 1 } },
      { w1: { input: 'retain', correct: true, hadError: false } },
    ),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'invalid_response');
      return true;
    },
  );
});

test('finishSpellingPractice sends the spelling answer and maps corrected count', async () => {
  const { client, calls } = createClient([jsonResponse(200, completionOutcome({ corrected: 1 }))]);

  const result = await client.finishSpellingPractice(
    'local-user',
    [localWord('w1')],
    { w1: { input: 'retain', correct: true, hadError: true } },
  );

  assert.equal(calls[0].url, `${BASE_URL}/api/spelling/complete`);
  assert.deepEqual(calls[0].body.entries, [
    {
      wordId: 'w1',
      updatedAt: '2026-09-02T00:00:00.000Z',
      nextReviewAt: '2026-09-20T00:00:00.000Z',
      spelling: { input: 'retain', correct: true, hadError: true },
    },
  ]);
  assert.equal(calls[0].body.entries[0].recognition, undefined);
  assert.deepEqual(result, { completed: 1, corrected: 1, conflicts: 0, skipped: 0 });
});

test('an explicit submissionKey is reused across retries and validated before sending', async () => {
  const retryKey = 'retry-key-0001';
  const first = createClient([jsonResponse(200, completionOutcome())]);
  await first.client.completeNewStudy('local-user', [localWord('w1')], { submissionKey: retryKey });
  const second = createClient([jsonResponse(200, completionOutcome())]);
  await second.client.completeNewStudy('local-user', [localWord('w1')], { submissionKey: retryKey });
  assert.equal(first.calls[0].body.submissionKey, retryKey);
  assert.equal(second.calls[0].body.submissionKey, retryKey);

  const invalid = createClient();
  await assert.rejects(
    invalid.client.completeNewStudy('local-user', [localWord('w1')], { submissionKey: 'short' }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
  assert.equal(invalid.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 错误与边界
// ---------------------------------------------------------------------------

test('a non-JSON 500 becomes a controlled ApiError without leaking the body', async () => {
  const { client } = createClient([textResponse(500, '<html>gateway exploded: secret-cookie</html>')]);

  await assert.rejects(client.listWords('local-user'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.equal(error.code, 'request_failed');
    assert.equal(error.message.includes('secret-cookie'), false);
    assert.equal(error.message.includes('<html>'), false);
    assert.deepEqual(error.details, []);
    return true;
  });
});

test('a JSON error keeps code, message and details while hiding nothing secret', async () => {
  const { client } = createClient([
    jsonResponse(400, {
      error: {
        code: 'invalid_request',
        message: '请求参数不合法',
        details: ['limit: 数字不能小于 1'],
      },
    }),
  ]);

  await assert.rejects(client.getDue('local-user', 0), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_request');
    assert.equal(error.message, '请求参数不合法');
    assert.deepEqual(error.details, ['limit: 数字不能小于 1']);
    return true;
  });
});

test('any 401 outside session() is thrown, including for listWords', async () => {
  const { client } = createClient([
    jsonResponse(401, { error: { code: 'unauthorized', message: '未登录或会话已失效' } }),
  ]);
  await assert.rejects(client.listWords('local-user'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'unauthorized');
    return true;
  });
});

test('network failures surface as a controlled ApiError', async () => {
  const { client } = createClient([
    () => {
      throw new TypeError('fetch failed');
    },
  ]);
  await assert.rejects(client.getSettings(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    assert.equal(error.code, 'network_error');
    return true;
  });
});

test('a 2xx response that is not JSON is reported as invalid_response', async () => {
  const { client } = createClient([textResponse(200, '<html>index.html</html>')]);
  await assert.rejects(client.getSettings(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'invalid_response');
    return true;
  });
});

test('baseUrl normalisation: trailing slashes are dropped and an empty base stays same-origin', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse(200, {
      settings: {
        dailyTarget: 20,
        dailyGroups: 2,
        dailyGroupWords: 10,
        dailyPlanConfigured: true,
        timezone: 'Asia/Shanghai',
        countdown: null,
        updatedAt: '2026-09-19T00:00:00.000Z',
      },
    });
  };
  await createApiClient({ baseUrl: `${BASE_URL}/`, fetchImpl }).getSettings();
  await createApiClient({ baseUrl: '', fetchImpl }).getSettings();
  assert.deepEqual(calls, [`${BASE_URL}/api/settings`, '/api/settings']);
});

test('the client never persists anything to localStorage', async () => {
  const touched = [];
  globalThis.localStorage = {
    getItem: (key) => {
      touched.push(`get:${key}`);
      return null;
    },
    setItem: (key) => touched.push(`set:${key}`),
    removeItem: (key) => touched.push(`remove:${key}`),
  };

  try {
    const { client } = createClient([
      jsonResponse(200, { user: { id: 'u1', email: 'a@example.com', username: null, avatar: null } }),
      jsonResponse(200, { ok: true }),
      jsonResponse(200, { draft: null }),
    ]);
    await client.login('a@example.com', 'secret-password');
    await client.logout();
    await client.getDraft('local-user');
  } finally {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }

  assert.deepEqual(touched, []);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});
