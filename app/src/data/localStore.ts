import type {
  LocalDatabase,
  LocalProfile,
  LocalStorageStatus,
  LocalUser,
  CountdownSettings,
  LearningEvent,
  Progress,
  RecognitionResponse,
  ReviewCompletion,
  ReviewDraft,
  ReviewGrade,
  SpellingResponse,
  ThemeMode,
  Word,
  WordInput,
  WordWithProgress,
} from "../types";

const STORAGE_KEY = "cet-word-mvp-local-v1";
const REVIEW_DRAFT_PREFIX = "cet-word-mvp-review-draft-v1:";
const RECOVERY_KEY = "cet-word-mvp-recovery-v1:last";
const AUTO_BACKUP_PREFIX = "cet-word-mvp-auto-backup-v1:";
const DAILY_GROUPS_PREFIX = "cet-word-mvp-daily-groups-v1:";
const DAILY_GROUP_WORDS_PREFIX = "cet-word-mvp-daily-group-words-v1:";
const THEME_MODE_KEY = "cet-word-mvp-theme-v1";
const USER_PROFILE_PREFIX = "cet-word-mvp-user-profile-v1:";
const COUNTDOWN_PREFIX = "cet-word-mvp-countdown-v1:";
const DEFAULT_AVATAR = "◎";
const DEFAULT_DAILY_GROUP_WORDS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVALS = [1, 2, 4, 7, 15, 30, 60];

const emptyDatabase = (): LocalDatabase => ({ version: 1, session: null, words: [], progress: [], learningEvents: [] });

let storageStatus: LocalStorageStatus | null = null;
let damagedRaw: string | null = null;

function protectDamagedData(raw: string, message: string) {
  damagedRaw = raw;
  storageStatus = { kind: "corrupt", message };
  try {
    localStorage.setItem(RECOVERY_KEY, raw);
  } catch {
    storageStatus = {
      kind: "corrupt",
      message: "浏览器存储不可用，无法读取或保护本机数据。请检查无痕模式、存储空间或浏览器权限。",
    };
  }
}

const id = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function addLearningEvent(database: LocalDatabase, event: Omit<LearningEvent, "id">) {
  const events = database.learningEvents ?? (database.learningEvents = []);
  events.push({ id: id("learning-event"), ...event });
  // 仅保留最近 5,000 条，避免长期使用时本机存储无限增长。
  if (events.length > 5000) database.learningEvents = events.slice(-5000);
}

const clampScore = (value: number) => Math.max(0, Math.min(5, value));
const nextUpdatedAt = (previous: string, now: Date) => {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(now.getTime(), Number.isFinite(previousTime) ? previousTime + 1 : now.getTime())).toISOString();
};

function hasConfiguredDailyPlan(userId: string) {
  try {
    return localStorage.getItem(`${DAILY_GROUPS_PREFIX}${userId}`) !== null || localStorage.getItem(`${DAILY_GROUP_WORDS_PREFIX}${userId}`) !== null;
  } catch {
    return false;
  }
}

function read(): LocalDatabase {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) { storageStatus = null; return emptyDatabase(); }
    const parsed = JSON.parse(value) as LocalDatabase;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.words) || !Array.isArray(parsed.progress) || parsed.words.some(w => !w || typeof w.word !== "string") || parsed.progress.some(p => !p || !Number.isFinite(Date.parse(p.nextReviewAt)))) {
      protectDamagedData(value, "检测到本机数据格式异常，已保护原始内容并暂停写入，避免覆盖原有数据。");
      return emptyDatabase();
    }
    storageStatus = null;
    return {
      ...parsed,
      words: parsed.words.map((word) => ({ ...word, phonetic: word.phonetic ?? "" })),
      progress: parsed.progress.map((item) => ({
        ...item,
        lastGrade: item.lastGrade ?? null,
        killedAt: item.killedAt ?? null,
        lastRestoredAt: item.lastRestoredAt ?? null,
        reviewCount: Number.isInteger(item.reviewCount) && item.reviewCount! >= 0 ? item.reviewCount : 0,
        correctCount: Number.isInteger(item.correctCount) && item.correctCount! >= 0 ? item.correctCount : 0,
        wrongCount: Number.isInteger(item.wrongCount) && item.wrongCount! >= 0 ? item.wrongCount : 0,
      })),
      learningEvents: Array.isArray(parsed.learningEvents) ? parsed.learningEvents.filter((event): event is LearningEvent =>
        Boolean(event) && typeof event.userId === "string" && typeof event.wordId === "string" &&
        (event.kind === "new" || event.kind === "review") && Number.isInteger(event.reviewStage) &&
        event.reviewStage >= 0 && event.reviewStage <= 6 && Number.isFinite(Date.parse(event.occurredAt)),
      ) : [],
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) protectDamagedData(raw, "检测到本机数据无法解析，已保护原始内容并暂停写入，避免覆盖原有数据。");
      } catch {
        storageStatus = { kind: "unavailable", message: "浏览器存储不可用，无法读取本机数据。" };
      }
    } else {
      storageStatus = { kind: "unavailable", message: "浏览器存储不可用，无法读取本机数据。" };
    }
    return emptyDatabase();
  }
}

function write(database: LocalDatabase) {
  if (storageStatus) {
    throw new Error("本机数据异常，已暂停写入。请先下载保护副本，恢复备份或开始新的本机档案。");
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  } catch {
    storageStatus = { kind: "unavailable", message: "浏览器无法保存本机数据。请检查存储空间或浏览器权限，暂时不要刷新页面。" };
    throw new Error(storageStatus.message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isWordIdList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const isRecognition = (value: unknown): value is RecognitionResponse =>
  isRecord(value) && (value.firstChoice === "known" || value.firstChoice === "unknown") &&
  (value.result === "correct" || value.result === "wrong") && typeof value.hadError === "boolean" &&
  typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts > 0;
const isSpelling = (value: unknown): value is SpellingResponse =>
  isRecord(value) && typeof value.input === "string" && typeof value.correct === "boolean" && typeof value.hadError === "boolean";

function userIdFor(email: string) {
  return `local:${email.trim().toLowerCase()}`;
}

function legacyUserIdFor(email: string) {
  return `local-${email.trim().toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
}

function defaultProfile(email: string): LocalProfile {
  return { username: email.split("@")[0] || "学习者", avatar: DEFAULT_AVATAR };
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function migrateLegacyUser(database: LocalDatabase, email: string) {
  const nextId = userIdFor(email);
  const legacyId = legacyUserIdFor(email);
  if (nextId === legacyId) return nextId;
  database.words.forEach((word) => {
    if (word.userId === legacyId) word.userId = nextId;
  });
  database.progress.forEach((progress) => {
    if (progress.userId === legacyId) progress.userId = nextId;
  });
  database.learningEvents?.forEach((event) => {
    if (event.userId === legacyId) event.userId = nextId;
  });
  return nextId;
}

function toPairs(database: LocalDatabase, userId: string): WordWithProgress[] {
  const progressMap = new Map(
    database.progress.filter((item) => item.userId === userId).map((item) => [item.wordId, item]),
  );
  return database.words
    .filter((word) => word.userId === userId)
    .map((word) => ({ ...word, progress: progressMap.get(word.id) }))
    .filter((item): item is WordWithProgress => Boolean(item.progress));
}

export const localStore = {
  getThemeMode(): ThemeMode {
    try {
      const value = localStorage.getItem(THEME_MODE_KEY);
      return value === "light" || value === "dark" || value === "system" ? value : "system";
    } catch { return "system"; }
  },

  setThemeMode(value: ThemeMode) {
    if (value !== "system" && value !== "light" && value !== "dark") throw new Error("主题模式无效。");
    localStorage.setItem(THEME_MODE_KEY, value);
  },

  getProfile(userId: string, email: string): LocalProfile {
    const fallback = defaultProfile(email);
    try {
      const raw = localStorage.getItem(`${USER_PROFILE_PREFIX}${userId}`);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<LocalProfile>;
      const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
      const avatar = typeof parsed.avatar === "string" ? parsed.avatar.trim() : "";
      return {
        username: username || fallback.username,
        avatar: avatar || fallback.avatar,
      };
    } catch {
      return fallback;
    }
  },

  updateProfile(userId: string, profile: LocalProfile): LocalUser {
    const username = profile.username.trim().replace(/\s+/g, " ");
    const avatar = profile.avatar.trim();
    if (!username || username.length > 24) throw new Error("用户名不能为空且最多 24 个字符。");
    if (!avatar || avatar.length > 8) throw new Error("请选择有效头像。");
    const database = read();
    if (!database.session || database.session.id !== userId) throw new Error("当前账号已变化，请刷新后重试。");
    const nextUser: LocalUser = { ...database.session, username, avatar };
    localStorage.setItem(`${USER_PROFILE_PREFIX}${userId}`, JSON.stringify({ username, avatar }));
    database.session = nextUser;
    write(database);
    return nextUser;
  },

  getCountdown(userId: string): CountdownSettings | null {
    try {
      const raw = localStorage.getItem(`${COUNTDOWN_PREFIX}${userId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CountdownSettings>;
      const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
      const targetDate = typeof parsed.targetDate === "string" ? parsed.targetDate : "";
      return label && label.length <= 32 && isCalendarDate(targetDate) ? { label, targetDate } : null;
    } catch {
      return null;
    }
  },

  setCountdown(userId: string, countdown: CountdownSettings | null) {
    if (countdown === null) {
      localStorage.removeItem(`${COUNTDOWN_PREFIX}${userId}`);
      return;
    }
    const label = countdown.label.trim().replace(/\s+/g, " ");
    if (!label || label.length > 32) throw new Error("倒数日名称不能为空且最多 32 个字符。");
    if (!isCalendarDate(countdown.targetDate)) throw new Error("请选择有效的目标日期。");
    localStorage.setItem(`${COUNTDOWN_PREFIX}${userId}`, JSON.stringify({ label, targetDate: countdown.targetDate }));
  },

  getDailyTarget(userId: string): number {
    try {
      const value = Number(localStorage.getItem(`cet-word-mvp-target:${userId}`) ?? 20);
      return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 20;
    } catch { return 20; }
  },

  setDailyTarget(userId: string, value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("每日新词目标应为 0—100。");
    localStorage.setItem(`cet-word-mvp-target:${userId}`, String(value));
  },

  getDailyGroups(userId: string): number {
    try {
      const value = Number(localStorage.getItem(`${DAILY_GROUPS_PREFIX}${userId}`) ?? 2);
      return Number.isInteger(value) && value >= 1 && value <= 20 ? value : 2;
    } catch { return 2; }
  },

  setDailyGroups(userId: string, value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error("每天背词组数应为 1—20 组。");
    localStorage.setItem(`${DAILY_GROUPS_PREFIX}${userId}`, String(value));
  },

  getDailyGroupWords(userId: string): number {
    try {
      const value = Number(localStorage.getItem(`${DAILY_GROUP_WORDS_PREFIX}${userId}`) ?? DEFAULT_DAILY_GROUP_WORDS);
      return Number.isInteger(value) && value >= 1 && value <= 20 ? value : DEFAULT_DAILY_GROUP_WORDS;
    } catch { return DEFAULT_DAILY_GROUP_WORDS; }
  },

  setDailyGroupWords(userId: string, value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error("每组单词数应为 1—20 个。");
    localStorage.setItem(`${DAILY_GROUP_WORDS_PREFIX}${userId}`, String(value));
  },

  getDailyNewLimit(userId: string): number {
    return hasConfiguredDailyPlan(userId)
      ? this.getDailyGroups(userId) * this.getDailyGroupWords(userId)
      : this.getDailyTarget(userId);
  },

  updateWord(userId: string, wordId: string, phonetic: string, meaning: string) {
    if (!/^\/[^/]+\/$/.test(phonetic.trim()) || !meaning.trim()) throw new Error("请填写 /.../ 格式音标和中文释义。");
    const database = read();
    const word = database.words.find(item => item.id === wordId && item.userId === userId);
    if (!word) throw new Error("词条已不存在，请刷新词库。");
    word.phonetic = phonetic.trim();
    word.meaning = meaning.trim();
    write(database);
  },
  getStorageStatus(): LocalStorageStatus | null {
    return storageStatus ? { ...storageStatus } : null;
  },

  getDamagedData(): string | null {
    if (damagedRaw !== null) return damagedRaw;
    try {
      return localStorage.getItem(RECOVERY_KEY);
    } catch {
      return null;
    }
  },

  getAutomaticBackup(userId: string): string | null {
    try {
      return localStorage.getItem(`${AUTO_BACKUP_PREFIX}${userId}`);
    } catch {
      return null;
    }
  },

  discardDamagedData() {
    if (storageStatus?.kind !== "corrupt") return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      damagedRaw = null;
      storageStatus = null;
    } catch {
      storageStatus = { kind: "unavailable", message: "浏览器无法清理异常数据。请检查浏览器权限后重试。" };
      throw new Error(storageStatus.message);
    }
  },

  getSession(): LocalUser | null {
    const database = read();
    if (!database.session) return null;
    const nextId = migrateLegacyUser(database, database.session.email);
    if (database.session.id !== nextId) {
      database.session.id = nextId;
      write(database);
    }
    const profile = this.getProfile(nextId, database.session.email);
    return {
      ...database.session,
      username: database.session.username ?? profile.username,
      avatar: database.session.avatar ?? profile.avatar,
    };
  },

  signIn(email: string): LocalUser {
    const normalized = email.trim().toLowerCase();
    const id = userIdFor(normalized);
    const user = { id, email: normalized, ...this.getProfile(id, normalized) };
    const database = read();
    migrateLegacyUser(database, normalized);
    database.session = user;
    write(database);
    return user;
  },

  signOut() {
    const database = read();
    database.session = null;
    write(database);
  },

  getWords(userId: string): WordWithProgress[] {
    return toPairs(read(), userId).sort((a, b) => a.word.localeCompare(b.word));
  },

  getLearningEvents(userId: string): LearningEvent[] {
    return (read().learningEvents ?? [])
      .filter((event) => event.userId === userId)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  },

  getDueWords(userId: string): WordWithProgress[] {
    const now = Date.now();
    const words = toPairs(read(), userId);
    const today = new Date().toDateString();
    const learnedToday = words.filter(item => item.progress.firstLearnedAt && new Date(item.progress.firstLearnedAt).toDateString() === today).length;
    const dueWords = words
      .filter((item) => !item.progress.killedAt && new Date(item.progress.nextReviewAt).getTime() <= now)
      .sort(
        (a, b) =>
          new Date(a.progress.nextReviewAt).getTime() - new Date(b.progress.nextReviewAt).getTime(),
      )
      .sort((a, b) => Number(!a.progress.lastReviewAt) - Number(!b.progress.lastReviewAt));
    const reviewWords = dueWords.filter((item) => Boolean(item.progress.lastReviewAt));
    const newLimit = Math.max(0, this.getDailyNewLimit(userId) - learnedToday);
    const newWords = dueWords.filter((item) => !item.progress.lastReviewAt).slice(0, newLimit);
    return [...reviewWords, ...newWords];
  },

  getSpellingWords(userId: string, limit: number): WordWithProgress[] {
    const safeLimit = Math.max(0, Math.min(Math.floor(limit), 20));
    if (safeLimit === 0) return [];
    const today = new Date().toDateString();

    // 拼写是当天新学的巩固：只抽今天第一次完成“新学”的词。
    // 不把以前学过或只是今天复习的词混进来，也不会改变到期复习的队列。
    return toPairs(read(), userId)
      .filter((item) => !item.progress.killedAt && Boolean(item.progress.firstLearnedAt) && new Date(item.progress.firstLearnedAt!).toDateString() === today)
      .sort((a, b) => {
        const aLearnedAt = Date.parse(a.progress.firstLearnedAt!);
        const bLearnedAt = Date.parse(b.progress.firstLearnedAt!);
        if (bLearnedAt !== aLearnedAt) return bLearnedAt - aLearnedAt;
        return Date.parse(b.progress.updatedAt) - Date.parse(a.progress.updatedAt);
      })
      .slice(0, safeLimit);
  },

  importWords(userId: string, input: WordInput[]) {
    const database = read();
    const now = new Date().toISOString();
    let added = 0;
    let existing = 0;
    const existingByWord = new Map(
      database.words.filter((word) => word.userId === userId).map((word) => [word.word, word]),
    );

    input.forEach((item) => {
      const normalized = item.word.trim().toLowerCase();
      const old = existingByWord.get(normalized);
      if (old) {
        existing += 1;
        old.phonetic = item.phonetic || old.phonetic || "";
        old.meaning = item.meaning || old.meaning;
        old.phrase = item.phrase || old.phrase;
        old.sentence = item.sentence || old.sentence;
        old.sentenceCn = item.sentenceCn || old.sentenceCn;
        old.source = item.source || old.source;
        old.type = old.type === "marked" || item.type !== "marked" ? old.type : "marked";
        return;
      }

      added += 1;
      const word: Word = {
        ...item,
        word: normalized,
        id: id("word"),
        userId,
        createdAt: now,
      };
      const progress: Progress = {
        id: id("progress"),
        userId,
        wordId: word.id,
        reviewStage: 0,
        recognitionScore: 0,
        spellingScore: 0,
        nextReviewAt: now,
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
        createdAt: now,
        updatedAt: now,
      };
      database.words.push(word);
      database.progress.push(progress);
      existingByWord.set(normalized, word);
    });

    write(database);
    return { added, existing };
  },

  deleteWords(userId: string, wordIds: string[]) {
    const database = read();
    const selectedIds = new Set(wordIds.filter((wordId) => wordId.length > 0));
    if (selectedIds.size === 0) return 0;
    const existingIds = new Set(
      database.words
        .filter((word) => word.userId === userId && selectedIds.has(word.id))
        .map((word) => word.id),
    );
    if (existingIds.size === 0) return 0;
    database.words = database.words.filter((word) => !(word.userId === userId && existingIds.has(word.id)));
    database.progress = database.progress.filter(
      (progress) => !(progress.userId === userId && existingIds.has(progress.wordId)),
    );
    database.learningEvents = (database.learningEvents ?? []).filter(
      (event) => !(event.userId === userId && existingIds.has(event.wordId)),
    );
    write(database);
    return existingIds.size;
  },

  deleteWord(userId: string, wordId: string) {
    return this.deleteWords(userId, [wordId]);
  },

  killWord(userId: string, wordId: string) {
    const database = read();
    const progress = database.progress.find(
      (item) => item.userId === userId && item.wordId === wordId,
    );
    if (!progress) return false;
    const now = new Date().toISOString();
    progress.killedAt = now;
    progress.updatedAt = now;
    write(database);
    return true;
  },

  restoreWord(userId: string, wordId: string) {
    const database = read();
    const progress = database.progress.find(
      (item) => item.userId === userId && item.wordId === wordId,
    );
    if (!progress) return false;
    const now = new Date().toISOString();
    progress.killedAt = null;
    progress.lastRestoredAt = now;
    progress.reviewStage = Math.min(progress.reviewStage, 2);
    progress.nextReviewAt = now;
    progress.updatedAt = now;
    write(database);
    return true;
  },

  undoKillWord(userId: string, wordId: string) {
    const database = read();
    const progress = database.progress.find(
      (item) => item.userId === userId && item.wordId === wordId,
    );
    if (!progress) return false;
    progress.killedAt = null;
    progress.updatedAt = new Date().toISOString();
    write(database);
    return true;
  },

  getReviewDraft(userId: string): ReviewDraft | null {
    try {
      const raw = localStorage.getItem(`${REVIEW_DRAFT_PREFIX}${userId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ReviewDraft>;
      if (
        parsed.version !== 1 || parsed.userId !== userId ||
        (parsed.mode !== undefined && !["all", "new", "review", "spell"].includes(parsed.mode)) ||
        (parsed.scope !== undefined && !["daily", "library"].includes(parsed.scope)) ||
        !isWordIdList(parsed.itemIds) || !isWordIdList(parsed.recognitionQueueIds) ||
        new Set(parsed.itemIds!).size !== parsed.itemIds!.length ||
        !parsed.recognitionQueueIds!.every((wordId) => parsed.itemIds!.includes(wordId)) ||
        !["learning", "recognition", "summary", "spelling"].includes(parsed.phase ?? "") ||
        (parsed.phase === "learning" && parsed.mode !== "new") ||
        typeof parsed.index !== "number" || !Number.isInteger(parsed.index) || parsed.index < 0 ||
        !isRecord(parsed.recognition) || !isRecord(parsed.spelling) ||
        !Object.entries(parsed.recognition).every(([wordId, response]) => parsed.itemIds?.includes(wordId) && isRecognition(response)) ||
        !Object.entries(parsed.spelling).every(([wordId, response]) => parsed.itemIds?.includes(wordId) && isSpelling(response)) ||
        typeof parsed.hadSpellingError !== "boolean" || typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt))
      ) {
        localStorage.removeItem(`${REVIEW_DRAFT_PREFIX}${userId}`);
        return null;
      }
      const itemIds = parsed.itemIds as string[];
      const recognitionQueueIds = parsed.recognitionQueueIds as string[];
      const phase = parsed.phase as ReviewDraft["phase"];
      const currentWordId = typeof parsed.currentWordId === "string" && itemIds.includes(parsed.currentWordId)
        ? parsed.currentWordId
        : null;
      const firstChoice = parsed.firstChoice === "known" || parsed.firstChoice === "unknown" ? parsed.firstChoice : null;
      const answer = typeof parsed.answer === "string" ? parsed.answer : "";
      const spellingChecked = parsed.spellingChecked == null ? null : isSpelling(parsed.spellingChecked) ? parsed.spellingChecked : null;
      return {
        ...parsed,
        version: 1,
        userId,
        itemIds,
        recognitionQueueIds,
        phase,
        index: parsed.index,
        recognition: parsed.recognition as Record<string, RecognitionResponse>,
        spelling: parsed.spelling as Record<string, SpellingResponse>,
        hadSpellingError: parsed.hadSpellingError,
        updatedAt: parsed.updatedAt,
        currentWordId,
        firstChoice,
        answer,
        spellingChecked,
      };
    } catch {
      return null;
    }
  },

  saveReviewDraft(userId: string, draft: Omit<ReviewDraft, "version" | "userId" | "updatedAt">) {
    const payload: ReviewDraft = {
      ...draft,
      version: 1,
      userId,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(`${REVIEW_DRAFT_PREFIX}${userId}`, JSON.stringify(payload));
  },

  clearReviewDraft(userId: string) {
    localStorage.removeItem(`${REVIEW_DRAFT_PREFIX}${userId}`);
  },

  exportBackup(userId: string) {
    const database = read();
    const payload = {
      format: "cet-word-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      words: database.words.filter((word) => word.userId === userId),
      progress: database.progress.filter((progress) => progress.userId === userId),
      learningEvents: (database.learningEvents ?? []).filter((event) => event.userId === userId),
    };
    return JSON.stringify(payload, null, 2);
  },

  restoreBackup(userId: string, raw: string) {
    const parsed = JSON.parse(raw) as { format?: unknown; version?: unknown; words?: unknown; progress?: unknown; learningEvents?: unknown };
    if (!parsed || parsed.format !== "cet-word-backup" || parsed.version !== 1 || !Array.isArray(parsed.words) || !Array.isArray(parsed.progress)) {
      throw new Error("这不是本应用生成的有效备份文件。");
    }
    const sourceWords = parsed.words as Word[];
    const sourceProgress = parsed.progress as Progress[];
    const sourceEvents = Array.isArray(parsed.learningEvents) ? parsed.learningEvents as LearningEvent[] : [];
    if (sourceWords.length === 0) throw new Error("备份中没有词条，已取消恢复，现有数据未改变。");
    const validDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
    const nullableDate = (value: unknown) => value == null || validDate(value);
    const score = (value: unknown, maximum: number) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const word of sourceWords) {
      if (!word || typeof word.id !== "string" || !word.id || ids.has(word.id) ||
        typeof word.word !== "string" || !word.word.trim() || names.has(word.word.trim().toLowerCase()) ||
        !["marked", "added"].includes(word.type) ||
        ![word.meaning, word.phrase, word.sentence, word.sentenceCn, word.source].every(value => typeof value === "string") ||
        !validDate(word.createdAt)) throw new Error("备份词条损坏或重复，已取消恢复，现有数据未改变。");
      ids.add(word.id);
      names.add(word.word.trim().toLowerCase());
    }
    const progressIds = new Set<string>();
    for (const progress of sourceProgress) {
      if (!progress || !ids.has(progress.wordId) || progressIds.has(progress.wordId) ||
        !score(progress.reviewStage, 6) || !score(progress.recognitionScore, 5) || !score(progress.spellingScore, 5) ||
        !validDate(progress.nextReviewAt) || !validDate(progress.createdAt) ||
        ![progress.lastReviewAt, progress.killedAt, progress.lastRestoredAt].every(nullableDate) ||
        ![null, "known", "unknown"].includes(progress.lastRecognitionChoice) ||
        ![null, "correct", "wrong"].includes(progress.lastRecognitionResult) ||
        ![null, "correct", "wrong"].includes(progress.lastSpellingResult) ||
        ![null, undefined, "again", "hard", "good", "easy"].includes(progress.lastGrade)) {
        throw new Error("备份学习记录不完整或无效，已取消恢复，现有数据未改变。");
      }
      progressIds.add(progress.wordId);
    }
    if (progressIds.size !== ids.size) throw new Error("备份缺少学习记录，已取消恢复。");
    for (const event of sourceEvents) {
      if (!event || !ids.has(event.wordId) || !["new", "review"].includes(event.kind) ||
        !score(event.reviewStage, 6) || !validDate(event.occurredAt)) {
        throw new Error("备份学习趋势记录无效，已取消恢复。");
      }
    }
    const progressByWordId = new Map(sourceProgress.map((progress) => [progress.wordId, progress]));
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const restoredWords: Word[] = [];
    const restoredProgress: Progress[] = [];
    const restoredEvents: LearningEvent[] = [];
    const restoredWordIds = new Map<string, string>();

    sourceWords.forEach((sourceWord) => {
      const normalized = typeof sourceWord.word === "string" ? sourceWord.word.trim().toLowerCase() : "";
      if (!normalized || seen.has(normalized) || (sourceWord.type !== "marked" && sourceWord.type !== "added")) return;
      seen.add(normalized);
      const wordId = id("word");
      const progressId = id("progress");
      const prior = progressByWordId.get(sourceWord.id);
      restoredWords.push({
        id: wordId,
        userId,
        word: normalized,
        phonetic: typeof sourceWord.phonetic === "string" ? sourceWord.phonetic : "",
        meaning: typeof sourceWord.meaning === "string" ? sourceWord.meaning : "",
        phrase: typeof sourceWord.phrase === "string" ? sourceWord.phrase : "",
        sentence: typeof sourceWord.sentence === "string" ? sourceWord.sentence : "",
        sentenceCn: typeof sourceWord.sentenceCn === "string" ? sourceWord.sentenceCn : "",
        source: typeof sourceWord.source === "string" ? sourceWord.source : "",
        type: sourceWord.type,
        createdAt: typeof sourceWord.createdAt === "string" ? sourceWord.createdAt : now,
      });
      restoredProgress.push({
        id: progressId,
        userId,
        wordId,
        reviewStage: Math.max(0, Math.min(6, Number(prior?.reviewStage) || 0)),
        recognitionScore: clampScore(Number(prior?.recognitionScore) || 0),
        spellingScore: clampScore(Number(prior?.spellingScore) || 0),
        nextReviewAt: typeof prior?.nextReviewAt === "string" ? prior.nextReviewAt : now,
        lastReviewAt: typeof prior?.lastReviewAt === "string" ? prior.lastReviewAt : null,
        lastRecognitionChoice: prior?.lastRecognitionChoice ?? null,
        lastRecognitionResult: prior?.lastRecognitionResult ?? null,
        lastSpellingResult: prior?.lastSpellingResult ?? null,
        lastGrade: prior?.lastGrade ?? null,
        firstLearnedAt: prior?.firstLearnedAt,
        killedAt: prior?.killedAt ?? null,
        lastRestoredAt: prior?.lastRestoredAt ?? null,
        createdAt: typeof prior?.createdAt === "string" ? prior.createdAt : now,
        updatedAt: now,
        reviewCount: Math.max(0, Math.floor(Number(prior?.reviewCount) || 0)),
        correctCount: Math.max(0, Math.floor(Number(prior?.correctCount) || 0)),
        wrongCount: Math.max(0, Math.floor(Number(prior?.wrongCount) || 0)),
      });
      restoredWordIds.set(sourceWord.id, wordId);
    });

    sourceEvents.forEach((event) => {
      const wordId = restoredWordIds.get(event.wordId);
      if (!wordId) return;
      restoredEvents.push({ id: id("learning-event"), userId, wordId, occurredAt: event.occurredAt, kind: event.kind, reviewStage: event.reviewStage });
    });

    if (restoredWords.length === 0) throw new Error("备份中没有可恢复的有效单词。");
    const database = read();
    const previousPayload = {
      format: "cet-word-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      words: database.words.filter((word) => word.userId === userId),
      progress: database.progress.filter((progress) => progress.userId === userId),
      learningEvents: (database.learningEvents ?? []).filter((event) => event.userId === userId),
    };
    try {
      localStorage.setItem(`${AUTO_BACKUP_PREFIX}${userId}`, JSON.stringify(previousPayload, null, 2));
    } catch {
      throw new Error("无法先保存恢复前的自动备份，已取消恢复以保护当前数据。");
    }
    database.words = [...database.words.filter((word) => word.userId !== userId), ...restoredWords];
    database.progress = [...database.progress.filter((progress) => progress.userId !== userId), ...restoredProgress];
    database.learningEvents = [...(database.learningEvents ?? []).filter((event) => event.userId !== userId), ...restoredEvents];
    write(database);
    this.clearReviewDraft(userId);
    return { restored: restoredWords.length };
  },

  finishReview(
    userId: string,
    entries: WordWithProgress[],
    recognition: Record<string, RecognitionResponse>,
    spelling: Record<string, SpellingResponse>,
  ): ReviewCompletion {
    const database = read();
    const completedAt = new Date();
    const nextDates: string[] = [];
    const grades: Record<ReviewGrade, number> = { again: 0, hard: 0, good: 0, easy: 0 };

    entries.forEach((entry) => {
      const recognitionAnswer = recognition[entry.id];
      const spellingAnswer = spelling[entry.id];
      if (!recognitionAnswer || !spellingAnswer) return;
      const progress = database.progress.find(
        (item) => item.userId === userId && item.wordId === entry.id,
      );
      if (!progress || progress.killedAt || progress.updatedAt !== entry.progress.updatedAt || progress.nextReviewAt !== entry.progress.nextReviewAt || !spellingAnswer.correct) return;

      let grade: ReviewGrade;
      if (recognitionAnswer.hadError) {
        grade = "again";
        progress.reviewStage = Math.max(progress.reviewStage - 2, 0);
      } else if (spellingAnswer.hadError) {
        grade = "hard";
      } else if (
        progress.reviewStage >= 3 &&
        progress.recognitionScore >= 3 &&
        progress.spellingScore >= 3
      ) {
        grade = "easy";
        progress.reviewStage = Math.min(progress.reviewStage + 2, 6);
      } else {
        grade = "good";
        progress.reviewStage = Math.min(progress.reviewStage + 1, 6);
      }

      progress.recognitionScore = clampScore(
        progress.recognitionScore + (recognitionAnswer.hadError ? -1 : 1),
      );
      progress.spellingScore = clampScore(
        progress.spellingScore + (spellingAnswer.hadError ? -1 : 1),
      );

      const next = new Date(completedAt.getTime() + INTERVALS[progress.reviewStage] * DAY_MS);
      progress.nextReviewAt = next.toISOString();
      if (!progress.lastReviewAt) progress.firstLearnedAt = completedAt.toISOString();
      progress.lastReviewAt = completedAt.toISOString();
      progress.lastRecognitionChoice = recognitionAnswer.firstChoice;
      progress.lastRecognitionResult = recognitionAnswer.hadError ? "wrong" : "correct";
      progress.lastSpellingResult = spellingAnswer.hadError ? "wrong" : "correct";
      progress.lastGrade = grade;
      progress.reviewCount = (progress.reviewCount ?? 0) + 1;
      progress.correctCount = (progress.correctCount ?? 0) + (recognitionAnswer.hadError ? 0 : 1);
      progress.wrongCount = (progress.wrongCount ?? 0) + (recognitionAnswer.hadError ? 1 : 0);
      progress.updatedAt = nextUpdatedAt(progress.updatedAt, completedAt);
      addLearningEvent(database, {
        userId,
        wordId: entry.id,
        occurredAt: completedAt.toISOString(),
        kind: "review",
        reviewStage: progress.reviewStage,
      });
      grades[grade] += 1;
      nextDates.push(next.toISOString());
    });

    write(database);
    return { completed: nextDates.length, earliestNextReviewAt: nextDates.sort()[0] ?? null, grades };
  },

  completeNewStudy(userId: string, entries: WordWithProgress[]) {
    const database = read();
    const completedAt = new Date();
    const completedAtIso = completedAt.toISOString();
    const nextDates: string[] = [];

    entries.forEach((entry) => {
      const progress = database.progress.find(
        (item) => item.userId === userId && item.wordId === entry.id,
      );
      // New-study acknowledgement is intentionally not a scored review. It only
      // moves an unseen word into tomorrow's review queue, without inventing a
      // recognition or spelling result for the learner.
      if (
        !progress || progress.killedAt || progress.lastReviewAt ||
        progress.updatedAt !== entry.progress.updatedAt ||
        progress.nextReviewAt !== entry.progress.nextReviewAt
      ) return;

      const next = new Date(completedAt.getTime() + INTERVALS[0] * DAY_MS);
      progress.reviewStage = 0;
      progress.firstLearnedAt = completedAtIso;
      progress.lastReviewAt = completedAtIso;
      progress.lastRecognitionChoice = null;
      progress.lastRecognitionResult = null;
      progress.lastSpellingResult = null;
      progress.lastGrade = null;
      progress.nextReviewAt = next.toISOString();
      progress.updatedAt = nextUpdatedAt(progress.updatedAt, completedAt);
      addLearningEvent(database, {
        userId,
        wordId: entry.id,
        occurredAt: completedAtIso,
        kind: "new",
        reviewStage: progress.reviewStage,
      });
      nextDates.push(next.toISOString());
    });

    write(database);
    return { completed: nextDates.length, earliestNextReviewAt: nextDates.sort()[0] ?? null };
  },

  finishSpellingPractice(
    userId: string,
    entries: WordWithProgress[],
    spelling: Record<string, SpellingResponse>,
  ) {
    const database = read();
    const completedAt = new Date();
    let completed = 0;
    let corrected = 0;

    entries.forEach((entry) => {
      const answer = spelling[entry.id];
      const progress = database.progress.find(
        (item) => item.userId === userId && item.wordId === entry.id,
      );
      if (
        !answer || !answer.correct || !progress || progress.killedAt || !progress.lastReviewAt ||
        progress.updatedAt !== entry.progress.updatedAt ||
        progress.nextReviewAt !== entry.progress.nextReviewAt
      ) return;

      // 拼写练习只记录拼写表现，不推进复习层级、不伪造认词结果。
      progress.spellingScore = clampScore(progress.spellingScore + (answer.hadError ? -1 : 1));
      progress.lastSpellingResult = answer.hadError ? "wrong" : "correct";
      if (answer.hadError) {
        corrected += 1;
        const retryAt = new Date(completedAt.getTime() + DAY_MS).toISOString();
        if (Date.parse(progress.nextReviewAt) > Date.parse(retryAt)) {
          progress.nextReviewAt = retryAt;
        }
      }
      progress.updatedAt = nextUpdatedAt(progress.updatedAt, completedAt);
      completed += 1;
    });

    write(database);
    return { completed, corrected };
  },

  loadDemoWords(userId: string) {
    const items: WordInput[] = [
      {
        word: "alleviate",
        phonetic: "/əˈliːvieɪt/",
        meaning: "v. 缓解；减轻",
        phrase: "alleviate financial pressure",
        sentence: "The policy could alleviate financial pressure.",
        sentenceCn: "这项政策可以缓解经济压力。",
        source: "2025-12 CET6 阅读1",
        type: "marked",
      },
      {
        word: "implement",
        phonetic: "/ˈɪmplɪment/",
        meaning: "v. 实施；执行",
        phrase: "implement a policy",
        sentence: "The government implemented the policy.",
        sentenceCn: "政府实施了这项政策。",
        source: "2025-12 CET6 阅读1",
        type: "added",
      },
      {
        word: "resilient",
        phonetic: "/rɪˈzɪliənt/",
        meaning: "adj. 有韧性的；适应力强的",
        phrase: "a resilient economy",
        sentence: "Small businesses proved remarkably resilient.",
        sentenceCn: "小企业表现出了惊人的韧性。",
        source: "2024-06 CET4 阅读2",
        type: "marked",
      },
    ];
    return this.importWords(userId, items);
  },
};
