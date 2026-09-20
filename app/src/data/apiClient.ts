import type {
  CountdownSettings,
  LearningEvent,
  LocalUser,
  Progress,
  RecognitionResponse,
  ReviewCompletion,
  ReviewDraft,
  ReviewGrade,
  SpellingResponse,
  WordInput,
  WordWithProgress,
} from "../types";

/**
 * 前端异步 API 客户端（数据库接入第三批）。
 *
 * 安全边界（修改前务必确认）：
 * 1. 身份只来自同源 HttpOnly Cookie。任何方法都不把 userId 放进 URL、query 或 body；
 *    方法签名里的 userId 只用于把响应映射成本地类型（服务端响应刻意不含 userId）。
 * 2. 所有请求使用 `credentials: "include"`，不读写 localStorage，不记录请求 body、Cookie、密码或 token。
 * 3. 客户端提交的 stage / score / result 等“结果”字段都不是安全边界：这里只提交
 *    “服务端下发的版本 + 用户原始输入”，最终结果由服务端重算。
 *
 * App 的云端仓库通过本模块加载和提交核心学习数据；同步 getter 只存在于
 * cloudRepository 的内存缓存中，不能把它误当作持久化层。
 */

/* -------------------------------------------------------------------------- */
/* 基础类型                                                                    */
/* -------------------------------------------------------------------------- */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ApiErrorOptions = {
  status: number;
  code: string;
  message: string;
  details?: string[];
};

/**
 * 受控 API 错误。
 * 只携带状态码、错误码与服务端给出的字段级说明；消息里不含秘密、Cookie 或完整响应体。
 */
export class ApiError extends Error {
  declare readonly status: number;
  declare readonly code: string;
  declare readonly details: string[];

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? [];
  }
}

export type ApiClientOptions = {
  /** API 根地址；默认读取 VITE_API_BASE_URL，为空表示同源。 */
  baseUrl?: string;
  /** 便于测试注入的 fetch 实现；默认使用全局 fetch。 */
  fetchImpl?: FetchLike;
};

export type ListOptions = { limit?: number; offset?: number };

/** Account administration exposes metadata only, never credentials or learning data. */
export type AdminUser = {
  id: string;
  email: string;
  username: string | null;
  role: "admin" | "learner";
  disabledAt: string | null;
  createdAt: string;
};

export type ProgressAction = "kill" | "restore" | "undo-kill";

export type ApiSettings = {
  dailyTarget: number;
  dailyGroups: number;
  dailyGroupWords: number;
  dailyPlanConfigured: boolean;
  timezone: string;
  countdown: CountdownSettings | null;
  updatedAt: string;
};

export type SettingsPatch = {
  dailyTarget?: number;
  dailyGroups?: number;
  dailyGroupWords?: number;
  timezone?: string;
  countdown?: CountdownSettings | null;
};

export type SpellingOptions = { scope?: "daily" | "library"; filter?: string; limit?: number };

export type DueQueue = {
  limit: number;
  dailyNewLimit: number;
  learnedToday: number;
  remainingNew: number;
  dueReviewTotal: number;
  dueNewTotal: number;
  reviewWords: WordWithProgress[];
  newWords: WordWithProgress[];
};

/** 服务端草稿在客户端类型之外还带 key / revision（乐观并发用），映射时一并保留。 */
export type DraftMeta = { key: string; revision: number };
export type ApiReviewDraft = ReviewDraft & DraftMeta;

/** saveDraft 的输入与 localStore 保持一致：不含 userId / updatedAt。 */
export type DraftInput = Omit<ReviewDraft, "userId" | "updatedAt">;

export type DraftOptions = { key?: string; revision?: number };

/** 同一提交重试必须复用 submissionKey；显式传入即可复用。 */
export type CompletionOptions = { submissionKey?: string };

export type NewStudyCompletion = {
  completed: number;
  conflicts: number;
  skipped: number;
  earliestNextReviewAt: string | null;
};

export type ReviewCompletionResult = ReviewCompletion & { conflicts: number; skipped: number };

export type SpellingCompletion = {
  completed: number;
  corrected: number;
  conflicts: number;
  skipped: number;
};

export type ApiClient = {
  adminStatus(): Promise<boolean>;
  adminUsers(options?: ListOptions): Promise<{ users: AdminUser[]; total: number }>;
  adminCreateUser(input: { email: string; username: string; password: string }): Promise<void>;
  adminUpdateUser(id: string, patch: { email?: string; username?: string | null }): Promise<void>;
  adminDeleteUser(id: string): Promise<void>;
  adminSetDisabled(id: string, disabled: boolean): Promise<void>;
  adminResetPassword(id: string, password: string): Promise<void>;
  login(email: string, password: string): Promise<LocalUser>;
  session(): Promise<LocalUser | null>;
  logout(): Promise<void>;
  getProfile(): Promise<LocalUser>;
  updateProfile(profile: { username: string; avatar: string | null }): Promise<LocalUser>;
  listWords(userId: string, options?: ListOptions): Promise<{ total: number; words: WordWithProgress[] }>;
  importWords(input: WordInput[]): Promise<{ added: number; existing: number; total: number }>;
  updateWord(userId: string, wordId: string, phonetic: string, meaning: string): Promise<WordWithProgress>;
  deleteWord(userId: string, wordId: string): Promise<void>;
  progressAction(userId: string, wordId: string, action: ProgressAction): Promise<Progress>;
  getSettings(): Promise<ApiSettings>;
  updateSettings(patch: SettingsPatch): Promise<ApiSettings>;
  listEvents(userId: string, options?: ListOptions): Promise<{ total: number; events: LearningEvent[] }>;
  getDue(userId: string, limit?: number): Promise<DueQueue>;
  getSpelling(userId: string, options?: SpellingOptions): Promise<WordWithProgress[]>;
  getDraft(userId: string, key?: string): Promise<ApiReviewDraft | null>;
  saveDraft(userId: string, draft: DraftInput, options?: DraftOptions): Promise<ApiReviewDraft>;
  clearDraft(key?: string): Promise<void>;
  completeNewStudy(
    userId: string,
    entries: WordWithProgress[],
    options?: CompletionOptions,
  ): Promise<NewStudyCompletion>;
  finishReview(
    userId: string,
    entries: WordWithProgress[],
    recognition: Record<string, RecognitionResponse>,
    spelling: Record<string, SpellingResponse>,
    options?: CompletionOptions,
  ): Promise<ReviewCompletionResult>;
  finishSpellingPractice(
    userId: string,
    entries: WordWithProgress[],
    spelling: Record<string, SpellingResponse>,
    options?: CompletionOptions,
  ): Promise<SpellingCompletion>;
};

/* -------------------------------------------------------------------------- */
/* 服务端 DTO（与 server/src/serialize.ts 一一对应，且都不含 userId）            */
/* -------------------------------------------------------------------------- */

type ServerProgress = {
  id: string;
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
  reviewCount?: number;
  correctCount?: number;
  wrongCount?: number;
  version?: number;
  createdAt: string;
  updatedAt: string;
};

type ServerWord = {
  id: string;
  word: string;
  normalizedWord?: string;
  phonetic: string;
  meaning: string;
  phrase: string;
  sentence: string;
  sentenceCn: string;
  source: string;
  type: WordInput["type"];
  createdAt: string;
  updatedAt?: string;
  progress: ServerProgress;
};

type ServerEvent = {
  id: string;
  wordId: string;
  occurredAt: string;
  kind: LearningEvent["kind"];
  reviewStage: number;
};

type ServerDraft = {
  key: string;
  revision: number;
  version: number;
  mode: string | null;
  scope: string | null;
  phase: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
};

type ServerSettings = {
  dailyTarget: number;
  dailyGroups: number;
  dailyGroupWords: number;
  dailyPlanConfigured: boolean;
  timezone: string;
  countdown: CountdownSettings | null;
  updatedAt: string;
};

/* -------------------------------------------------------------------------- */
/* 常量与纯函数                                                                */
/* -------------------------------------------------------------------------- */

export const DEFAULT_DRAFT_KEY = "active";

const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SUBMISSION_KEY_LENGTH = 24;
const SUBMISSION_KEY_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const DRAFT_MODES = ["all", "new", "review", "spell"] as const;
const DRAFT_SCOPES = ["daily", "library"] as const;
const DRAFT_PHASES = ["learning", "recognition", "summary", "spelling"] as const;
const FIRST_CHOICES = ["known", "unknown"] as const;
const RECOGNITION_RESULTS = ["correct", "wrong"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponseError(): ApiError {
  return new ApiError({
    status: 0,
    code: "invalid_response",
    message: "服务器返回的数据无法解析",
  });
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponseError();
  return value;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function readWordIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return null;
    ids.push(item);
  }
  return ids;
}

function readRecognitionMap(value: unknown): Record<string, RecognitionResponse> | null {
  if (!isRecord(value)) return null;
  const responses: Record<string, RecognitionResponse> = {};
  for (const [wordId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) return null;
    const firstChoice = readEnum(raw.firstChoice, FIRST_CHOICES);
    const result = readEnum(raw.result, RECOGNITION_RESULTS);
    if (!firstChoice || !result) return null;
    if (typeof raw.hadError !== "boolean" || typeof raw.attempts !== "number") return null;
    responses[wordId] = {
      firstChoice,
      result,
      hadError: raw.hadError,
      attempts: raw.attempts,
    };
  }
  return responses;
}

function readSpellingMap(value: unknown): Record<string, SpellingResponse> | null {
  if (!isRecord(value)) return null;
  const responses: Record<string, SpellingResponse> = {};
  for (const [wordId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) return null;
    if (typeof raw.input !== "string") return null;
    if (typeof raw.correct !== "boolean" || typeof raw.hadError !== "boolean") return null;
    responses[wordId] = { input: raw.input, correct: raw.correct, hadError: raw.hadError };
  }
  return responses;
}

function readSpellingResponse(value: unknown): SpellingResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.input !== "string") return null;
  if (typeof value.correct !== "boolean" || typeof value.hadError !== "boolean") return null;
  return { input: value.input, correct: value.correct, hadError: value.hadError };
}

/* -------------------------------------------------------------------------- */
/* DTO → 前端类型映射                                                          */
/* -------------------------------------------------------------------------- */

/** 响应用户资料：null 的 username / avatar 映射为 undefined，且绝不写入本地存储。 */
function mapUser(value: unknown): LocalUser {
  const raw = asJsonObject(value);
  if (typeof raw.id !== "string" || typeof raw.email !== "string") throw invalidResponseError();
  return {
    id: raw.id,
    email: raw.email,
    username: readOptionalText(raw.username),
    avatar: readOptionalText(raw.avatar),
  };
}

function mapProgress(dto: ServerProgress, userId: string): Progress {
  return {
    id: dto.id,
    userId,
    wordId: dto.wordId,
    reviewStage: dto.reviewStage,
    recognitionScore: dto.recognitionScore,
    spellingScore: dto.spellingScore,
    // 服务端的 firstLearnedAt 为 null 时映射为 undefined（前端类型是可选字段）。
    firstLearnedAt: dto.firstLearnedAt ?? undefined,
    nextReviewAt: dto.nextReviewAt,
    lastReviewAt: dto.lastReviewAt,
    lastRecognitionChoice: dto.lastRecognitionChoice,
    lastRecognitionResult: dto.lastRecognitionResult,
    lastSpellingResult: dto.lastSpellingResult,
    lastGrade: dto.lastGrade,
    killedAt: dto.killedAt,
    lastRestoredAt: dto.lastRestoredAt,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    reviewCount: dto.reviewCount ?? 0,
    correctCount: dto.correctCount ?? 0,
    wrongCount: dto.wrongCount ?? 0,
  };
}

/** 词条响应没有 userId：一律使用调用方传入的 userId，不从响应猜测。 */
function mapWord(value: unknown, userId: string): WordWithProgress {
  const raw = asJsonObject(value);
  const progress = asJsonObject(raw.progress) as unknown as ServerProgress;
  if (typeof raw.id !== "string" || typeof raw.word !== "string") throw invalidResponseError();
  return {
    id: raw.id,
    userId,
    word: raw.word,
    normalizedWord: readOptionalText(raw.normalizedWord),
    phonetic: readText(raw.phonetic),
    meaning: readText(raw.meaning),
    phrase: readText(raw.phrase),
    sentence: readText(raw.sentence),
    sentenceCn: readText(raw.sentenceCn),
    source: readText(raw.source),
    type: raw.type === "marked" ? "marked" : "added",
    createdAt: readText(raw.createdAt),
    updatedAt: readOptionalText(raw.updatedAt),
    progress: mapProgress(progress, userId),
  };
}

function mapWordList(value: unknown, userId: string): WordWithProgress[] {
  if (!Array.isArray(value)) throw invalidResponseError();
  return value.map((item) => mapWord(item, userId));
}

function mapEvent(value: unknown, userId: string): LearningEvent {
  const raw = asJsonObject(value);
  if (typeof raw.id !== "string" || typeof raw.wordId !== "string") throw invalidResponseError();
  return {
    id: raw.id,
    userId,
    wordId: raw.wordId,
    occurredAt: readText(raw.occurredAt),
    kind: raw.kind === "review" ? "review" : "new",
    reviewStage: readNumber(raw.reviewStage),
  };
}

function mapEventList(value: unknown, userId: string): LearningEvent[] {
  if (!Array.isArray(value)) throw invalidResponseError();
  return value.map((item) => mapEvent(item, userId));
}

function mapSettings(value: unknown): ApiSettings {
  const raw = asJsonObject(value);
  const countdown = raw.countdown;
  return {
    dailyTarget: readNumber(raw.dailyTarget),
    dailyGroups: readNumber(raw.dailyGroups),
    dailyGroupWords: readNumber(raw.dailyGroupWords),
    dailyPlanConfigured: readBoolean(raw.dailyPlanConfigured),
    timezone: readText(raw.timezone),
    countdown:
      isRecord(countdown) && typeof countdown.label === "string" && typeof countdown.targetDate === "string"
        ? { label: countdown.label, targetDate: countdown.targetDate }
        : null,
    updatedAt: readText(raw.updatedAt),
  };
}

/**
 * 服务端草稿 → 前端 ReviewDraft。
 *
 * payload 是服务端原样保存的未知数据：这里按结构校验后再取出全部字段，
 * 结构不合法（或被别处写坏）时返回 null，与 localStore 遇到损坏草稿的行为一致，
 * 不抛异常、不丢弃，也不把 payload 之外的响应字段塞进草稿。
 */
function mapDraft(value: unknown, userId: string): ApiReviewDraft | null {
  const raw = asJsonObject(value);
  if (typeof raw.key !== "string") return null;
  const payload = isRecord(raw.payload) ? raw.payload : {};

  const itemIds = readWordIdList(payload.itemIds);
  const recognitionQueueIds = readWordIdList(payload.recognitionQueueIds);
  const phase = readEnum(payload.phase, DRAFT_PHASES);
  const index = payload.index;
  if (!itemIds || !recognitionQueueIds || !phase) return null;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  if (new Set(itemIds).size !== itemIds.length) return null;
  if (!recognitionQueueIds.every((wordId) => itemIds.includes(wordId))) return null;

  const mode = readEnum(raw.mode ?? payload.mode, DRAFT_MODES);
  const scope = readEnum(raw.scope ?? payload.scope, DRAFT_SCOPES);
  if (phase === "learning" && mode !== "new") return null;

  const recognition = readRecognitionMap(payload.recognition);
  const spelling = readSpellingMap(payload.spelling);
  if (!recognition || !spelling) return null;
  if (!Object.keys(recognition).every((wordId) => itemIds.includes(wordId))) return null;
  if (!Object.keys(spelling).every((wordId) => itemIds.includes(wordId))) return null;

  const currentWordId =
    typeof payload.currentWordId === "string" && itemIds.includes(payload.currentWordId)
      ? payload.currentWordId
      : null;

  return {
    version: 1,
    userId,
    key: raw.key,
    revision: readNumber(raw.revision),
    mode,
    scope,
    itemIds,
    recognitionQueueIds,
    phase,
    index,
    recognition,
    spelling,
    hadSpellingError: readBoolean(payload.hadSpellingError),
    currentWordId,
    firstChoice: readEnum(payload.firstChoice, FIRST_CHOICES) ?? null,
    answer: readText(payload.answer),
    spellingChecked: readSpellingResponse(payload.spellingChecked),
    updatedAt: readText(raw.updatedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* 请求工具                                                                    */
/* -------------------------------------------------------------------------- */

type RequestOptions = {
  method: string;
  query?: Record<string, string | number | undefined>;
  /** 只有显式传入时才发送 body；GET 不强行带 body。 */
  body?: unknown;
  /** 仅 session() 使用：401 视为“未登录”，返回 null 而不是抛错。 */
  allowUnauthorized?: boolean;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return `${baseUrl}${path}${search.length > 0 ? `?${search}` : ""}`;
}

/** 读取受控 JSON 错误：非 JSON 响应也转为通用 ApiError，绝不回显响应体。 */
async function readApiError(response: Response): Promise<ApiError> {
  let payload: unknown = null;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    payload = null;
  }

  let code = "request_failed";
  let message = `请求失败（HTTP ${response.status}）`;
  let details: string[] | undefined;

  if (isRecord(payload) && isRecord(payload.error)) {
    const error = payload.error;
    if (typeof error.code === "string" && error.code.length > 0) code = error.code;
    if (typeof error.message === "string" && error.message.length > 0) message = error.message;
    if (Array.isArray(error.details)) {
      details = error.details.filter((item): item is string => typeof item === "string");
    }
  }

  return new ApiError({ status: response.status, code, message, details });
}

function createSubmissionKey(): string {
  const bytes = new Uint8Array(SUBMISSION_KEY_LENGTH);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let key = "";
  for (const byte of bytes) {
    key += SUBMISSION_KEY_ALPHABET[byte % SUBMISSION_KEY_ALPHABET.length];
  }
  return key;
}

/** 显式传入的 submissionKey 必须合法，保证重试复用同一个 key。 */
function resolveSubmissionKey(options: CompletionOptions | undefined): string {
  const provided = options?.submissionKey;
  if (provided === undefined) return createSubmissionKey();
  if (!SUBMISSION_KEY_PATTERN.test(provided)) {
    throw new ApiError({
      status: 400,
      code: "invalid_request",
      message: "submissionKey 需为 8—64 位字母、数字、下划线或连字符",
    });
  }
  return provided;
}

/** 只送 8 个用户可编辑字段：即使调用方传入完整 Word 对象，也不会泄漏 id / userId。 */
function toWordInputPayload(word: WordInput): WordInput {
  return {
    word: word.word,
    phonetic: word.phonetic,
    meaning: word.meaning,
    phrase: word.phrase,
    sentence: word.sentence,
    sentenceCn: word.sentenceCn,
    source: word.source,
    type: word.type,
  };
}

/** 完成提交只带服务端下发的版本，用于冲突判定；不含任何最终结果。 */
function entryVersionPayload(entry: WordWithProgress) {
  return {
    wordId: entry.id,
    updatedAt: entry.progress.updatedAt,
    nextReviewAt: entry.progress.nextReviewAt,
  };
}

/**
 * 复习条目：只转发用户输入。
 * 刻意不转发 recognition.result、progress.reviewStage 与各分数——服务端会重算，
 * 客户端提交的这些值都不是安全边界。
 */
function reviewEntryPayload(
  entry: WordWithProgress,
  recognition: RecognitionResponse | undefined,
  spelling: SpellingResponse | undefined,
) {
  return {
    ...entryVersionPayload(entry),
    ...(recognition
      ? {
          recognition: {
            firstChoice: recognition.firstChoice,
            hadError: recognition.hadError,
            attempts: recognition.attempts,
          },
        }
      : {}),
    ...(spelling
      ? { spelling: { input: spelling.input, correct: spelling.correct, hadError: spelling.hadError } }
      : {}),
  };
}

function spellingEntryPayload(entry: WordWithProgress, spelling: SpellingResponse | undefined) {
  return {
    ...entryVersionPayload(entry),
    ...(spelling
      ? { spelling: { input: spelling.input, correct: spelling.correct, hadError: spelling.hadError } }
      : {}),
  };
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function readDefaultBaseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const value = env?.VITE_API_BASE_URL;
  return typeof value === "string" ? value : "";
}

/* -------------------------------------------------------------------------- */
/* 客户端                                                                      */
/* -------------------------------------------------------------------------- */

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? readDefaultBaseUrl());
  const fetchImpl = options.fetchImpl ?? defaultFetch;

  async function request(path: string, requestOptions: RequestOptions): Promise<unknown> {
    const init: RequestInit = {
      method: requestOptions.method,
      credentials: "include",
      headers: { accept: "application/json" },
    };
    if (requestOptions.body !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(requestOptions.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(baseUrl, path, requestOptions.query), init);
    } catch {
      throw new ApiError({
        status: 0,
        code: "network_error",
        message: "无法连接到服务器，请检查网络后重试",
      });
    }

    if (!response.ok) {
      const error = await readApiError(response);
      if (requestOptions.allowUnauthorized && error.status === 401) return null;
      if (error.status === 401 && typeof window !== "undefined") {
        window.dispatchEvent(new Event("cet-word-api-unauthorized"));
      }
      throw error;
    }

    if (response.status === 204) return null;
    try {
      return (await response.json()) as unknown;
    } catch {
      throw invalidResponseError();
    }
  }

  return {
    async adminStatus(): Promise<boolean> {
      try {
        const body = asJsonObject(await request("/api/admin/me", { method: "GET" }));
        return body.isAdmin === true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) return false;
        throw error;
      }
    },

    async adminUsers(options: ListOptions = {}) {
      const body = asJsonObject(await request("/api/admin/users", { method: "GET", query: options }));
      if (!Array.isArray(body.users) || typeof body.total !== "number") throw invalidResponseError();
      const users = body.users.map((value): AdminUser => {
        const row = asJsonObject(value);
        if (typeof row.id !== "string" || typeof row.email !== "string"
          || (row.username !== null && typeof row.username !== "string")
          || (row.role !== "admin" && row.role !== "learner")
          || (row.disabledAt !== null && typeof row.disabledAt !== "string")
          || typeof row.createdAt !== "string") throw invalidResponseError();
        return { id: row.id, email: row.email, username: row.username, role: row.role,
          disabledAt: row.disabledAt, createdAt: row.createdAt };
      });
      return { users, total: body.total };
    },

    async adminCreateUser(input): Promise<void> {
      await request("/api/admin/users", { method: "POST", body: {
        email: input.email, username: input.username, password: input.password,
      } });
    },

    async adminSetDisabled(id, disabled): Promise<void> {
      await request(`/api/admin/users/${encodeURIComponent(id)}/status`, {
        method: "PATCH", body: { disabled },
      });
    },

    async adminUpdateUser(id, patch): Promise<void> {
      await request(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
    },

    async adminDeleteUser(id): Promise<void> {
      await request(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async adminResetPassword(id, password): Promise<void> {
      await request(`/api/admin/users/${encodeURIComponent(id)}/password-reset`, {
        method: "POST", body: { password },
      });
    },

    async login(email: string, password: string): Promise<LocalUser> {
      const body = asJsonObject(
        await request("/api/auth/login", { method: "POST", body: { email, password } }),
      );
      return mapUser(body.user);
    },

    async session(): Promise<LocalUser | null> {
      const body = await request("/api/auth/me", { method: "GET", allowUnauthorized: true });
      if (body === null) return null;
      return mapUser(asJsonObject(body).user);
    },

    async logout(): Promise<void> {
      await request("/api/auth/logout", { method: "POST" });
    },

    async getProfile(): Promise<LocalUser> {
      const body = asJsonObject(await request("/api/account/profile", { method: "GET" }));
      return mapUser(body.user);
    },

    async updateProfile(profile: { username: string; avatar: string | null }): Promise<LocalUser> {
      const body = asJsonObject(
        await request("/api/account/profile", { method: "PATCH", body: profile }),
      );
      return mapUser(body.user);
    },

    async listWords(userId: string, listOptions: ListOptions = {}) {
      const body = asJsonObject(
        await request("/api/words", {
          method: "GET",
          query: { limit: listOptions.limit, offset: listOptions.offset },
        }),
      );
      return { total: readNumber(body.total), words: mapWordList(body.words, userId) };
    },

    async importWords(input: WordInput[]) {
      const body = asJsonObject(
        await request("/api/words/import", {
          method: "POST",
          body: { words: input.map(toWordInputPayload) },
        }),
      );
      return {
        added: readNumber(body.added),
        existing: readNumber(body.existing),
        total: readNumber(body.total),
      };
    },

    async updateWord(
      userId: string,
      wordId: string,
      phonetic: string,
      meaning: string,
    ): Promise<WordWithProgress> {
      const body = asJsonObject(
        await request(`/api/words/${encodeURIComponent(wordId)}`, {
          method: "PATCH",
          body: { phonetic, meaning },
        }),
      );
      return mapWord(body.word, userId);
    },

    async deleteWord(_userId: string, wordId: string): Promise<void> {
      await request(`/api/words/${encodeURIComponent(wordId)}`, { method: "DELETE" });
    },

    async progressAction(
      userId: string,
      wordId: string,
      action: ProgressAction,
    ): Promise<Progress> {
      const body = asJsonObject(
        await request(`/api/words/${encodeURIComponent(wordId)}/${action}`, { method: "POST" }),
      );
      return mapProgress(asJsonObject(body.progress) as unknown as ServerProgress, userId);
    },

    async getSettings(): Promise<ApiSettings> {
      const body = asJsonObject(await request("/api/settings", { method: "GET" }));
      return mapSettings(body.settings);
    },

    async updateSettings(patch: SettingsPatch): Promise<ApiSettings> {
      const body: Record<string, unknown> = {};
      if (patch.dailyTarget !== undefined) body.dailyTarget = patch.dailyTarget;
      if (patch.dailyGroups !== undefined) body.dailyGroups = patch.dailyGroups;
      if (patch.dailyGroupWords !== undefined) body.dailyGroupWords = patch.dailyGroupWords;
      if (patch.timezone !== undefined) body.timezone = patch.timezone;
      if (patch.countdown !== undefined) body.countdown = patch.countdown;
      if (Object.keys(body).length === 0) {
        throw new ApiError({
          status: 400,
          code: "invalid_request",
          message: "至少需要提供一个可更新字段",
        });
      }
      const response = asJsonObject(await request("/api/settings", { method: "PATCH", body }));
      return mapSettings(response.settings);
    },

    async listEvents(userId: string, listOptions: ListOptions = {}) {
      const body = asJsonObject(
        await request("/api/events", {
          method: "GET",
          query: { limit: listOptions.limit, offset: listOptions.offset },
        }),
      );
      return { total: readNumber(body.total), events: mapEventList(body.events, userId) };
    },

    async getDue(userId: string, limit?: number): Promise<DueQueue> {
      const body = asJsonObject(
        await request("/api/review/due", { method: "GET", query: { limit } }),
      );
      return {
        limit: readNumber(body.limit),
        dailyNewLimit: readNumber(body.dailyNewLimit),
        learnedToday: readNumber(body.learnedToday),
        remainingNew: readNumber(body.remainingNew),
        dueReviewTotal: readNumber(body.dueReviewTotal),
        dueNewTotal: readNumber(body.dueNewTotal),
        reviewWords: mapWordList(body.reviewWords, userId),
        newWords: mapWordList(body.newWords, userId),
      };
    },

    async getSpelling(userId: string, spellingOptions: SpellingOptions = {}) {
      const body = asJsonObject(
        await request("/api/spelling", {
          method: "GET",
          query: {
            scope: spellingOptions.scope,
            filter: spellingOptions.filter,
            limit: spellingOptions.limit,
          },
        }),
      );
      return mapWordList(body.words, userId);
    },

    async getDraft(userId: string, key: string = DEFAULT_DRAFT_KEY): Promise<ApiReviewDraft | null> {
      const body = asJsonObject(
        await request("/api/review/draft", { method: "GET", query: { key } }),
      );
      const draft = body.draft;
      if (draft === null || draft === undefined) return null;
      return mapDraft(draft, userId);
    },

    async saveDraft(
      userId: string,
      draft: DraftInput,
      draftOptions: DraftOptions = {},
    ): Promise<ApiReviewDraft> {
      const key = draftOptions.key ?? DEFAULT_DRAFT_KEY;
      const payload = {
        version: 1,
        mode: draft.mode ?? null,
        scope: draft.scope ?? null,
        itemIds: draft.itemIds,
        recognitionQueueIds: draft.recognitionQueueIds,
        phase: draft.phase,
        index: draft.index,
        recognition: draft.recognition,
        spelling: draft.spelling,
        hadSpellingError: draft.hadSpellingError,
        currentWordId: draft.currentWordId,
        firstChoice: draft.firstChoice,
        answer: draft.answer,
        spellingChecked: draft.spellingChecked,
      };
      const body = asJsonObject(
        await request("/api/review/draft", {
          method: "PUT",
          body: {
            key,
            revision: draftOptions.revision ?? 0,
            mode: payload.mode,
            scope: payload.scope,
            phase: payload.phase,
            payload,
          },
        }),
      );
      const saved = mapDraft(body.draft, userId);
      if (!saved) throw invalidResponseError();
      return saved;
    },

    async clearDraft(key: string = DEFAULT_DRAFT_KEY): Promise<void> {
      await request("/api/review/draft", { method: "DELETE", query: { key } });
    },

    async completeNewStudy(
      _userId: string,
      entries: WordWithProgress[],
      completionOptions?: CompletionOptions,
    ): Promise<NewStudyCompletion> {
      // userId 只用于与本地仓储保持同一调用签名；响应不含实体，提交体也不含身份字段。
      const submissionKey = resolveSubmissionKey(completionOptions);
      const body = asJsonObject(
        await request("/api/study/new/complete", {
          method: "POST",
          body: { submissionKey, entries: entries.map(entryVersionPayload) },
        }),
      );
      return {
        completed: readNumber(body.completed),
        conflicts: readNumber(body.conflicts),
        skipped: readNumber(body.skipped),
        earliestNextReviewAt: readNullableText(body.earliestNextReviewAt),
      };
    },

    async finishReview(
      _userId: string,
      entries: WordWithProgress[],
      recognition: Record<string, RecognitionResponse>,
      spelling: Record<string, SpellingResponse>,
      completionOptions?: CompletionOptions,
    ): Promise<ReviewCompletionResult> {
      const submissionKey = resolveSubmissionKey(completionOptions);
      const body = asJsonObject(
        await request("/api/review/complete", {
          method: "POST",
          body: {
            submissionKey,
            entries: entries.map((entry) =>
              reviewEntryPayload(entry, recognition[entry.id], spelling[entry.id]),
            ),
          },
        }),
      );
      const grades = asJsonObject(body.grades);
      return {
        completed: readNumber(body.completed),
        earliestNextReviewAt: readNullableText(body.earliestNextReviewAt),
        grades: {
          again: readNumber(grades.again),
          hard: readNumber(grades.hard),
          good: readNumber(grades.good),
          easy: readNumber(grades.easy),
        },
        conflicts: readNumber(body.conflicts),
        skipped: readNumber(body.skipped),
      };
    },

    async finishSpellingPractice(
      _userId: string,
      entries: WordWithProgress[],
      spelling: Record<string, SpellingResponse>,
      completionOptions?: CompletionOptions,
    ): Promise<SpellingCompletion> {
      const submissionKey = resolveSubmissionKey(completionOptions);
      const body = asJsonObject(
        await request("/api/spelling/complete", {
          method: "POST",
          body: {
            submissionKey,
            entries: entries.map((entry) => spellingEntryPayload(entry, spelling[entry.id])),
          },
        }),
      );
      return {
        completed: readNumber(body.completed),
        corrected: readNumber(body.corrected),
        conflicts: readNumber(body.conflicts),
        skipped: readNumber(body.skipped),
      };
    },
  };
}

/** 默认单例：同源 + 全局 fetch，读取 VITE_API_BASE_URL（为空即同源）。 */
export const apiClient: ApiClient = createApiClient();
