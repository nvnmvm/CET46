import { ApiError, apiClient, type ApiClient, type ApiReviewDraft, type ApiSettings } from "./apiClient.ts";
import type {
  CountdownSettings,
  LearningEvent,
  LocalStorageStatus,
  Progress,
  RecognitionResponse,
  ReviewCompletion,
  ReviewDraft,
  SpellingResponse,
  ThemeMode,
  WordInput,
  WordWithProgress,
} from "../types.ts";

/**
 * 云端数据边界。
 *
 * 这里的内存缓存只负责让现有同步渲染组件能够继续工作；它不是持久化层。
 * hydrate() 负责从 API 装载，所有写操作都先请求 API，成功后重新 hydrate，
 * 因此 MySQL 才是词库、进度、设置、事件和草稿的唯一真实来源。
 */

type CloudCache = {
  userId: string;
  words: WordWithProgress[];
  events: LearningEvent[];
  dueWords: WordWithProgress[];
  spellingWords: WordWithProgress[];
  settings: ApiSettings;
  draft: ApiReviewDraft | null;
};

const DEFAULT_SETTINGS: ApiSettings = {
  dailyTarget: 20,
  dailyGroups: 2,
  dailyGroupWords: 10,
  dailyPlanConfigured: false,
  timezone: "Asia/Shanghai",
  countdown: null,
  updatedAt: "",
};

function createStableSubmissionKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(24);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function completionSignature(
  userId: string,
  kind: "new" | "review" | "spelling",
  entries: WordWithProgress[],
): string {
  return `${userId}:${kind}:${entries.map((entry) => `${entry.id}:${entry.progress.updatedAt}:${entry.progress.nextReviewAt}`).join(",")}`;
}

function localThemeMode(): ThemeMode {
  try {
    const value = localStorage.getItem("cet-word-mvp-theme-v1");
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

function saveLocalThemeMode(value: ThemeMode) {
  if (value !== "system" && value !== "light" && value !== "dark") throw new Error("主题模式无效。");
  try {
    localStorage.setItem("cet-word-mvp-theme-v1", value);
  } catch {
    // 主题只是设备偏好；存储不可用时不阻止学习数据同步。
  }
}

/**
 * 创建一个绑定到指定 API 客户端的云端仓库。
 *
 * 生产代码使用默认客户端；测试可以注入 fake ApiClient，验证缓存、用户切换和
 * 重试行为而不需要启动真实服务器。每个实例拥有独立缓存和 submission key，
 * 不会把测试状态或旧账号状态泄漏到另一个实例。
 */
export function createCloudRepository(client: ApiClient = apiClient) {
  let cache: CloudCache | null = null;
  let hydrationGeneration = 0;
  const draftSaveQueues = new Map<string, Promise<void>>();
  const completionKeys = new Map<string, string>();

  function invalidateHydration() {
    hydrationGeneration += 1;
  }

  function submissionKeyFor(signature: string): string {
    const existing = completionKeys.get(signature);
    if (existing) return existing;
    const created = createStableSubmissionKey();
    completionKeys.set(signature, created);
    return created;
  }

  function emptyCache(userId: string): CloudCache {
    return {
      userId,
      words: [],
      events: [],
      dueWords: [],
      spellingWords: [],
      settings: { ...DEFAULT_SETTINGS },
      draft: null,
    };
  }

  function requireCache(userId: string): CloudCache {
    if (!cache || cache.userId !== userId) cache = emptyCache(userId);
    return cache;
  }

  async function listAllWords(userId: string): Promise<WordWithProgress[]> {
    const pageSize = 100;
    const result: WordWithProgress[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await client.listWords(userId, { limit: pageSize, offset });
      result.push(...page.words);
      if (result.length >= page.total || page.words.length < pageSize) break;
    }
    return result.sort((a, b) => a.word.localeCompare(b.word));
  }

  async function listAllEvents(userId: string): Promise<LearningEvent[]> {
    const pageSize = 500;
    const maxWindow = 5_000;
    const result: LearningEvent[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await client.listEvents(userId, { limit: pageSize, offset });
      result.push(...page.events);
      // 服务端只开放最近 5,000 条事件；不要在 total 更大时请求被 schema 拒绝的 offset=5000。
      if (result.length >= Math.min(page.total, maxWindow) || page.events.length < pageSize) break;
    }
    return result.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  async function hydrate(userId: string): Promise<void> {
    const generation = ++hydrationGeneration;
    const [words, events, settings, due, spellingWords, draft] = await Promise.all([
      listAllWords(userId),
      listAllEvents(userId),
      client.getSettings(),
      client.getDue(userId, 200),
      client.getSpelling(userId, { scope: "daily", limit: 20 }),
      client.getDraft(userId),
    ]);
    if (generation !== hydrationGeneration) return;
    cache = {
      userId,
      words,
      events,
      dueWords: [...due.reviewWords, ...due.newWords],
      spellingWords,
      settings,
      draft,
    };
  }

  async function loadReviewDraft(userId: string): Promise<ReviewDraft | null> {
    const draft = await client.getDraft(userId);
    requireCache(userId).draft = draft;
    return draft;
  }

  async function saveReviewDraft(
    userId: string,
    draft: Omit<ReviewDraft, "version" | "userId" | "updatedAt">,
  ): Promise<ApiReviewDraft> {
    const previous = draftSaveQueues.get(userId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      invalidateHydration();
      const current = requireCache(userId).draft;
      try {
        const saved = await client.saveDraft(
          userId,
          { ...draft, version: 1 },
          { revision: current?.revision ?? 0 },
        );
        requireCache(userId).draft = saved;
        return saved;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          // 先读取服务器最新 revision，下一次保存才能以最新版本继续；当前草稿不伪装成已保存。
          try { await loadReviewDraft(userId); } catch { /* 保留原始冲突错误给界面 */ }
        }
        throw error;
      }
    });
    const barrier = operation.then(() => undefined, () => undefined);
    draftSaveQueues.set(userId, barrier);
    try {
      return await operation;
    } finally {
      if (draftSaveQueues.get(userId) === barrier) draftSaveQueues.delete(userId);
    }
  }

  async function clearReviewDraft(userId: string): Promise<void> {
    const previous = draftSaveQueues.get(userId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      invalidateHydration();
      await client.clearDraft();
      requireCache(userId).draft = null;
    });
    const barrier = operation.then(() => undefined, () => undefined);
    draftSaveQueues.set(userId, barrier);
    try {
      await operation;
    } finally {
      if (draftSaveQueues.get(userId) === barrier) draftSaveQueues.delete(userId);
    }
  }

  function replaceProgress(userId: string, progress: Progress) {
    const current = requireCache(userId);
    current.words = current.words.map((item) =>
      item.id === progress.wordId ? { ...item, progress } : item,
    );
    current.dueWords = current.dueWords.map((item) =>
      item.id === progress.wordId ? { ...item, progress } : item,
    );
    current.spellingWords = current.spellingWords.map((item) =>
      item.id === progress.wordId ? { ...item, progress } : item,
    );
  }

  const repository = {
    hydrate,

    getThemeMode: localThemeMode,
    setThemeMode: saveLocalThemeMode,

    getStorageStatus(): LocalStorageStatus | null {
      return null;
    },
    getDamagedData(): string | null {
      return null;
    },
    discardDamagedData() {
      // 云端模式没有本机学习数据库可清理。
    },
    getAutomaticBackup(_userId: string): string | null {
      return null;
    },

    getWords(userId: string): WordWithProgress[] {
      return [...requireCache(userId).words];
    },
    getLearningEvents(userId: string): LearningEvent[] {
      return [...requireCache(userId).events];
    },
    getDueWords(userId: string): WordWithProgress[] {
      return [...requireCache(userId).dueWords];
    },
    getSpellingWords(userId: string, limit: number): WordWithProgress[] {
      return requireCache(userId).spellingWords.slice(0, Math.max(0, Math.min(Math.floor(limit), 20)));
    },
    getDailyTarget(userId: string): number {
      return requireCache(userId).settings.dailyTarget;
    },
    getDailyGroups(userId: string): number {
      return requireCache(userId).settings.dailyGroups;
    },
    getDailyGroupWords(userId: string): number {
      return requireCache(userId).settings.dailyGroupWords;
    },
    getDailyNewLimit(userId: string): number {
      const settings = requireCache(userId).settings;
      return settings.dailyPlanConfigured
        ? settings.dailyGroups * settings.dailyGroupWords
        : settings.dailyTarget;
    },
    getCountdown(userId: string): CountdownSettings | null {
      return requireCache(userId).settings.countdown;
    },

    async setDailyTarget(userId: string, value: number): Promise<void> {
      invalidateHydration();
      const settings = await client.updateSettings({ dailyTarget: value });
      requireCache(userId).settings = settings;
    },
    async setDailyGroups(userId: string, value: number): Promise<void> {
      invalidateHydration();
      const settings = await client.updateSettings({ dailyGroups: value });
      requireCache(userId).settings = settings;
    },
    async setDailyGroupWords(userId: string, value: number): Promise<void> {
      invalidateHydration();
      const settings = await client.updateSettings({ dailyGroupWords: value });
      requireCache(userId).settings = settings;
    },
    async setCountdown(userId: string, countdown: CountdownSettings | null): Promise<void> {
      invalidateHydration();
      const settings = await client.updateSettings({ countdown });
      requireCache(userId).settings = settings;
    },

    async importWords(userId: string, input: WordInput[]) {
      invalidateHydration();
      const result = await client.importWords(input);
      await hydrate(userId);
      return result;
    },
    async updateWord(userId: string, wordId: string, phonetic: string, meaning: string): Promise<WordWithProgress> {
      invalidateHydration();
      const updated = await client.updateWord(userId, wordId, phonetic, meaning);
      await hydrate(userId);
      return updated;
    },
    async deleteWord(userId: string, wordId: string): Promise<number> {
      invalidateHydration();
      await client.deleteWord(userId, wordId);
      await hydrate(userId);
      return 1;
    },
    async deleteWords(userId: string, wordIds: string[]): Promise<number> {
      invalidateHydration();
      let deleted = 0;
      for (const wordId of wordIds) {
        await client.deleteWord(userId, wordId);
        deleted += 1;
      }
      await hydrate(userId);
      return deleted;
    },
    async killWord(userId: string, wordId: string): Promise<boolean> {
      invalidateHydration();
      const progress = await client.progressAction(userId, wordId, "kill");
      replaceProgress(userId, progress);
      return true;
    },
    async restoreWord(userId: string, wordId: string): Promise<boolean> {
      invalidateHydration();
      const progress = await client.progressAction(userId, wordId, "restore");
      replaceProgress(userId, progress);
      return true;
    },
    async undoKillWord(userId: string, wordId: string): Promise<boolean> {
      invalidateHydration();
      const progress = await client.progressAction(userId, wordId, "undo-kill");
      replaceProgress(userId, progress);
      return true;
    },

    getReviewDraft(userId: string): ReviewDraft | null {
      return requireCache(userId).draft;
    },
    loadReviewDraft,
    saveReviewDraft,
    clearReviewDraft,

    async completeNewStudy(userId: string, entries: WordWithProgress[], options?: { submissionKey?: string }) {
      invalidateHydration();
      const signature = completionSignature(userId, "new", entries);
      const result = await client.completeNewStudy(userId, entries, {
        submissionKey: options?.submissionKey ?? submissionKeyFor(signature),
      });
      await hydrate(userId);
      completionKeys.delete(signature);
      return result;
    },
    async finishReview(
      userId: string,
      entries: WordWithProgress[],
      recognition: Record<string, RecognitionResponse>,
      spelling: Record<string, SpellingResponse>,
      options?: { submissionKey?: string },
    ): Promise<ReviewCompletion & { conflicts: number; skipped: number }> {
      invalidateHydration();
      const signature = completionSignature(userId, "review", entries);
      const result = await client.finishReview(userId, entries, recognition, spelling, {
        submissionKey: options?.submissionKey ?? submissionKeyFor(signature),
      });
      await hydrate(userId);
      completionKeys.delete(signature);
      return result;
    },
    async finishSpellingPractice(
      userId: string,
      entries: WordWithProgress[],
      spelling: Record<string, SpellingResponse>,
      options?: { submissionKey?: string },
    ) {
      invalidateHydration();
      const signature = completionSignature(userId, "spelling", entries);
      const result = await client.finishSpellingPractice(userId, entries, spelling, {
        submissionKey: options?.submissionKey ?? submissionKeyFor(signature),
      });
      await hydrate(userId);
      completionKeys.delete(signature);
      return result;
    },

    exportBackup(userId: string): string {
      const current = requireCache(userId);
      return JSON.stringify({
        format: "cet-word-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        words: current.words,
        progress: current.words.map((item) => item.progress),
        learningEvents: current.events,
      }, null, 2);
    },
    async restoreBackup(userId: string, raw: string): Promise<{ restored: number }> {
      const parsed = JSON.parse(raw) as { format?: unknown; version?: unknown; words?: unknown };
      if (parsed.format !== "cet-word-backup" || parsed.version !== 1 || !Array.isArray(parsed.words)) {
        throw new Error("这不是本应用生成的有效备份文件。");
      }
      const input = parsed.words.map((item) => {
        if (!item || typeof item !== "object") throw new Error("备份词条无效。");
        const word = item as Partial<WordInput>;
        if (typeof word.word !== "string" || typeof word.phonetic !== "string" || typeof word.meaning !== "string") {
          throw new Error("备份词条缺少单词、音标或释义。");
        }
        return {
          word: word.word,
          phonetic: word.phonetic,
          meaning: word.meaning,
          phrase: typeof word.phrase === "string" ? word.phrase : "",
          sentence: typeof word.sentence === "string" ? word.sentence : "",
          sentenceCn: typeof word.sentenceCn === "string" ? word.sentenceCn : "",
          source: typeof word.source === "string" ? word.source : "",
          type: word.type === "marked" ? "marked" : "added",
        } satisfies WordInput;
      });
      if (input.length === 0) throw new Error("备份中没有可恢复的词条。");
      const result = await client.importWords(input);
      await hydrate(userId);
      return { restored: result.added + result.existing };
    },

    async loadDemoWords(userId: string) {
      return this.importWords(userId, [
        { word: "alleviate", phonetic: "/əˈliːvieɪt/", meaning: "v. 缓解；减轻", phrase: "alleviate financial pressure", sentence: "The policy could alleviate financial pressure.", sentenceCn: "这项政策可以缓解经济压力。", source: "2025-12 CET6 阅读1", type: "marked" },
        { word: "implement", phonetic: "/ˈɪmplɪment/", meaning: "v. 实施；执行", phrase: "implement a policy", sentence: "The government implemented the policy.", sentenceCn: "政府实施了这项政策。", source: "2025-12 CET6 阅读1", type: "added" },
        { word: "resilient", phonetic: "/rɪˈzɪliənt/", meaning: "adj. 有韧性的；适应力强的", phrase: "a resilient economy", sentence: "Small businesses proved remarkably resilient.", sentenceCn: "小企业表现出了惊人的韧性。", source: "2024-06 CET4 阅读2", type: "marked" },
      ]);
    },
  };

  return repository;
}

export const cloudRepository = createCloudRepository();
export type CloudRepository = typeof cloudRepository;
