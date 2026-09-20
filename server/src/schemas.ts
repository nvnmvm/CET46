import { z } from "zod";

/**
 * 输入/输出校验与非规范化处理。
 *
 * 与服务端边界相关的两条硬规则：
 * 1. 请求体/查询串里的 userId 不参与授权判断；顶层请求体一律使用 strictObject，多传 userId 直接 400。
 * 2. 单词规范化必须与 app/src/data/localStore.ts 保持一致（trim + 小写），否则同一用户会出现重复词条。
 */

export const WORD_MAX_LENGTH = 190;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONETIC_PATTERN = /^\/[^/]+\/$/;

export const emailSchema = z
  .string()
  .max(254)
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => EMAIL_PATTERN.test(value), { message: "邮箱格式无效" });

export const wordTypeSchema = z.enum(["marked", "added"]);
export type WordType = z.infer<typeof wordTypeSchema>;

export const reviewGradeSchema = z.enum(["again", "hard", "good", "easy"]);
export type ReviewGrade = z.infer<typeof reviewGradeSchema>;

/**
 * 进度边界值与 database/migrations/001_initial_mysql.sql 的 CHECK 约束一致。
 * 本批没有复习提交接口，这几个 schema 固定边界值，供下一批复习接口复用。
 */
export const progressStageSchema = z.number().int().min(0).max(6);
export const progressScoreSchema = z.number().int().min(0).max(5);

export const wordInputSchema = z
  .object({
    word: z.string().min(1, "单词不能为空").max(WORD_MAX_LENGTH),
    phonetic: z.string().max(WORD_MAX_LENGTH).default(""),
    meaning: z.string().max(2000).default(""),
    phrase: z.string().max(1000).default(""),
    sentence: z.string().max(2000).default(""),
    sentenceCn: z.string().max(2000).default(""),
    source: z.string().max(WORD_MAX_LENGTH).default(""),
    type: wordTypeSchema.default("added"),
  })
  .transform((value) => {
    const normalizedWord = value.word.trim().toLowerCase();
    return {
      normalizedWord,
      word: normalizedWord,
      phonetic: value.phonetic.trim(),
      meaning: value.meaning.trim(),
      phrase: value.phrase.trim(),
      sentence: value.sentence.trim(),
      sentenceCn: value.sentenceCn.trim(),
      source: value.source.trim(),
      type: value.type,
    };
  })
  .refine((value) => value.normalizedWord.length > 0, { message: "单词不能为空" });

export type NormalizedWordInput = z.infer<typeof wordInputSchema>;

/** 与 app/src/data/localStore.ts 的 importWords 合并规则保持一致的纯函数。 */
export type MergeableWordFields = {
  phonetic: string;
  meaning: string;
  phrase: string;
  sentence: string;
  sentenceCn: string;
  source: string;
  type: WordType;
};

export function mergeWordFields<T extends MergeableWordFields>(
  existing: T,
  incoming: MergeableWordFields,
): T {
  return {
    ...existing,
    phonetic: incoming.phonetic || existing.phonetic || "",
    meaning: incoming.meaning || existing.meaning,
    phrase: incoming.phrase || existing.phrase,
    sentence: incoming.sentence || existing.sentence,
    sentenceCn: incoming.sentenceCn || existing.sentenceCn,
    source: incoming.source || existing.source,
    type: existing.type === "marked" || incoming.type !== "marked" ? existing.type : "marked",
  };
}

export const IMPORT_MAX_WORDS = 500;

export const importBodySchema = z.strictObject({
  words: z.array(wordInputSchema).min(1, "至少要导入一个词条").max(IMPORT_MAX_WORDS),
});

export const updateWordBodySchema = z
  .strictObject({
    phonetic: z.string().max(WORD_MAX_LENGTH).optional(),
    meaning: z.string().max(2000).optional(),
  })
  .refine((value) => value.phonetic !== undefined || value.meaning !== undefined, {
    message: "至少需要提供 phonetic 或 meaning",
  })
  .transform((value) => ({
    phonetic: value.phonetic?.trim(),
    meaning: value.meaning?.trim(),
  }))
  .refine((value) => value.phonetic !== undefined || value.meaning !== undefined, {
    message: "至少需要提供 phonetic 或 meaning",
  })
  .refine(
    (value) => value.phonetic === undefined || PHONETIC_PATTERN.test(value.phonetic),
    { message: "音标必须是 /.../ 格式" },
  )
  .refine((value) => value.meaning === undefined || value.meaning.length > 0, {
    message: "释义不能为空",
  });

export type UpdateWordPatch = { phonetic?: string; meaning?: string };

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 100;

export const listWordsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const idParamSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, { message: "id 格式无效" }),
});

export const loginBodySchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, "密码不能为空").max(200),
});

/** 用户仅可改公开展示资料；禁止在请求体携带 userId、email 或 password。 */
export const updateProfileBodySchema = z.strictObject({
  username: z.string().trim().min(1, "昵称不能为空").max(64),
  avatar: z.string().trim().min(1, "头像不能为空").max(64).nullable(),
});

export const ADMIN_USERS_DEFAULT_LIMIT = 50;
export const ADMIN_USERS_MAX_LIMIT = 100;

export const adminUsersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(ADMIN_USERS_MAX_LIMIT).default(ADMIN_USERS_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const adminCreateUserBodySchema = z.strictObject({
  email: emailSchema,
  username: z.string().trim().max(64).optional().default(""),
  password: z.string().min(1, "密码不能为空").max(200),
});

export const adminStatusBodySchema = z.strictObject({ disabled: z.boolean() });

export const adminPasswordResetBodySchema = z.strictObject({
  password: z.string().min(1, "密码不能为空").max(200),
});

// ---------------------------------------------------------------------------
// 第二批：设置、事件、到期队列、拼写队列、草稿、完成提交
// ---------------------------------------------------------------------------

/** 所有完成提交与草稿的键都限制字符集与长度，避免超长、含控制字符的键进入数据库。 */
export const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const DRAFT_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
export const COMPLETION_MAX_ENTRIES = 100;
export const DRAFT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DRAFT_MAX_PAYLOAD_WORDS = 1000;

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** 只接受服务端下发过的 UTC ISO 时间，避免时区偏移导致版本比对失真。 */
export const utcIsoSchema = z
  .string()
  .max(30)
  .refine((value) => UTC_ISO_PATTERN.test(value) && Number.isFinite(Date.parse(value)), {
    message: "时间必须是 UTC ISO 格式",
  });

export const submissionKeySchema = z.string().regex(SUBMISSION_KEY_PATTERN, {
  message: "submissionKey 需为 8—64 位字母、数字、下划线或连字符",
});

export const draftKeySchema = z.string().regex(DRAFT_KEY_PATTERN, {
  message: "草稿 key 格式无效",
});

export const wordIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, { message: "wordId 格式无效" });

export const recognitionInputSchema = z.strictObject({
  firstChoice: z.enum(["known", "unknown"]),
  hadError: z.boolean(),
  attempts: z.number().int().min(1).max(1000),
  // 客户端可能同时提交自评结果；服务端只用 hadError 计算，这里接受但忽略，不参与任何写入。
  result: z.enum(["correct", "wrong"]).optional(),
});

export const spellingInputSchema = z.strictObject({
  input: z.string().max(WORD_MAX_LENGTH),
  correct: z.boolean(),
  hadError: z.boolean(),
});

const entryVersionShape = {
  wordId: wordIdSchema,
  updatedAt: utcIsoSchema,
  nextReviewAt: utcIsoSchema,
};

export const newStudyEntrySchema = z.strictObject(entryVersionShape);
export const reviewEntrySchema = z.strictObject({
  ...entryVersionShape,
  recognition: recognitionInputSchema,
  spelling: spellingInputSchema,
});
export const spellingEntrySchema = z.strictObject({
  ...entryVersionShape,
  spelling: spellingInputSchema,
});

export const newStudyCompleteBodySchema = z.strictObject({
  submissionKey: submissionKeySchema,
  entries: z.array(newStudyEntrySchema).min(1, "至少要提交一个词").max(COMPLETION_MAX_ENTRIES),
});

export const reviewCompleteBodySchema = z.strictObject({
  submissionKey: submissionKeySchema,
  entries: z.array(reviewEntrySchema).min(1, "至少要提交一个词").max(COMPLETION_MAX_ENTRIES),
});

export const spellingCompleteBodySchema = z.strictObject({
  submissionKey: submissionKeySchema,
  entries: z.array(spellingEntrySchema).min(1, "至少要提交一个词").max(COMPLETION_MAX_ENTRIES),
});

export const EVENT_MAX_LIMIT = 500;
export const EVENT_MAX_WINDOW = 5000;

export const eventsQuerySchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(EVENT_MAX_LIMIT).default(200),
    offset: z.coerce.number().int().min(0).max(EVENT_MAX_WINDOW).default(0),
  })
  .refine((value) => value.offset + value.limit <= EVENT_MAX_WINDOW, {
    message: `最多只能读取最近 ${EVENT_MAX_WINDOW} 条事件`,
  });

export const DUE_DEFAULT_LIMIT = 50;
export const DUE_MAX_LIMIT = 200;

export const dueQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(DUE_MAX_LIMIT).default(DUE_DEFAULT_LIMIT),
});

export const SPELLING_DEFAULT_LIMIT = 20;
export const SPELLING_DAILY_MAX_LIMIT = 20;
export const SPELLING_LIBRARY_MAX_LIMIT = 50;

export const spellingQuerySchema = z
  .strictObject({
    scope: z.enum(["daily", "library"]).default("daily"),
    filter: z.string().max(WORD_MAX_LENGTH).optional(),
    limit: z.coerce.number().int().min(1).max(SPELLING_LIBRARY_MAX_LIMIT).default(SPELLING_DEFAULT_LIMIT),
  })
  .refine((value) => value.scope !== "daily" || value.limit <= SPELLING_DAILY_MAX_LIMIT, {
    message: `每日拼写队列最多 ${SPELLING_DAILY_MAX_LIMIT} 个词`,
  });

export const draftQuerySchema = z.strictObject({ key: draftKeySchema });

export const draftModeSchema = z.enum(["all", "new", "review", "spell"]);
export const draftScopeSchema = z.enum(["daily", "library"]);
export const draftPhaseSchema = z.enum(["learning", "recognition", "summary", "spelling"]);

export const saveDraftBodySchema = z.strictObject({
  key: draftKeySchema,
  revision: z.number().int().min(0).max(1_000_000).default(0),
  mode: draftModeSchema.nullable().optional(),
  scope: draftScopeSchema.nullable().optional(),
  phase: draftPhaseSchema.nullable().optional(),
  payload: z.unknown().optional(),
});

function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export const countdownSchema = z.strictObject({
  label: z.string().trim().min(1, "倒数日名称不能为空").max(32),
  targetDate: z.string().refine(isCalendarDate, { message: "目标日期必须是有效的 YYYY-MM-DD" }),
});

export const updateSettingsBodySchema = z
  .strictObject({
    dailyTarget: z.number().int().min(0).max(100).optional(),
    dailyGroups: z.number().int().min(1).max(20).optional(),
    dailyGroupWords: z.number().int().min(1).max(20).optional(),
    timezone: z
      .string()
      .max(64)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
          return value.trim().length > 0;
        } catch {
          return false;
        }
      }, { message: "无效的时区" })
      .optional(),
    countdown: countdownSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.dailyTarget !== undefined ||
      value.dailyGroups !== undefined ||
      value.dailyGroupWords !== undefined ||
      value.timezone !== undefined ||
      value.countdown !== undefined,
    { message: "至少需要提供一个可更新字段" },
  );

export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;
