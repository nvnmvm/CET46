import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/data/apiClient.ts';
import { createCloudRepository } from '../src/data/cloudRepository.ts';

const BASE_SETTINGS = {
  dailyTarget: 20,
  dailyGroups: 2,
  dailyGroupWords: 10,
  dailyPlanConfigured: false,
  timezone: 'Asia/Shanghai',
  countdown: null,
  updatedAt: '2026-09-19T00:00:00.000Z',
};

function makeProgress(wordId, overrides = {}) {
  return {
    id: `p-${wordId}`,
    userId: undefined,
    wordId,
    reviewStage: 0,
    recognitionScore: 0,
    spellingScore: 0,
    firstLearnedAt: null,
    nextReviewAt: '2026-09-20T00:00:00.000Z',
    lastReviewAt: null,
    lastRecognitionChoice: null,
    lastRecognitionResult: null,
    lastSpellingResult: null,
    lastGrade: null,
    killedAt: null,
    lastRestoredAt: null,
    reviewCount: 0,
    correctCount: 0,
    wrongCount: 0,
    version: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeWord(id, word, overrides = {}) {
  return {
    id,
    userId: undefined,
    word,
    phonetic: `/${word}/`,
    meaning: `${word} meaning`,
    phrase: '',
    sentence: '',
    sentenceCn: '',
    source: 'test',
    type: 'added',
    createdAt: '2026-09-19T00:00:00.000Z',
    progress: makeProgress(id, overrides.progress),
    ...overrides,
  };
}

function makeDraft(revision = 1, overrides = {}) {
  return {
    key: 'active',
    revision,
    version: 1,
    mode: 'review',
    scope: 'daily',
    phase: 'recognition',
    itemIds: ['w1'],
    recognitionQueueIds: ['w1'],
    index: 0,
    recognition: {},
    spelling: {},
    hadSpellingError: false,
    currentWordId: 'w1',
    firstChoice: null,
    answer: '',
    spellingChecked: null,
    userId: undefined,
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function createFakeApi(initialUsers) {
  const states = new Map(Object.entries(initialUsers).map(([userId, value]) => [userId, {
    words: value.words.map((word) => structuredClone(word)),
    events: structuredClone(value.events ?? []),
    settings: { ...BASE_SETTINGS, ...(value.settings ?? {}) },
    draft: value.draft ? structuredClone(value.draft) : null,
  }]));
  const calls = [];
  const fail = { import: false, delete: false, draftConflict: false, completeReview: false };
  const completionKeys = [];
  let activeUserId = Object.keys(initialUsers)[0];

  const stateFor = (userId) => {
    const state = states.get(userId);
    if (!state) throw new Error(`missing fake user ${userId}`);
    return state;
  };

  const api = {
    calls,
    fail,
    completionKeys,
    stateFor,
    setActiveUser(userId) {
      activeUserId = userId;
    },
    async listWords(userId, options = {}) {
      calls.push(['listWords', userId, options]);
      const state = stateFor(userId);
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 100;
      return { total: state.words.length, words: state.words.slice(offset, offset + limit).map((word) => structuredClone(word)) };
    },
    async listEvents(userId, options = {}) {
      calls.push(['listEvents', userId, options]);
      const state = stateFor(userId);
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 500;
      return { total: state.events.length, events: state.events.slice(offset, offset + limit).map((event) => structuredClone(event)) };
    },
    async getSettings() {
      calls.push(['getSettings']);
      return structuredClone(stateFor(activeUserId).settings);
    },
    async getDue(userId) {
      calls.push(['getDue', userId]);
      const state = stateFor(userId);
      return { limit: 200, dailyNewLimit: 20, learnedToday: 0, remainingNew: 20, dueReviewTotal: state.words.length, dueNewTotal: 0, reviewWords: state.words.map((word) => structuredClone(word)), newWords: [] };
    },
    async getSpelling(userId) {
      calls.push(['getSpelling', userId]);
      return stateFor(userId).words.slice(0, 20).map((word) => structuredClone(word));
    },
    async getDraft(userId) {
      calls.push(['getDraft', userId]);
      const draft = stateFor(userId).draft;
      return draft ? structuredClone(draft) : null;
    },
    async saveDraft(userId, draft, options = {}) {
      calls.push(['saveDraft', userId, draft, options]);
      if (fail.draftConflict) {
        fail.draftConflict = false;
        throw new ApiError({ status: 409, code: 'revision_conflict', message: 'conflict' });
      }
      const state = stateFor(userId);
      const saved = { ...makeDraft((state.draft?.revision ?? 0) + 1), ...draft, revision: (state.draft?.revision ?? 0) + 1 };
      state.draft = saved;
      return structuredClone(saved);
    },
    async clearDraft() {
      calls.push(['clearDraft']);
    },
    async importWords(input) {
      calls.push(['importWords', input]);
      if (fail.import) throw new Error('import failed');
      const state = stateFor(activeUserId);
      for (const item of input) state.words.push(makeWord(`w-${item.word}`, item.word));
      return { added: input.length, existing: 0, total: state.words.length };
    },
    async updateWord(userId, wordId, phonetic, meaning) {
      calls.push(['updateWord', userId, wordId, phonetic, meaning]);
      const word = stateFor(userId).words.find((item) => item.id === wordId);
      if (!word) throw new Error('missing word');
      word.phonetic = phonetic;
      word.meaning = meaning;
      return structuredClone(word);
    },
    async deleteWord(userId, wordId) {
      calls.push(['deleteWord', userId, wordId]);
      if (fail.delete) throw new Error('delete failed');
      const state = stateFor(userId);
      state.words = state.words.filter((item) => item.id !== wordId);
    },
    async progressAction(userId, wordId, action) {
      calls.push(['progressAction', userId, wordId, action]);
      const word = stateFor(userId).words.find((item) => item.id === wordId);
      if (!word) throw new Error('missing word');
      word.progress = { ...word.progress, killedAt: action === 'kill' ? '2026-09-19T01:00:00.000Z' : null, version: (word.progress.version ?? 0) + 1 };
      return structuredClone(word.progress);
    },
    async updateSettings(patch) {
      calls.push(['updateSettings', patch]);
      const state = stateFor(activeUserId);
      state.settings = { ...state.settings, ...patch, updatedAt: '2026-09-19T02:00:00.000Z' };
      return structuredClone(state.settings);
    },
    async completeNewStudy(userId, entries, options = {}) {
      calls.push(['completeNewStudy', userId, entries, options]);
      return { completed: entries.length, conflicts: 0, skipped: 0, earliestNextReviewAt: null };
    },
    async finishReview(userId, entries, recognition, spelling, options = {}) {
      calls.push(['finishReview', userId, entries, recognition, spelling, options]);
      completionKeys.push(options.submissionKey);
      if (fail.completeReview) throw new Error('network failed');
      return { completed: entries.length, conflicts: 0, skipped: 0, earliestNextReviewAt: null, grades: { again: 0, hard: 0, good: entries.length, easy: 0 } };
    },
    async finishSpellingPractice(userId, entries, spelling, options = {}) {
      calls.push(['finishSpellingPractice', userId, entries, spelling, options]);
      return { completed: entries.length, corrected: entries.length, conflicts: 0, skipped: 0 };
    },
  };
  return api;
}

function emptyState(overrides = {}) {
  return { words: [], events: [], settings: {}, draft: null, ...overrides };
}

test('hydrate loads words, settings, events and draft for the current user', async () => {
  const api = createFakeApi({
    user_A: emptyState({
      words: [makeWord('w2', 'retain'), makeWord('w1', 'apple')],
      events: [{ id: 'e1', wordId: 'w1', occurredAt: '2026-09-19T02:00:00.000Z', kind: 'new', reviewStage: 1 }, { id: 'e2', wordId: 'w2', occurredAt: '2026-09-19T01:00:00.000Z', kind: 'review', reviewStage: 2 }],
      settings: { dailyGroups: 5, dailyGroupWords: 10 },
      draft: makeDraft(4),
    }),
  });
  const repository = createCloudRepository(api);

  await repository.hydrate('user_A');
  api.setActiveUser('user_A');

  assert.deepEqual(repository.getWords('user_A').map((word) => word.word), ['apple', 'retain']);
  assert.equal(repository.getDailyGroups('user_A'), 5);
  assert.equal(repository.getReviewDraft('user_A').revision, 4);
  assert.deepEqual(repository.getLearningEvents('user_A').map((event) => event.id), ['e2', 'e1']);
});

test('switching from A to B never exposes the previous user cache', async () => {
  const api = createFakeApi({
    user_A: emptyState({ words: [makeWord('a1', 'apple'), makeWord('a2', 'retain')] }),
    user_B: emptyState({ words: [makeWord('b1', 'banana')] }),
  });
  const repository = createCloudRepository(api);

  await repository.hydrate('user_A');
  api.setActiveUser('user_B');
  await repository.hydrate('user_B');

  assert.deepEqual(repository.getWords('user_B').map((word) => word.word), ['banana']);
  assert.deepEqual(repository.getWords('user_A'), []);
  assert.equal(repository.getReviewDraft('user_A'), null);
});

test('import and delete rehydrate only after the server mutation succeeds', async () => {
  const api = createFakeApi({ user_A: emptyState({ words: [makeWord('w1', 'apple'), makeWord('w2', 'retain')] }) });
  const repository = createCloudRepository(api);
  await repository.hydrate('user_A');

  await repository.importWords('user_A', [{ word: 'banana', phonetic: '/banana/', meaning: 'banana', type: 'added' }]);
  assert.deepEqual(repository.getWords('user_A').map((word) => word.word), ['apple', 'banana', 'retain']);

  api.fail.import = true;
  await assert.rejects(repository.importWords('user_A', [{ word: 'failed', phonetic: '', meaning: 'failed', type: 'added' }]));
  assert.deepEqual(repository.getWords('user_A').map((word) => word.word), ['apple', 'banana', 'retain']);

  await repository.deleteWord('user_A', 'w2');
  assert.deepEqual(repository.getWords('user_A').map((word) => word.word), ['apple', 'banana']);
  api.fail.delete = true;
  await assert.rejects(repository.deleteWord('user_A', 'w1'));
  assert.deepEqual(repository.getWords('user_A').map((word) => word.word), ['apple', 'banana']);
});

test('kill and restore replace progress in words, due queue and spelling queue', async () => {
  const api = createFakeApi({ user_A: emptyState({ words: [makeWord('w1', 'apple')] }) });
  const repository = createCloudRepository(api);
  await repository.hydrate('user_A');

  await repository.killWord('user_A', 'w1');
  assert.equal(repository.getWords('user_A')[0].progress.killedAt, '2026-09-19T01:00:00.000Z');
  assert.equal(repository.getDueWords('user_A')[0].progress.killedAt, '2026-09-19T01:00:00.000Z');
  assert.equal(repository.getSpellingWords('user_A', 1)[0].progress.killedAt, '2026-09-19T01:00:00.000Z');

  await repository.restoreWord('user_A', 'w1');
  assert.equal(repository.getWords('user_A')[0].progress.killedAt, null);
  assert.equal(repository.getDueWords('user_A')[0].progress.killedAt, null);
  assert.equal(repository.getSpellingWords('user_A', 1)[0].progress.killedAt, null);
});

test('settings save updates the cache only with the server response', async () => {
  const api = createFakeApi({ user_A: emptyState() });
  const repository = createCloudRepository(api);
  await repository.hydrate('user_A');

  await repository.setDailyGroups('user_A', 6);
  await repository.setDailyGroupWords('user_A', 12);
  await repository.setDailyTarget('user_A', 30);
  await repository.setCountdown('user_A', { label: '考试', targetDate: '2026-12-12' });

  assert.equal(repository.getDailyGroups('user_A'), 6);
  assert.equal(repository.getDailyGroupWords('user_A'), 12);
  assert.equal(repository.getDailyTarget('user_A'), 30);
  assert.deepEqual(repository.getCountdown('user_A'), { label: '考试', targetDate: '2026-12-12' });
});

test('draft revision conflict refreshes the latest draft and rejects the save', async () => {
  const api = createFakeApi({ user_A: emptyState({ draft: makeDraft(4) }) });
  const repository = createCloudRepository(api);
  await repository.hydrate('user_A');
  api.stateFor('user_A').draft = makeDraft(5);
  api.fail.draftConflict = true;

  await assert.rejects(
    repository.saveReviewDraft('user_A', makeDraft(4, { answer: 'new answer' })),
    (error) => error instanceof ApiError && error.status === 409,
  );
  assert.equal(repository.getReviewDraft('user_A').revision, 5);
  assert.ok(api.calls.some((call) => call[0] === 'getDraft' && call[1] === 'user_A'));
});

test('completion retry reuses submissionKey, then a successful completion gets a new key', async () => {
  const api = createFakeApi({ user_A: emptyState({ words: [makeWord('w1', 'apple')] }) });
  const repository = createCloudRepository(api);
  await repository.hydrate('user_A');
  const entry = repository.getWords('user_A')[0];
  api.fail.completeReview = true;

  await assert.rejects(repository.finishReview('user_A', [entry], {}, {}));
  api.fail.completeReview = false;
  await repository.finishReview('user_A', [entry], {}, {});
  await repository.finishReview('user_A', [entry], {}, {});

  assert.equal(api.completionKeys.length, 3);
  assert.equal(api.completionKeys[0], api.completionKeys[1]);
  assert.notEqual(api.completionKeys[1], api.completionKeys[2]);
});
