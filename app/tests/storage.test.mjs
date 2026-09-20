import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/data/localStore.ts';
import { EDITABLE_TSV_HEADER, buildEditableTsv } from '../src/data/editableTsv.ts';
import { buildLearningStatistics } from '../src/data/statisticsService.ts';

const data = new Map();
globalThis.localStorage = {
  getItem: key => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value),
  removeItem: key => data.delete(key),
};
const word = { word: 'retain', phonetic: '/rɪˈteɪn/', meaning: 'v. 保留', phrase: '', sentence: '', sentenceCn: '', source: '测试', type: 'marked' };
beforeEach(() => data.clear());

test('editable TSV export keeps the fixed eight columns and is safe to re-import', () => {
  const raw = buildEditableTsv([{ ...word, phrase: 'retain\tcontrol', sentence: 'First line\nSecond line' }]);
  const [header, entry] = raw.split('\n');
  assert.deepEqual(header.split('\t'), EDITABLE_TSV_HEADER);
  assert.deepEqual(entry.split('\t'), [
    'retain', '/rɪˈteɪn/', 'v. 保留', 'retain control', 'First line Second line', '', '测试', 'marked',
  ]);
});

test('batch delete removes only selected current-profile words and their progress', () => {
  localStore.importWords('one', [word, { ...word, word: 'allocate', meaning: 'v. 分配；拨出' }]);
  localStore.importWords('two', [{ ...word, word: 'separate' }]);
  const retain = localStore.getWords('one').find((entry) => entry.word === 'retain');
  assert.ok(retain);

  assert.equal(localStore.deleteWords('one', [retain.id, retain.id, 'missing-word']), 1);
  assert.deepEqual(localStore.getWords('one').map((entry) => entry.word), ['allocate']);
  assert.equal(JSON.parse(localStore.exportBackup('one')).progress.length, 1);
  assert.deepEqual(localStore.getWords('two').map((entry) => entry.word), ['separate']);
});

test('countdown settings stay per profile and reject invalid calendar dates', () => {
  localStore.setCountdown('one', { label: '六级考试', targetDate: '2026-12-01' });
  localStore.setCountdown('two', { label: '雅思考试', targetDate: '2027-01-15' });
  assert.deepEqual(localStore.getCountdown('one'), { label: '六级考试', targetDate: '2026-12-01' });
  assert.deepEqual(localStore.getCountdown('two'), { label: '雅思考试', targetDate: '2027-01-15' });
  assert.throws(() => localStore.setCountdown('one', { label: '无效日期', targetDate: '2026-02-30' }), /有效的目标日期/);
  localStore.setCountdown('one', null);
  assert.equal(localStore.getCountdown('one'), null);
  assert.deepEqual(localStore.getCountdown('two'), { label: '雅思考试', targetDate: '2027-01-15' });
});

test('backup round trip retains learning and does not affect another profile', () => {
  localStore.importWords('one', [word]);
  localStore.importWords('two', [{ ...word, word: 'test' }]);
  const entry = localStore.getWords('one')[0];
  localStore.finishReview('one', [entry], { [entry.id]: { firstChoice: 'known', result: 'correct', hadError: false, attempts: 1 } }, { [entry.id]: { input: 'retain', correct: true, hadError: false } });
  const before = localStore.getWords('one')[0];
  localStore.restoreBackup('one', localStore.exportBackup('one'));
  const after = localStore.getWords('one')[0];
  assert.equal(after.progress.reviewStage, before.progress.reviewStage);
  assert.equal(after.progress.nextReviewAt, before.progress.nextReviewAt);
  assert.equal(localStore.getWords('two')[0].word, 'test');
});

test('invalid backup never partially replaces existing records', () => {
  localStore.importWords('one', [word]);
  const raw = localStore.exportBackup('one');
  for (const mutate of [b => b.progress[0].nextReviewAt = 'invalid', b => b.progress[0].reviewStage = 2.5, b => b.words.push(null), b => b.progress.pop()]) {
    const backup = JSON.parse(raw);
    mutate(backup);
    assert.throws(() => localStore.restoreBackup('one', JSON.stringify(backup)));
    assert.equal(localStore.getWords('one').length, 1);
    assert.equal(localStore.getWords('one')[0].word, 'retain');
  }
});

test('immediate undo preserves stage and review time', () => {
  localStore.importWords('one', [word]);
  const entry = localStore.getWords('one')[0];
  localStore.killWord('one', entry.id);
  assert.equal(localStore.getDueWords('one').length, 0);
  localStore.undoKillWord('one', entry.id);
  const restored = localStore.getWords('one')[0];
  assert.equal(restored.progress.reviewStage, entry.progress.reviewStage);
  assert.equal(restored.progress.nextReviewAt, entry.progress.nextReviewAt);
});

test('draft round trip preserves in-progress answers and is isolated by user', () => {
  localStore.saveReviewDraft('one', {
    itemIds: ['word'], recognitionQueueIds: ['word'], mode: 'spell', scope: 'library', phase: 'spelling', index: 0,
    recognition: {}, spelling: {}, hadSpellingError: true, currentWordId: 'word',
    firstChoice: null, answer: 'retian', spellingChecked: { input: 'retian', correct: false, hadError: true },
  });
  const draft = localStore.getReviewDraft('one');
  assert.equal(draft.scope, 'library');
  assert.equal(draft.hadSpellingError, true);
  assert.equal(draft.currentWordId, 'word');
  assert.equal(draft.spellingChecked.correct, false);
  assert.equal(localStore.getReviewDraft('two'), null);
  localStore.clearReviewDraft('one');
  assert.equal(localStore.getReviewDraft('one'), null);
});

test('corrupt main storage is protected and blocks normal writes until explicitly discarded', () => {
  data.set('cet-word-mvp-local-v1', '{not json');
  assert.equal(localStore.getSession(), null);
  assert.equal(localStore.getStorageStatus().kind, 'corrupt');
  assert.equal(localStore.getDamagedData(), '{not json');
  assert.throws(() => localStore.importWords('one', [word]), /暂停写入/);
  assert.equal(data.get('cet-word-mvp-local-v1'), '{not json');
  localStore.discardDamagedData();
  localStore.importWords('one', [word]);
  assert.equal(localStore.getWords('one').length, 1);
});

test('empty backup is rejected and restoring stores a downloadable pre-restore snapshot', () => {
  localStore.importWords('one', [word]);
  const empty = { format: 'cet-word-backup', version: 1, words: [], progress: [] };
  assert.throws(() => localStore.restoreBackup('one', JSON.stringify(empty)), /没有词条/);
  localStore.restoreBackup('one', localStore.exportBackup('one'));
  const automatic = JSON.parse(localStore.getAutomaticBackup('one'));
  assert.equal(automatic.words[0].word, 'retain');
});

test('punctuation in emails does not merge profiles', () => {
  assert.notEqual(localStore.signIn('a+b@example.com').id, localStore.signIn('a-b@example.com').id);
});

test('failed recovery copy keeps corrupt source locked and downloadable', () => {
  data.set('cet-word-mvp-local-v1', '{broken');
  const original = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key.includes('recovery')) throw new Error('quota');
    original(key, value);
  };
  try {
    localStore.getSession();
    assert.equal(localStore.getStorageStatus().kind, 'corrupt');
    assert.equal(localStore.getDamagedData(), '{broken');
    assert.throws(() => localStore.importWords('one', [word]));
    assert.equal(data.get('cet-word-mvp-local-v1'), '{broken');
  } finally { localStorage.setItem = original; localStore.discardDamagedData(); }
});

test('stale completion cannot award a second score and editing retains progress', () => {
  localStore.importWords('one', [word]);
  const entry = localStore.getWords('one')[0];
  const recognition = { [entry.id]: { firstChoice: 'known', result: 'correct', hadError: false, attempts: 1 } };
  const spelling = { [entry.id]: { input: 'retain', correct: true, hadError: false } };
  assert.equal(localStore.finishReview('one', [entry], recognition, spelling).completed, 1);
  assert.equal(localStore.finishReview('one', [entry], recognition, spelling).completed, 0);
  const progress = localStore.getWords('one')[0].progress;
  localStore.updateWord('one', entry.id, '/test/', '保存');
  assert.deepEqual(localStore.getWords('one')[0].progress, progress);
});

test('daily new-word allowance is consumed across rounds', () => {
  localStore.importWords('one', [word, { ...word, word: 'test' }]);
  localStore.setDailyTarget('one', 1);
  const entry = localStore.getDueWords('one')[0];
  assert.equal(localStore.getDueWords('one').length, 1);
  localStore.finishReview('one', [entry], { [entry.id]: { firstChoice: 'known', result: 'correct', hadError: false, attempts: 1 } }, { [entry.id]: { input: entry.word, correct: true, hadError: false } });
  assert.equal(localStore.getDueWords('one').length, 0);
  localStore.setDailyTarget('one', 2);
  assert.equal(localStore.getDueWords('one').length, 1);
});

test('new study schedules a separate next-day review without inventing quiz scores', () => {
  localStore.importWords('one', [word, { ...word, word: 'allocate', meaning: 'v. 分配；拨出' }]);
  const entries = localStore.getDueWords('one');
  const before = new Map(entries.map((entry) => [entry.id, entry.progress.updatedAt]));
  const result = localStore.completeNewStudy('one', entries);
  assert.equal(result.completed, 2);
  assert.equal(localStore.getDueWords('one').length, 0);
  localStore.getWords('one').forEach((entry) => {
    assert.ok(entry.progress.firstLearnedAt);
    assert.ok(entry.progress.lastReviewAt);
    assert.equal(entry.progress.reviewStage, 0);
    assert.equal(entry.progress.recognitionScore, 0);
    assert.equal(entry.progress.spellingScore, 0);
    assert.equal(entry.progress.lastRecognitionResult, null);
    assert.equal(entry.progress.lastSpellingResult, null);
    assert.notEqual(entry.progress.updatedAt, before.get(entry.id));
  });
});

test('spelling practice only queues words newly studied today and keeps review grading separate', () => {
  localStore.importWords('one', [
    word,
    { ...word, word: 'allocate', meaning: 'v. 分配；拨出' },
    { ...word, word: 'resilient', meaning: 'adj. 有韧性的；适应力强的' },
    { ...word, word: 'oldlearned', meaning: 'adj. 以前学习的' },
    { ...word, word: 'unseen', meaning: 'adj. 未学习的' },
  ]);
  const learnedEntries = localStore.getDueWords('one').filter(entry => entry.word !== 'unseen' && entry.word !== 'oldlearned');
  localStore.completeNewStudy('one', learnedEntries);

  const backup = JSON.parse(localStore.exportBackup('one'));
  const oldWord = backup.words.find(item => item.word === 'oldlearned');
  const oldProgress = backup.progress.find(progress => progress.wordId === oldWord.id);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  oldProgress.firstLearnedAt = twoDaysAgo;
  oldProgress.lastReviewAt = twoDaysAgo;
  oldProgress.nextReviewAt = '2027-01-01T00:00:00.000Z';
  localStore.restoreBackup('one', JSON.stringify(backup));

  const today = new Date().toDateString();
  const allTodayEntries = localStore.getSpellingWords('one', 20);
  assert.equal(allTodayEntries.length, 3);
  assert.equal(allTodayEntries.every(entry => new Date(entry.progress.firstLearnedAt).toDateString() === today), true);
  assert.equal(allTodayEntries.some(entry => entry.word === 'oldlearned' || entry.word === 'unseen'), false);
  const spellingEntries = localStore.getSpellingWords('one', 2);
  assert.equal(spellingEntries.length, 2);

  const before = new Map(localStore.getWords('one').map(entry => [entry.id, { ...entry.progress }]));
  const answers = {
    [spellingEntries[0].id]: { input: spellingEntries[0].word, correct: true, hadError: false },
    [spellingEntries[1].id]: { input: spellingEntries[1].word, correct: true, hadError: true },
  };
  assert.deepEqual(localStore.finishSpellingPractice('one', spellingEntries, answers), { completed: 2, corrected: 1 });
  assert.deepEqual(localStore.finishSpellingPractice('one', spellingEntries, answers), { completed: 0, corrected: 0 });

  const after = new Map(localStore.getWords('one').map(entry => [entry.id, entry.progress]));
  spellingEntries.forEach((entry, index) => {
    const beforeProgress = before.get(entry.id);
    const afterProgress = after.get(entry.id);
    assert.equal(afterProgress.reviewStage, beforeProgress.reviewStage);
    assert.equal(afterProgress.recognitionScore, beforeProgress.recognitionScore);
    assert.equal(afterProgress.lastReviewAt, beforeProgress.lastReviewAt);
    assert.equal(afterProgress.lastGrade, beforeProgress.lastGrade);
    assert.equal(afterProgress.lastSpellingResult, index === 0 ? 'correct' : 'wrong');
  });
});

test('daily group limit caps new tasks and can be changed independently', () => {
  const words = Array.from({ length: 25 }, (_, index) => ({ ...word, word: `word${String(index).padStart(2, '0')}` }));
  localStore.importWords('one', words);
  localStore.setDailyGroups('one', 2);
  localStore.setDailyGroupWords('one', 10);
  assert.equal(localStore.getDailyGroups('one'), 2);
  const firstBatch = localStore.getDueWords('one');
  assert.equal(firstBatch.length, 20);

  const recognition = Object.fromEntries(firstBatch.map(entry => [entry.id, { firstChoice: 'known', result: 'correct', hadError: false, attempts: 1 }]));
  const spelling = Object.fromEntries(firstBatch.map(entry => [entry.id, { input: entry.word, correct: true, hadError: false }]));
  assert.equal(localStore.finishReview('one', firstBatch, recognition, spelling).completed, 20);
  assert.equal(localStore.getDueWords('one').length, 0);

  localStore.setDailyGroups('one', 3);
  assert.equal(localStore.getDueWords('one').length, 5);
  assert.throws(() => localStore.setDailyGroups('one', 0), /1—20/);
});

test('due reviews stay available when the new-word plan is smaller', () => {
  const words = Array.from({ length: 3 }, (_, index) => ({ ...word, word: `review${String(index).padStart(2, '0')}` }));
  localStore.importWords('one', words);
  const backup = JSON.parse(localStore.exportBackup('one'));
  const now = new Date().toISOString();
  backup.progress.forEach((progress) => {
    progress.lastReviewAt = now;
    progress.firstLearnedAt = now;
    progress.nextReviewAt = now;
  });
  localStore.restoreBackup('one', JSON.stringify(backup));
  localStore.setDailyGroups('one', 1);
  localStore.setDailyGroupWords('one', 1);
  assert.equal(localStore.getDueWords('one').length, 3);
  assert.equal(localStore.getDueWords('one').every((entry) => entry.progress.lastReviewAt), true);
});

test('daily group word size changes the daily allowance independently', () => {
  const words = Array.from({ length: 25 }, (_, index) => ({ ...word, word: `size${String(index).padStart(2, '0')}` }));
  localStore.importWords('one', words);
  localStore.setDailyGroups('one', 2);
  localStore.setDailyGroupWords('one', 10);
  assert.equal(localStore.getDailyGroupWords('one'), 10);
  assert.equal(localStore.getDueWords('one').length, 20);
  localStore.setDailyGroupWords('one', 5);
  assert.equal(localStore.getDueWords('one').length, 10);
  localStore.setDailyGroupWords('one', 20);
  assert.equal(localStore.getDueWords('one').length, 25);
  assert.throws(() => localStore.setDailyGroupWords('one', 21), /1—20/);
});

test('configured daily plan controls new-word allowance while retaining legacy target fallback', () => {
  const words = Array.from({ length: 25 }, (_, index) => ({ ...word, word: `plan${String(index).padStart(2, '0')}` }));
  localStore.importWords('one', words);
  localStore.setDailyTarget('one', 1);
  assert.equal(localStore.getDueWords('one').length, 1);
  localStore.setDailyGroups('one', 3);
  localStore.setDailyGroupWords('one', 20);
  assert.equal(localStore.getDailyNewLimit('one'), 60);
  assert.equal(localStore.getDueWords('one').length, 25);
});

test('theme preference is device-wide and falls back to system', () => {
  assert.equal(localStore.getThemeMode(), 'system');
  localStore.setThemeMode('dark');
  assert.equal(localStore.getThemeMode(), 'dark');
  localStore.setThemeMode('light');
  assert.equal(localStore.getThemeMode(), 'light');
  localStore.setThemeMode('system');
  assert.equal(localStore.getThemeMode(), 'system');
  assert.throws(() => localStore.setThemeMode('sepia'), /主题模式无效/);
});

test('local profile keeps username and avatar across sign-in', () => {
  const signedIn = localStore.signIn('profile@example.com');
  const updated = localStore.updateProfile(signedIn.id, { username: '学习者', avatar: '✦' });
  assert.equal(updated.username, '学习者');
  assert.equal(updated.avatar, '✦');
  localStore.signOut();
  const restored = localStore.signIn('profile@example.com');
  assert.equal(restored.username, '学习者');
  assert.equal(restored.avatar, '✦');
  assert.throws(() => localStore.updateProfile(restored.id, { username: '', avatar: '✦' }), /用户名不能为空/);
});

test('statistics keeps legacy learned words and schedules their real review dates', () => {
  const now = new Date('2026-09-14T10:00:00');
  const learnedAt = '2026-09-13T10:00:00.000Z';
  const items = [{
    ...word,
    id: 'legacy-word',
    createdAt: learnedAt,
    progress: {
      id: 'legacy-progress', userId: 'one', wordId: 'legacy-word', reviewStage: 1,
      nextReviewAt: '2026-09-13T08:00:00.000Z', lastReviewAt: learnedAt,
      killedAt: null, lastRestoredAt: null, createdAt: learnedAt, updatedAt: learnedAt,
      // `firstLearnedAt` intentionally absent: this mirrors a pre-statistics local backup.
    },
  }];
  const statistics = buildLearningStatistics(items, [], now);
  assert.equal(statistics.learnedCount, 1);
  assert.equal(statistics.mastery.strengthening, 1);
  assert.equal(statistics.schedule[0].total, 1);
  assert.equal(statistics.schedule[0].stages.overdue, 1);
});
