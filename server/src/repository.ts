import type { NormalizedWordInput, ReviewGrade, UpdateWordPatch, WordType } from "./schemas.ts";
import type { RecognitionInput, SpellingInput } from "./learningRules.ts";

/**
 * 数据访问契约。
 *
 * 路由层只依赖本接口：MySQL 实现用于真实运行，测试用内存 double（server/src/testing/fakeRepository.ts）
 * 提供同样的语义。这样在没有任何 MySQL 的环境下也能验证认证与越权逻辑。
 *
 * 所有时间字段都是 UTC ISO 8601 字符串（例如 2026-09-19T04:26:00.000Z）。
 */

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  username: string | null;
  avatar: string | null;
  timezone: string;
  role: "admin" | "learner";
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class RepositoryConflictError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "RepositoryConflictError";
    this.code = code;
  }
}

export class RepositoryForbiddenError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "RepositoryForbiddenError";
    this.code = code;
  }
}

/** 登录校验与账号状态变更竞态时，拒绝创建已经失效的会话。 */
export class RepositorySessionRejectedError extends Error {
  readonly code: string;

  constructor(code = "session_rejected") {
    super(code);
    this.name = "RepositorySessionRejectedError";
    this.code = code;
  }
}

export type SessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export type SessionWithUser = { session: SessionRecord; user: UserRecord };

export type WordRecord = {
  id: string;
  userId: string;
  normalizedWord: string;
  word: string;
  phonetic: string;
  meaning: string;
  phrase: string;
  sentence: string;
  sentenceCn: string;
  source: string;
  type: WordType;
  createdAt: string;
  updatedAt: string;
};

export type ProgressRecord = {
  id: string;
  userId: string;
  wordId: string;
  reviewStage: number;
  recognitionScore: number;
  spellingScore: number;
  firstLearnedAt: string | null;
  nextReviewAt: string;
  lastReviewAt: string | null;
  lastRecognitionChoice: "known" | "unknown" | null;
  lastRecognitionResult: "correct" | "wrong" | null;
  lastSpellingResult: "correct" | "wrong" | null;
  lastGrade: ReviewGrade | null;
  killedAt: string | null;
  lastRestoredAt: string | null;
  reviewCount: number;
  correctCount: number;
  wrongCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WordWithProgress = { word: WordRecord; progress: ProgressRecord };

export type NewUserInput = {
  id: string;
  email: string;
  passwordHash: string;
  username?: string | null;
  avatar?: string | null;
  timezone?: string;
  /** 仅受控 bootstrap/test 使用；普通 API 创建始终省略，默认 learner。 */
  role?: "admin" | "learner";
};

export type AdminUserListOptions = { limit: number; offset: number };
export type AdminUserList = { users: UserRecord[]; total: number };

/** 账号资料只允许用户修改展示字段；邮箱、密码和时区走各自受控流程。 */
export type UpdateUserProfilePatch = { username: string; avatar: string | null };

export type NewSessionInput = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  /** 登录先校验的密码摘要；若提供，创建会话时须在用户行锁内再次确认。 */
  expectedPasswordHash?: string;
};

export type ImportResult = { added: number; existing: number };

export type ListWordsOptions = { limit: number; offset: number };

// ---------------------------------------------------------------------------
// 第二批：设置、事件、学习队列、草稿与完成提交
// ---------------------------------------------------------------------------

export type UserSettingsRecord = {
  userId: string;
  dailyTarget: number;
  dailyGroups: number;
  dailyGroupWords: number;
  /** 是否显式设置过组数/每组词数；决定每日新词上限用乘积还是每日目标（对齐 localStore）。 */
  dailyPlanConfigured: boolean;
  timezone: string;
  countdownLabel: string | null;
  countdownTargetDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdateSettingsPatch = {
  dailyTarget?: number;
  dailyGroups?: number;
  dailyGroupWords?: number;
  timezone?: string;
  countdownLabel?: string | null;
  countdownTargetDate?: string | null;
};

export type LearningEventRecord = {
  id: string;
  userId: string;
  wordId: string;
  occurredAt: string;
  kind: "new" | "review";
  reviewStage: number;
};

export type DraftMode = "all" | "new" | "review" | "spell";
export type DraftScope = "daily" | "library";
export type DraftPhase = "learning" | "recognition" | "summary" | "spelling";

export type ReviewDraftRecord = {
  id: string;
  userId: string;
  draftKey: string;
  version: number;
  mode: DraftMode | null;
  scope: DraftScope | null;
  phase: DraftPhase | null;
  payload: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type SaveDraftInput = {
  draftKey: string;
  /** 客户端读到的 revision；0 表示“本地没有草稿”。 */
  revision: number;
  mode: DraftMode | null;
  scope: DraftScope | null;
  phase: DraftPhase | null;
  payload: unknown;
  payloadBytes: number;
};

export type SaveDraftOutcome =
  | { status: "saved"; draft: ReviewDraftRecord }
  | { status: "conflict"; currentRevision: number | null };

export type SubmissionKind = "new" | "review" | "spelling";

export type CompletionEntryInput = {
  wordId: string;
  /** 客户端提交时看到的版本信息，只用于冲突判定，不作为最终结果。 */
  updatedAt: string;
  nextReviewAt: string;
  recognition?: RecognitionInput;
  spelling?: SpellingInput;
};

export type CompletionInput = { submissionKey: string; entries: CompletionEntryInput[] };

export type EntryOutcomeStatus = "completed" | "conflict" | "skipped";
export type EntryOutcome = { wordId: string; status: EntryOutcomeStatus; reason: string | null };

export type CompletionOutcome = {
  submissionKey: string;
  /** true 表示同一 submissionKey 之前已经提交过，本次直接返回第一次的结果，不重复计分。 */
  duplicate: boolean;
  completed: number;
  conflicts: number;
  skipped: number;
  /** 仅独立拼写接口使用。 */
  corrected?: number;
  /** 仅复习接口使用。 */
  grades?: Record<ReviewGrade, number>;
  earliestNextReviewAt: string | null;
  results: EntryOutcome[];
};

export type WordRepository = {
  /** 就绪探针：任何失败都必须抛出，由 /api/ready 转成非 2xx。 */
  checkReadiness(): Promise<void>;

  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(input: NewUserInput): Promise<UserRecord>;
  updateUserProfile(userId: string, patch: UpdateUserProfilePatch): Promise<UserRecord | null>;
  adminListUsers(options: AdminUserListOptions): Promise<AdminUserList>;
  adminCreateUser(actorUserId: string, input: NewUserInput): Promise<UserRecord>;
  adminUpdateUser(actorUserId: string, targetUserId: string, patch: { email?: string; username?: string | null }): Promise<UserRecord | null>;
  adminDeleteUser(actorUserId: string, targetUserId: string): Promise<boolean>;
  adminSetUserDisabled(actorUserId: string, targetUserId: string, disabled: boolean): Promise<UserRecord | null>;
  adminResetUserPassword(actorUserId: string, targetUserId: string, passwordHash: string): Promise<UserRecord | null>;
  promoteUserToAdmin(userId: string): Promise<UserRecord | null>;

  createSession(input: NewSessionInput): Promise<SessionRecord>;
  findActiveSessionByTokenHash(tokenHash: string, now: string): Promise<SessionWithUser | null>;
  revokeSession(tokenHash: string, revokedAt: string): Promise<boolean>;

  countWords(userId: string): Promise<number>;
  listWords(userId: string, options: ListWordsOptions): Promise<WordWithProgress[]>;
  getWord(userId: string, wordId: string): Promise<WordWithProgress | null>;
  importWords(userId: string, inputs: NormalizedWordInput[]): Promise<ImportResult>;
  updateWord(userId: string, wordId: string, patch: UpdateWordPatch): Promise<WordRecord | null>;
  deleteWord(userId: string, wordId: string): Promise<boolean>;

  killWord(userId: string, wordId: string): Promise<ProgressRecord | null>;
  restoreWord(userId: string, wordId: string): Promise<ProgressRecord | null>;
  undoKillWord(userId: string, wordId: string): Promise<ProgressRecord | null>;

  /** 读取用户设置；没有记录时按默认值创建（默认值与 localStore 一致）。 */
  ensureUserSettings(userId: string): Promise<UserSettingsRecord>;
  updateUserSettings(userId: string, patch: UpdateSettingsPatch): Promise<UserSettingsRecord>;

  countEvents(userId: string): Promise<number>;
  listEvents(userId: string, options: { limit: number; offset: number }): Promise<LearningEventRecord[]>;

  /** 已学到期的候选词（未斩、next_review_at <= now），按 next_review_at 升序；由纯函数再分区。 */
  listDueCandidates(userId: string, nowIso: string, limit: number): Promise<WordWithProgress[]>;
  countWordsLearnedBetween(userId: string, startIso: string, endIso: string): Promise<number>;
  /** 指定 UTC 区间内第一次完成新学的词，按 first_learned_at 倒序。 */
  listWordsLearnedBetween(
    userId: string,
    startIso: string,
    endIso: string,
    limit: number,
  ): Promise<WordWithProgress[]>;
  /** 词库范围拼写候选：未斩词，可选按单词子串过滤（参数化 LIKE），按 normalized_word 升序。 */
  listLibraryWords(
    userId: string,
    options: { filter: string | null; limit: number },
  ): Promise<WordWithProgress[]>;

  getReviewDraft(userId: string, draftKey: string): Promise<ReviewDraftRecord | null>;
  saveReviewDraft(userId: string, input: SaveDraftInput): Promise<SaveDraftOutcome>;
  deleteReviewDraft(userId: string, draftKey: string): Promise<boolean>;

  /**
   * 完成提交：整批在一个事务内完成“幂等键 + 逐条冲突判定 + 进度/事件写入”。
   * 同一 submissionKey 重复提交返回第一次的结果，不重复计分。
   */
  completeNewStudy(userId: string, input: CompletionInput): Promise<CompletionOutcome>;
  completeReview(userId: string, input: CompletionInput): Promise<CompletionOutcome>;
  completeSpelling(userId: string, input: CompletionInput): Promise<CompletionOutcome>;

  close(): Promise<void>;
};
