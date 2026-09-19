import { newId } from "../ids.ts";
import { mergeWordFields } from "../schemas.ts";
import type { NormalizedWordInput, ReviewGrade, UpdateWordPatch } from "../schemas.ts";
import {
  decideNewStudyEntry,
  decideReviewEntry,
  decideSpellingEntry,
  earliestIso,
  isSpellingAnswerCorrect,
} from "../learningRules.ts";
import type {
  EntryDecision,
  ProgressRuleSnapshot,
  ProgressRuleState,
} from "../learningRules.ts";
import type {
  CompletionInput,
  CompletionOutcome,
  EntryOutcome,
  ImportResult,
  LearningEventRecord,
  ListWordsOptions,
  NewSessionInput,
  NewUserInput,
  ProgressRecord,
  ReviewDraftRecord,
  SaveDraftInput,
  SaveDraftOutcome,
  SessionRecord,
  SessionWithUser,
  SubmissionKind,
  UpdateSettingsPatch,
  UpdateUserProfilePatch,
  UserRecord,
  UserSettingsRecord,
  WordRecord,
  WordRepository,
  WordWithProgress,
} from "../repository.ts";

/**
 * 内存测试替身：在没有 MySQL 的环境下提供与 MySQL 实现一致的语义
 * （按用户唯一词条、导入合并、级联删除、kill/restore/undo-kill、会话撤销与过期）。
 *
 * 明确局限：它不是 MySQL 集成测试，不能证明 SQL、索引或约束正确。
 */

export type FakeRepositoryOptions = {
  /** 只影响 /api/ready 的探针结果，用于覆盖数据库不可用分支。 */
  ready?: boolean;
};

export type FakeRepository = WordRepository & {
  setReady(ready: boolean): void;
  seedUser(input: NewUserInput): UserRecord;
  /** 直接读取内部记录，仅用于断言（例如确认没有误删别人的词）。 */
  snapshotWords(userId: string): WordRecord[];
  snapshotProgress(userId: string, wordId: string): ProgressRecord | null;
  snapshotEvents(userId: string): LearningEventRecord[];
  snapshotDrafts(userId: string): ReviewDraftRecord[];
  snapshotSettings(userId: string): UserSettingsRecord | null;
  snapshotSubmissions(userId: string): { submissionKey: string; kind: SubmissionKind }[];
  /**
   * 测试钩子：第 N 条已暂存条目后抛出，用于验证整批回滚不会留下半批写入。
   * 只影响下一次完成提交，触发后自动关闭。
   */
  setCompletionFailureAfter(completedEntries: number | null): void;
};

const progressKey = (userId: string, wordId: string): string => `${userId}:${wordId}`;

export function createFakeRepository(options: FakeRepositoryOptions = {}): FakeRepository {
  let ready = options.ready ?? true;
  const users = new Map<string, UserRecord>();
  const userIdByEmail = new Map<string, string>();
  const sessions = new Map<string, SessionRecord>();
  const words = new Map<string, WordRecord>();
  const progress = new Map<string, ProgressRecord>();
  const settings = new Map<string, UserSettingsRecord>();
  const events: LearningEventRecord[] = [];
  const drafts = new Map<string, ReviewDraftRecord>();
  const submissions = new Map<string, { kind: SubmissionKind; result: CompletionOutcome }>();
  let failAfter: number | null = null;
  const nowIso = (): string => new Date().toISOString();

  const ownedWords = (userId: string): WordRecord[] =>
    Array.from(words.values()).filter((word) => word.userId === userId);

  const createProgress = (userId: string, wordId: string): ProgressRecord => {
    const timestamp = nowIso();
    const record: ProgressRecord = {
      id: newId("progress"),
      userId,
      wordId,
      reviewStage: 0,
      recognitionScore: 0,
      spellingScore: 0,
      firstLearnedAt: null,
      nextReviewAt: timestamp,
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
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    progress.set(progressKey(userId, wordId), record);
    return record;
  };

  const toSnapshot = (record: ProgressRecord): ProgressRuleSnapshot => ({
    reviewStage: record.reviewStage,
    recognitionScore: record.recognitionScore,
    spellingScore: record.spellingScore,
    firstLearnedAt: record.firstLearnedAt,
    lastReviewAt: record.lastReviewAt,
    nextReviewAt: record.nextReviewAt,
    lastRecognitionChoice: record.lastRecognitionChoice,
    lastRecognitionResult: record.lastRecognitionResult,
    lastSpellingResult: record.lastSpellingResult,
    lastGrade: record.lastGrade,
    reviewCount: record.reviewCount,
    correctCount: record.correctCount,
    wrongCount: record.wrongCount,
    updatedAt: record.updatedAt,
    killedAt: record.killedAt,
  });

  const withRuleState = (record: ProgressRecord, state: ProgressRuleState): ProgressRecord => ({
    ...record,
    ...state,
    version: record.version + 1,
  });

  const defaultSettings = (userId: string): UserSettingsRecord => {
    const user = users.get(userId);
    const timestamp = nowIso();
    return {
      userId,
      dailyTarget: 20,
      dailyGroups: 2,
      dailyGroupWords: 10,
      dailyPlanConfigured: false,
      timezone: user?.timezone ?? "Asia/Shanghai",
      countdownLabel: null,
      countdownTargetDate: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  };

  const runCompletion = async (
    kind: SubmissionKind,
    userId: string,
    input: CompletionInput,
  ): Promise<CompletionOutcome> => {
    const key = `${userId}:${input.submissionKey}`;
    const previous = submissions.get(key);
    if (previous) return { ...previous.result, duplicate: true };

    const completedAt = new Date();
    const staged = new Map<string, ProgressRecord>();
    const stagedEvents: LearningEventRecord[] = [];
    const results: EntryOutcome[] = [];
    const grades: Record<ReviewGrade, number> = { again: 0, hard: 0, good: 0, easy: 0 };
    const nextDates: string[] = [];
    let completed = 0;
    let conflicts = 0;
    let skipped = 0;
    let corrected = 0;

    for (const entry of input.entries) {
      const current = staged.get(progressKey(userId, entry.wordId)) ?? progress.get(progressKey(userId, entry.wordId)) ?? null;
      const word = words.get(entry.wordId);
      const normalizedEntry = entry.spelling && word
        ? {
            ...entry,
            spelling: {
              ...entry.spelling,
              // 客户端的 correct 只为兼容协议；服务端按当前词条重新计算。
              correct: isSpellingAnswerCorrect(entry.spelling.input, word.word),
            },
          }
        : entry;
      const decision: EntryDecision = kind === "new"
        ? decideNewStudyEntry(current ? toSnapshot(current) : null, normalizedEntry, completedAt)
        : kind === "review"
          ? decideReviewEntry(current ? toSnapshot(current) : null, normalizedEntry, completedAt)
          : decideSpellingEntry(current ? toSnapshot(current) : null, normalizedEntry, completedAt);
      if (decision.status !== "completed") {
        if (decision.status === "conflict") conflicts += 1;
        else skipped += 1;
        results.push({ wordId: entry.wordId, status: decision.status, reason: decision.reason });
        continue;
      }
      if (!current) throw new Error("完成提交状态异常：缺少进度行。");
      staged.set(progressKey(userId, entry.wordId), withRuleState(current, decision.state));
      completed += 1;
      if (decision.grade) grades[decision.grade] += 1;
      if (decision.corrected) corrected += 1;
      nextDates.push(decision.nextReviewAt);
      results.push({ wordId: entry.wordId, status: "completed", reason: null });
      if (decision.eventKind) {
        stagedEvents.push({
          id: newId("event"), userId, wordId: entry.wordId,
          occurredAt: completedAt.toISOString(), kind: decision.eventKind,
          reviewStage: decision.eventStage,
        });
      }
      if (failAfter !== null && completed >= failAfter) {
        failAfter = null;
        throw new Error("测试注入：完成提交中途失败。");
      }
    }

    for (const [progressId, record] of staged) progress.set(progressId, record);
    events.push(...stagedEvents);
    const result: CompletionOutcome = {
      submissionKey: input.submissionKey,
      duplicate: false,
      completed,
      conflicts,
      skipped,
      earliestNextReviewAt: earliestIso(nextDates),
      results,
      ...(kind === "review" ? { grades } : {}),
      ...(kind === "spelling" ? { corrected } : {}),
    };
    submissions.set(key, { kind, result });
    return result;
  };

  const repository: FakeRepository = {
    setReady(value: boolean) {
      ready = value;
    },

    seedUser(input: NewUserInput): UserRecord {
      const timestamp = nowIso();
      const email = input.email.trim().toLowerCase();
      if (userIdByEmail.has(email)) throw new Error("邮箱已存在。");
      const user: UserRecord = {
        id: input.id,
        email,
        passwordHash: input.passwordHash,
        username: input.username ?? null,
        avatar: input.avatar ?? null,
        timezone: input.timezone ?? "Asia/Shanghai",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      users.set(user.id, user);
      userIdByEmail.set(email, user.id);
      return user;
    },

    snapshotWords(userId: string): WordRecord[] {
      return ownedWords(userId).map((word) => ({ ...word }));
    },

    snapshotProgress(userId: string, wordId: string): ProgressRecord | null {
      const record = progress.get(progressKey(userId, wordId));
      return record ? { ...record } : null;
    },

    async checkReadiness() {
      if (!ready) throw new Error("数据库不可用（测试替身）。");
    },

    async findUserByEmail(email: string) {
      const id = userIdByEmail.get(email.trim().toLowerCase());
      return id ? (users.get(id) ?? null) : null;
    },

    async findUserById(id: string) {
      return users.get(id) ?? null;
    },

    async createUser(input: NewUserInput) {
      return this.seedUser(input);
    },

    async updateUserProfile(userId: string, patch: UpdateUserProfilePatch) {
      const current = users.get(userId);
      if (!current) return null;
      const updated: UserRecord = {
        ...current,
        username: patch.username,
        avatar: patch.avatar,
        updatedAt: nowIso(),
      };
      users.set(userId, updated);
      return updated;
    },

    async createSession(input: NewSessionInput): Promise<SessionRecord> {
      const record: SessionRecord = {
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: new Date(input.expiresAt).toISOString(),
        revokedAt: null,
        createdAt: nowIso(),
      };
      sessions.set(record.tokenHash, record);
      return record;
    },

    async findActiveSessionByTokenHash(
      tokenHash: string,
      now: string,
    ): Promise<SessionWithUser | null> {
      const session = sessions.get(tokenHash);
      if (!session || session.revokedAt !== null) return null;
      if (Date.parse(session.expiresAt) <= Date.parse(now)) return null;
      const user = users.get(session.userId);
      return user ? { session, user } : null;
    },

    async revokeSession(tokenHash: string, revokedAt: string) {
      const session = sessions.get(tokenHash);
      if (!session || session.revokedAt !== null) return false;
      session.revokedAt = revokedAt;
      return true;
    },

    async countWords(userId: string) {
      return ownedWords(userId).length;
    },

    async listWords(userId: string, options: ListWordsOptions): Promise<WordWithProgress[]> {
      const pairs = ownedWords(userId)
        .sort((a, b) => a.normalizedWord.localeCompare(b.normalizedWord) || a.id.localeCompare(b.id))
        .map((word) => {
          const record = progress.get(progressKey(userId, word.id)) ?? createProgress(userId, word.id);
          return { word, progress: record };
        });
      return pairs.slice(options.offset, options.offset + options.limit);
    },

    async getWord(userId: string, wordId: string): Promise<WordWithProgress | null> {
      const word = words.get(wordId);
      if (!word || word.userId !== userId) return null;
      const record = progress.get(progressKey(userId, wordId)) ?? createProgress(userId, wordId);
      return { word: { ...word }, progress: { ...record } };
    },

    async importWords(userId: string, inputs: NormalizedWordInput[]): Promise<ImportResult> {
      let added = 0;
      let existing = 0;
      for (const input of inputs) {
        const current = ownedWords(userId).find(
          (word) => word.normalizedWord === input.normalizedWord,
        );
        if (current) {
          existing += 1;
          Object.assign(current, mergeWordFields(current, input), { updatedAt: nowIso() });
          continue;
        }
        added += 1;
        const timestamp = nowIso();
        const created: WordRecord = {
          id: newId("word"),
          userId,
          normalizedWord: input.normalizedWord,
          word: input.word,
          phonetic: input.phonetic,
          meaning: input.meaning,
          phrase: input.phrase,
          sentence: input.sentence,
          sentenceCn: input.sentenceCn,
          source: input.source,
          type: input.type,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        words.set(created.id, created);
        createProgress(userId, created.id);
      }
      return { added, existing };
    },

    async updateWord(userId: string, wordId: string, patch: UpdateWordPatch) {
      const word = words.get(wordId);
      if (!word || word.userId !== userId) return null;
      word.phonetic = patch.phonetic ?? word.phonetic;
      word.meaning = patch.meaning ?? word.meaning;
      word.updatedAt = nowIso();
      return { ...word };
    },

    async deleteWord(userId: string, wordId: string) {
      const word = words.get(wordId);
      if (!word || word.userId !== userId) return false;
      words.delete(wordId);
      progress.delete(progressKey(userId, wordId));
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.userId === userId && events[index]?.wordId === wordId) events.splice(index, 1);
      }
      return true;
    },

    async killWord(userId: string, wordId: string) {
      const word = words.get(wordId);
      if (!word || word.userId !== userId) return null;
      const record = progress.get(progressKey(userId, wordId)) ?? createProgress(userId, wordId);
      const timestamp = nowIso();
      record.killedAt = timestamp;
      record.updatedAt = timestamp;
      return { ...record };
    },

    async restoreWord(userId: string, wordId: string) {
      const word = words.get(wordId);
      if (!word || word.userId !== userId) return null;
      const record = progress.get(progressKey(userId, wordId)) ?? createProgress(userId, wordId);
      const timestamp = nowIso();
      record.killedAt = null;
      record.lastRestoredAt = timestamp;
      record.reviewStage = Math.min(record.reviewStage, 2);
      record.nextReviewAt = timestamp;
      record.updatedAt = timestamp;
      return { ...record };
    },

    async undoKillWord(userId: string, wordId: string) {
      const word = words.get(wordId);
      if (!word || word.userId !== userId) return null;
      const record = progress.get(progressKey(userId, wordId)) ?? createProgress(userId, wordId);
      record.killedAt = null;
      record.updatedAt = nowIso();
      return { ...record };
    },

    async ensureUserSettings(userId: string) {
      const current = settings.get(userId) ?? defaultSettings(userId);
      settings.set(userId, current);
      return { ...current };
    },

    async updateUserSettings(userId: string, patch: UpdateSettingsPatch) {
      const current = await this.ensureUserSettings(userId);
      const next: UserSettingsRecord = {
        ...current,
        dailyTarget: patch.dailyTarget ?? current.dailyTarget,
        dailyGroups: patch.dailyGroups ?? current.dailyGroups,
        dailyGroupWords: patch.dailyGroupWords ?? current.dailyGroupWords,
        timezone: patch.timezone ?? current.timezone,
        countdownLabel: patch.countdownLabel === undefined ? current.countdownLabel : patch.countdownLabel,
        countdownTargetDate: patch.countdownTargetDate === undefined ? current.countdownTargetDate : patch.countdownTargetDate,
        dailyPlanConfigured: current.dailyPlanConfigured || patch.dailyGroups !== undefined || patch.dailyGroupWords !== undefined,
        updatedAt: nowIso(),
      };
      settings.set(userId, next);
      const user = users.get(userId);
      if (user && patch.timezone !== undefined) user.timezone = patch.timezone;
      return { ...next };
    },

    async countEvents(userId: string) {
      return events.filter((event) => event.userId === userId).length;
    },

    async listEvents(userId: string, options: { limit: number; offset: number }) {
      return events
        .filter((event) => event.userId === userId)
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(options.offset, options.offset + options.limit)
        .map((event) => ({ ...event }));
    },

    async listDueCandidates(userId: string, now: string, limit: number) {
      const cutoff = Date.parse(now);
      return ownedWords(userId)
        .map((word) => ({ word, progress: progress.get(progressKey(userId, word.id)) ?? createProgress(userId, word.id) }))
        .filter((pair) => !pair.progress.killedAt && Date.parse(pair.progress.nextReviewAt) <= cutoff)
        .sort((a, b) =>
          Number(!a.progress.lastReviewAt) - Number(!b.progress.lastReviewAt) ||
          Date.parse(a.progress.nextReviewAt) - Date.parse(b.progress.nextReviewAt) ||
          a.word.id.localeCompare(b.word.id),
        )
        .slice(0, limit);
    },

    async countWordsLearnedBetween(userId: string, start: string, end: string) {
      const from = Date.parse(start);
      const to = Date.parse(end);
      return ownedWords(userId).filter((word) => {
        const item = progress.get(progressKey(userId, word.id));
        if (!item?.firstLearnedAt) return false;
        const at = Date.parse(item.firstLearnedAt);
        return at >= from && at < to;
      }).length;
    },

    async listWordsLearnedBetween(userId: string, start: string, end: string, limit: number) {
      const from = Date.parse(start);
      const to = Date.parse(end);
      return ownedWords(userId)
        .map((word) => ({ word, progress: progress.get(progressKey(userId, word.id)) ?? createProgress(userId, word.id) }))
        .filter((pair) => {
          const at = pair.progress.firstLearnedAt ? Date.parse(pair.progress.firstLearnedAt) : NaN;
          return !pair.progress.killedAt && Number.isFinite(at) && at >= from && at < to;
        })
        .sort((a, b) => Date.parse(b.progress.firstLearnedAt!) - Date.parse(a.progress.firstLearnedAt!) || Date.parse(b.progress.updatedAt) - Date.parse(a.progress.updatedAt))
        .slice(0, limit);
    },

    async listLibraryWords(userId: string, options: { filter: string | null; limit: number }) {
      const filter = options.filter?.toLowerCase() ?? null;
      return ownedWords(userId)
        .map((word) => ({ word, progress: progress.get(progressKey(userId, word.id)) ?? createProgress(userId, word.id) }))
        .filter((pair) => !pair.progress.killedAt && (filter === null || pair.word.normalizedWord.toLowerCase().includes(filter)))
        .sort((a, b) => a.word.normalizedWord.localeCompare(b.word.normalizedWord) || a.word.id.localeCompare(b.word.id))
        .slice(0, options.limit);
    },

    async getReviewDraft(userId: string, key: string) {
      const draft = drafts.get(`${userId}:${key}`);
      return draft ? { ...draft } : null;
    },

    async saveReviewDraft(userId: string, input: SaveDraftInput): Promise<SaveDraftOutcome> {
      const key = `${userId}:${input.draftKey}`;
      const current = drafts.get(key);
      if (!current && input.revision !== 0) return { status: "conflict", currentRevision: null };
      if (current && current.revision !== input.revision) return { status: "conflict", currentRevision: current.revision };
      const timestamp = nowIso();
      const draft: ReviewDraftRecord = current
        ? { ...current, mode: input.mode, scope: input.scope, phase: input.phase, payload: input.payload, revision: current.revision + 1, updatedAt: timestamp }
        : { id: newId("draft"), userId, draftKey: input.draftKey, version: 1, mode: input.mode, scope: input.scope, phase: input.phase, payload: input.payload, revision: 1, createdAt: timestamp, updatedAt: timestamp };
      drafts.set(key, draft);
      return { status: "saved", draft: { ...draft } };
    },

    async deleteReviewDraft(userId: string, key: string) {
      return drafts.delete(`${userId}:${key}`);
    },

    completeNewStudy(userId: string, input: CompletionInput) {
      return runCompletion("new", userId, input);
    },

    completeReview(userId: string, input: CompletionInput) {
      return runCompletion("review", userId, input);
    },

    completeSpelling(userId: string, input: CompletionInput) {
      return runCompletion("spelling", userId, input);
    },

    snapshotEvents(userId: string) {
      return events.filter((event) => event.userId === userId).map((event) => ({ ...event }));
    },

    snapshotDrafts(userId: string) {
      return Array.from(drafts.values()).filter((draft) => draft.userId === userId).map((draft) => ({ ...draft }));
    },

    snapshotSettings(userId: string) {
      const value = settings.get(userId);
      return value ? { ...value } : null;
    },

    snapshotSubmissions(userId: string) {
      return Array.from(submissions.entries()).filter(([key]) => key.startsWith(`${userId}:`)).map(([key, value]) => ({ submissionKey: key.slice(userId.length + 1), kind: value.kind }));
    },

    setCompletionFailureAfter(completedEntries: number | null) {
      failAfter = completedEntries;
    },

    async close() {
      users.clear();
      userIdByEmail.clear();
      sessions.clear();
      words.clear();
      progress.clear();
      settings.clear();
      events.length = 0;
      drafts.clear();
      submissions.clear();
    },
  };

  return repository;
}
