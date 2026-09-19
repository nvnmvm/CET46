import type { ReviewGrade } from "./schemas.ts";

/**
 * 学习规则的纯函数层。
 *
 * 行为基准是 `app/src/data/localStore.ts`（本批禁止修改它）：
 * interval `1/2/4/7/15/30/60` 天、stage 0—6、score 0—5、认词出错 `again`（stage -2）、
 * 认词正确但拼写出错 `hard`（stage 不变）、stage>=3 且两项历史分 >=3 全对 `easy`（stage +2）、
 * 其他全对 `good`（stage +1）。
 *
 * 这里只做计算，不读写存储：路由、内存测试替身和 MySQL 实现共用同一套函数，
 * 避免出现第二套相互矛盾的算法。服务端永远用这些函数重新计算结果，
 * 不信任客户端提交的 stage、score、nextReviewAt。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEW_INTERVALS_DAYS = [1, 2, 4, 7, 15, 30, 60] as const;
export const STAGE_MIN = 0;
export const STAGE_MAX = 6;
export const SCORE_MIN = 0;
export const SCORE_MAX = 5;

export type RecognitionChoice = "known" | "unknown";
export type AnswerResult = "correct" | "wrong";

export type RecognitionInput = {
  firstChoice: RecognitionChoice;
  /** 认词是否出错；服务端只据此计算 grade 与分数，不使用客户端给出的最终结果。 */
  hadError: boolean;
  attempts: number;
};

export type SpellingInput = {
  input: string;
  /** 服务端会根据词条重新计算；客户端字段只为兼容现有前端协议。 */
  correct: boolean;
  hadError: boolean;
};

/** 与 localStore.checkSpelling 一致；完成接口必须在服务端重新计算。 */
export function isSpellingAnswerCorrect(input: string, expectedWord: string): boolean {
  return input.trim().toLowerCase() === expectedWord.trim().toLowerCase();
}

/** 进度中与规则相关的字段；`ProgressRecord` 结构上满足它。 */
export type ProgressRuleState = {
  reviewStage: number;
  recognitionScore: number;
  spellingScore: number;
  firstLearnedAt: string | null;
  lastReviewAt: string | null;
  nextReviewAt: string;
  lastRecognitionChoice: RecognitionChoice | null;
  lastRecognitionResult: AnswerResult | null;
  lastSpellingResult: AnswerResult | null;
  lastGrade: ReviewGrade | null;
  reviewCount: number;
  correctCount: number;
  wrongCount: number;
  updatedAt: string;
};

/** 决策输入：规则字段加上斩词状态。 */
export type ProgressRuleSnapshot = ProgressRuleState & { killedAt: string | null };

export type DailyPlanSettings = {
  dailyTarget: number;
  dailyGroups: number;
  dailyGroupWords: number;
  dailyPlanConfigured: boolean;
};

export function clampStage(value: number): number {
  return Math.max(STAGE_MIN, Math.min(STAGE_MAX, value));
}

export function clampScore(value: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, value));
}

/**
 * 与 localStore.nextUpdatedAt 一致：updatedAt 必须严格递增，
 * 否则同一毫秒内的两次写入会因为时间戳相同而被后续版本校验误判为旧版本。
 */
export function nextUpdatedAt(previousIso: string, now: Date): string {
  const previous = Date.parse(previousIso);
  const base = Number.isFinite(previous)
    ? Math.max(now.getTime(), previous + 1)
    : now.getTime();
  return new Date(base).toISOString();
}

export function nextReviewAtForStage(stage: number, completedAt: Date): string {
  const days = REVIEW_INTERVALS_DAYS[clampStage(stage)];
  return new Date(completedAt.getTime() + days * DAY_MS).toISOString();
}

function baseProgress(state: ProgressRuleState): ProgressRuleState {
  return { ...state };
}

/** 新学完成：不伪造认词/拼写成绩，只设置 firstLearnedAt、lastReviewAt 和明天到期。 */
export function applyNewStudy(state: ProgressRuleState, completedAt: Date): ProgressRuleState {
  const completedAtIso = completedAt.toISOString();
  const next = baseProgress(state);
  next.reviewStage = 0;
  next.firstLearnedAt = completedAtIso;
  next.lastReviewAt = completedAtIso;
  next.lastRecognitionChoice = null;
  next.lastRecognitionResult = null;
  next.lastSpellingResult = null;
  next.lastGrade = null;
  next.nextReviewAt = nextReviewAtForStage(0, completedAt);
  next.updatedAt = nextUpdatedAt(state.updatedAt, completedAt);
  return next;
}

export type ReviewDecision = { grade: ReviewGrade; reviewStage: number };

export function decideReviewGrade(
  state: Pick<ProgressRuleState, "reviewStage" | "recognitionScore" | "spellingScore">,
  recognition: RecognitionInput,
  spelling: SpellingInput,
): ReviewDecision {
  if (recognition.hadError) {
    return { grade: "again", reviewStage: clampStage(state.reviewStage - 2) };
  }
  if (spelling.hadError) {
    return { grade: "hard", reviewStage: clampStage(state.reviewStage) };
  }
  if (state.reviewStage >= 3 && state.recognitionScore >= 3 && state.spellingScore >= 3) {
    return { grade: "easy", reviewStage: clampStage(state.reviewStage + 2) };
  }
  return { grade: "good", reviewStage: clampStage(state.reviewStage + 1) };
}

/**
 * 复习完成。调用方必须先确认拼写答案存在且 `correct === true`（与 localStore 的
 * `!spellingAnswer.correct) return` 一致），否则本条不应计分。
 */
export function applyReview(
  state: ProgressRuleState,
  recognition: RecognitionInput,
  spelling: SpellingInput,
  completedAt: Date,
): { state: ProgressRuleState; grade: ReviewGrade } {
  const decision = decideReviewGrade(state, recognition, spelling);
  const next = baseProgress(state);
  next.reviewStage = decision.reviewStage;
  next.recognitionScore = clampScore(state.recognitionScore + (recognition.hadError ? -1 : 1));
  next.spellingScore = clampScore(state.spellingScore + (spelling.hadError ? -1 : 1));
  next.nextReviewAt = nextReviewAtForStage(decision.reviewStage, completedAt);
  if (!state.lastReviewAt) next.firstLearnedAt = completedAt.toISOString();
  next.lastReviewAt = completedAt.toISOString();
  next.lastRecognitionChoice = recognition.firstChoice;
  next.lastRecognitionResult = recognition.hadError ? "wrong" : "correct";
  next.lastSpellingResult = spelling.hadError ? "wrong" : "correct";
  next.lastGrade = decision.grade;
  next.reviewCount = state.reviewCount + 1;
  next.correctCount = state.correctCount + (recognition.hadError ? 0 : 1);
  next.wrongCount = state.wrongCount + (recognition.hadError ? 1 : 0);
  next.updatedAt = nextUpdatedAt(state.updatedAt, completedAt);
  return { state: next, grade: decision.grade };
}

/**
 * 独立拼写完成：只更新拼写表现，不推进 stage、不写 review 事件；
 * 拼错时下次复习不晚于明天。
 */
export function applySpelling(
  state: ProgressRuleState,
  spelling: SpellingInput,
  completedAt: Date,
): { state: ProgressRuleState; corrected: boolean } {
  const next = baseProgress(state);
  next.spellingScore = clampScore(state.spellingScore + (spelling.hadError ? -1 : 1));
  next.lastSpellingResult = spelling.hadError ? "wrong" : "correct";
  if (spelling.hadError) {
    const retryAt = new Date(completedAt.getTime() + DAY_MS).toISOString();
    if (Date.parse(state.nextReviewAt) > Date.parse(retryAt)) next.nextReviewAt = retryAt;
  }
  next.updatedAt = nextUpdatedAt(state.updatedAt, completedAt);
  return { state: next, corrected: spelling.hadError };
}

// ---------------------------------------------------------------------------
// 逐条决策：路由与 MySQL 实现都通过它判断“本条该写入、跳过还是冲突”。
// ---------------------------------------------------------------------------

export type EntryDecision =
  | {
      status: "completed";
      state: ProgressRuleState;
      grade: ReviewGrade | null;
      corrected: boolean;
      eventKind: "new" | "review" | null;
      eventStage: number;
      nextReviewAt: string;
    }
  | { status: "conflict"; reason: string }
  | { status: "skipped"; reason: string };

export type CompletionEntryVersion = {
  wordId: string;
  updatedAt: string;
  nextReviewAt: string;
};

export type NewStudyEntry = CompletionEntryVersion;
export type ReviewEntry = CompletionEntryVersion & {
  recognition?: RecognitionInput;
  spelling?: SpellingInput;
};
export type SpellingEntry = CompletionEntryVersion & { spelling?: SpellingInput };

const versionMismatch = (
  progress: ProgressRuleSnapshot,
  entry: CompletionEntryVersion,
): boolean =>
  progress.updatedAt !== entry.updatedAt || progress.nextReviewAt !== entry.nextReviewAt;

export function decideNewStudyEntry(
  progress: ProgressRuleSnapshot | null,
  entry: NewStudyEntry,
  completedAt: Date,
): EntryDecision {
  if (!progress) return { status: "skipped", reason: "not_found" };
  if (progress.killedAt) return { status: "conflict", reason: "killed" };
  if (progress.lastReviewAt) return { status: "skipped", reason: "already_learned" };
  if (versionMismatch(progress, entry)) return { status: "conflict", reason: "version_mismatch" };
  const next = applyNewStudy(progress, completedAt);
  return {
    status: "completed",
    state: next,
    grade: null,
    corrected: false,
    eventKind: "new",
    eventStage: next.reviewStage,
    nextReviewAt: next.nextReviewAt,
  };
}

export function decideReviewEntry(
  progress: ProgressRuleSnapshot | null,
  entry: ReviewEntry,
  completedAt: Date,
): EntryDecision {
  if (!progress) return { status: "skipped", reason: "not_found" };
  if (progress.killedAt) return { status: "conflict", reason: "killed" };
  if (!entry.recognition || !entry.spelling) return { status: "skipped", reason: "missing_answer" };
  if (!entry.spelling.correct) return { status: "skipped", reason: "spelling_incorrect" };
  if (versionMismatch(progress, entry)) return { status: "conflict", reason: "version_mismatch" };
  const applied = applyReview(progress, entry.recognition, entry.spelling, completedAt);
  return {
    status: "completed",
    state: applied.state,
    grade: applied.grade,
    corrected: false,
    eventKind: "review",
    eventStage: applied.state.reviewStage,
    nextReviewAt: applied.state.nextReviewAt,
  };
}

export function decideSpellingEntry(
  progress: ProgressRuleSnapshot | null,
  entry: SpellingEntry,
  completedAt: Date,
): EntryDecision {
  if (!progress) return { status: "skipped", reason: "not_found" };
  if (progress.killedAt) return { status: "conflict", reason: "killed" };
  if (!entry.spelling) return { status: "skipped", reason: "missing_answer" };
  if (!entry.spelling.correct) return { status: "skipped", reason: "spelling_incorrect" };
  if (!progress.lastReviewAt) return { status: "skipped", reason: "not_learned" };
  if (versionMismatch(progress, entry)) return { status: "conflict", reason: "version_mismatch" };
  const applied = applySpelling(progress, entry.spelling, completedAt);
  return {
    status: "completed",
    state: applied.state,
    grade: null,
    corrected: applied.corrected,
    eventKind: null,
    eventStage: applied.state.reviewStage,
    nextReviewAt: applied.state.nextReviewAt,
  };
}

// ---------------------------------------------------------------------------
// 每日计划与到期队列
// ---------------------------------------------------------------------------

export type QueueableItem = {
  progress: { lastReviewAt: string | null; nextReviewAt: string };
};

/** 与 localStore.getDailyNewLimit 一致：显式设置过组数/每组词数时用乘积，否则用每日目标。 */
export function computeDailyNewLimit(settings: DailyPlanSettings): number {
  return settings.dailyPlanConfigured
    ? settings.dailyGroups * settings.dailyGroupWords
    : settings.dailyTarget;
}

export type DueQueueSelection<T> = {
  reviewWords: T[];
  newWords: T[];
  reviewTotal: number;
  newTotal: number;
  newLimit: number;
  learnedToday: number;
};

/**
 * 到期队列：已学到期复习优先，新词按“每日计划 - 今日已学”扣减。
 *
 * `duePairs` 必须已按 nextReviewAt 升序（fake 与 MySQL 都按这个顺序返回）；
 * 这里再做一次稳定分区，把有 lastReviewAt 的复习词排在前面，与 localStore
 * 的“先按到期时间、再把新词排到末尾”等价。
 */
export function selectDueQueue<T extends QueueableItem>(
  duePairs: T[],
  options: { learnedToday: number; dailyNewLimit: number; limit: number },
): DueQueueSelection<T> {
  const sorted = [...duePairs].sort(
    (a, b) => Date.parse(a.progress.nextReviewAt) - Date.parse(b.progress.nextReviewAt),
  );
  const review = sorted.filter((item) => Boolean(item.progress.lastReviewAt));
  const fresh = sorted.filter((item) => !item.progress.lastReviewAt);
  const remainingNew = Math.max(0, options.dailyNewLimit - options.learnedToday);
  const limit = Math.max(0, Math.floor(options.limit));
  const reviewWords = review.slice(0, limit);
  const newWords = fresh.slice(0, Math.min(remainingNew, Math.max(0, limit - reviewWords.length)));
  return {
    reviewWords,
    newWords,
    reviewTotal: review.length,
    newTotal: fresh.length,
    newLimit: remainingNew,
    learnedToday: options.learnedToday,
  };
}

// ---------------------------------------------------------------------------
// 时区
// ---------------------------------------------------------------------------

/** 用户时区的日历日（YYYY-MM-DD）；无效时区直接抛错，不静默回退。 */
export function calendarDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if (!year || !month || !day) throw new Error("无法解析时区日期。");
  return `${year}-${month}-${day}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/**
 * 用户时区“今天”对应的 UTC 区间 [start, end)。
 * 数据库里存的是 UTC，因此统计“今日已学/今日新学”必须用这个区间过滤，
 * 不能依赖数据库服务器时区或 UTC 日界。
 */
export function dayRangeInTimeZone(date: Date, timeZone: string): { startIso: string; endIso: string } {
  const calendar = calendarDateInTimeZone(date, timeZone);
  const [year, month, day] = calendar.split("-").map(Number);
  const startGuess = Date.UTC(year, month - 1, day);
  const start = startGuess - timeZoneOffsetMs(new Date(startGuess), timeZone);
  const nextGuess = startGuess + DAY_MS;
  const end = nextGuess - timeZoneOffsetMs(new Date(nextGuess), timeZone);
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

/** 较早的 ISO 时间；空数组返回 null（与 localStore 的 nextDates.sort()[0] ?? null 等价）。 */
export function earliestIso(values: string[]): string | null {
  let earliest: string | null = null;
  for (const value of values) {
    if (earliest === null || Date.parse(value) < Date.parse(earliest)) earliest = value;
  }
  return earliest;
}
