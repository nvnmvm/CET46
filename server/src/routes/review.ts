import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorBody } from "../http.ts";
import { sendError, sendValidationError } from "../http.ts";
import {
  computeDailyNewLimit,
  dayRangeInTimeZone,
  selectDueQueue,
} from "../learningRules.ts";
import type { CompletionInput, WordWithProgress } from "../repository.ts";
import {
  DRAFT_MAX_PAYLOAD_BYTES,
  dueQuerySchema,
  draftQuerySchema,
  newStudyCompleteBodySchema,
  reviewCompleteBodySchema,
  saveDraftBodySchema,
  spellingCompleteBodySchema,
  spellingQuerySchema,
  SPELLING_DAILY_MAX_LIMIT,
} from "../schemas.ts";
import { serializeDraft, serializeWord } from "../serialize.ts";
import { requireSessionContext } from "../session.ts";
import type { SessionContext, SessionDependencies } from "../session.ts";

export type ReviewRouteOptions = SessionDependencies;

/** 一次取候选词的上限：limit 与“剩余新词”之和，仍然有硬上限，避免一次拉全库。 */
const DUE_CANDIDATE_MAX = 1000;

type SessionResolution = { context: SessionContext } | { body: ErrorBody };

export const reviewRoutes: FastifyPluginAsync<ReviewRouteOptions> = async (app, options) => {
  const requireSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionResolution> => requireSessionContext(request, reply, options);

  // -------------------------------------------------------------------------
  // 到期队列与拼写队列
  // -------------------------------------------------------------------------

  app.get("/review/due", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = dueQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const userId = session.context.user.id;
    const settings = await options.repository.ensureUserSettings(userId);
    const now = new Date();
    const { startIso, endIso } = dayRangeInTimeZone(now, settings.timezone);
    const dailyNewLimit = computeDailyNewLimit(settings);
    const learnedToday = await options.repository.countWordsLearnedBetween(
      userId,
      startIso,
      endIso,
    );
    const remainingNew = Math.max(0, dailyNewLimit - learnedToday);
    const pool = Math.min(parsed.data.limit + remainingNew, DUE_CANDIDATE_MAX);
    const candidates = await options.repository.listDueCandidates(
      userId,
      now.toISOString(),
      pool,
    );
    const selection = selectDueQueue(candidates, {
      learnedToday,
      dailyNewLimit,
      limit: parsed.data.limit,
    });
    return {
      limit: parsed.data.limit,
      dailyNewLimit,
      learnedToday,
      remainingNew,
      dueReviewTotal: selection.reviewTotal,
      dueNewTotal: selection.newTotal,
      reviewWords: selection.reviewWords.map(serializeWord),
      newWords: selection.newWords.map(serializeWord),
    };
  });

  app.get("/spelling", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = spellingQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const userId = session.context.user.id;
    const { scope, limit } = parsed.data;
    const filter = parsed.data.filter?.trim() ?? "";
    let words: WordWithProgress[];

    if (scope === "daily") {
      // 与 localStore.getSpellingWords 一致：只抽当天第一次完成新学的词。
      const settings = await options.repository.ensureUserSettings(userId);
      const { startIso, endIso } = dayRangeInTimeZone(new Date(), settings.timezone);
      words = await options.repository.listWordsLearnedBetween(userId, startIso, endIso, limit);
    } else {
      words = await options.repository.listLibraryWords(userId, {
        filter: filter.length > 0 ? filter : null,
        limit,
      });
    }

    return {
      scope,
      limit,
      filter: filter.length > 0 ? filter : null,
      dailyMaxLimit: SPELLING_DAILY_MAX_LIMIT,
      words: words.map(serializeWord),
    };
  });

  // -------------------------------------------------------------------------
  // 服务端草稿
  // -------------------------------------------------------------------------

  app.get("/review/draft", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = draftQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const draft = await options.repository.getReviewDraft(
      session.context.user.id,
      parsed.data.key,
    );
    return { draft: draft ? serializeDraft(draft) : null };
  });

  app.put("/review/draft", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = saveDraftBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const payload = parsed.data.payload ?? null;
    let payloadBytes: number;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
    } catch {
      return sendError(reply, 400, "invalid_request", "草稿内容无法序列化");
    }
    if (payloadBytes > DRAFT_MAX_PAYLOAD_BYTES) {
      return sendError(
        reply,
        413,
        "payload_too_large",
        `草稿内容不能超过 ${DRAFT_MAX_PAYLOAD_BYTES} 字节`,
      );
    }

    const outcome = await options.repository.saveReviewDraft(session.context.user.id, {
      draftKey: parsed.data.key,
      revision: parsed.data.revision,
      mode: parsed.data.mode ?? null,
      scope: parsed.data.scope ?? null,
      phase: parsed.data.phase ?? null,
      payload,
      payloadBytes,
    });
    if (outcome.status === "conflict") {
      // 冲突时回传当前 revision，客户端据此重新读取后再决定是否覆盖。
      return sendError(reply, 409, "revision_conflict", "草稿版本冲突，请重新读取后再保存", [
        `currentRevision: ${outcome.currentRevision ?? "null"}`,
      ]);
    }
    return { draft: serializeDraft(outcome.draft) };
  });

  app.delete("/review/draft", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = draftQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const deleted = await options.repository.deleteReviewDraft(
      session.context.user.id,
      parsed.data.key,
    );
    return { ok: true, deleted };
  });

  // -------------------------------------------------------------------------
  // 完成提交（幂等 + 事务）
  // -------------------------------------------------------------------------

  app.post("/study/new/complete", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = newStudyCompleteBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const input = toCompletionInput(parsed.data.submissionKey, parsed.data.entries);
    return options.repository.completeNewStudy(session.context.user.id, input);
  });

  app.post("/review/complete", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = reviewCompleteBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const input = toCompletionInput(parsed.data.submissionKey, parsed.data.entries);
    return options.repository.completeReview(session.context.user.id, input);
  });

  app.post("/spelling/complete", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = spellingCompleteBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const input = toCompletionInput(parsed.data.submissionKey, parsed.data.entries);
    return options.repository.completeSpelling(session.context.user.id, input);
  });
};

type CompletionEntryPayload = {
  wordId: string;
  updatedAt: string;
  nextReviewAt: string;
  recognition?: { firstChoice: "known" | "unknown"; hadError: boolean; attempts: number };
  spelling?: { input: string; correct: boolean; hadError: boolean };
};

/**
 * 只把“答案输入”和版本信息送进仓储层。
 * 注意：请求体里即使带上 stage / score / nextReviewAt 之外的最终结果字段，
 * strictObject 也会拒绝；服务端永远重新计算。
 */
function toCompletionInput(
  submissionKey: string,
  entries: CompletionEntryPayload[],
): CompletionInput {
  return {
    submissionKey,
    entries: entries.map((entry) => ({
      wordId: entry.wordId,
      updatedAt: entry.updatedAt,
      nextReviewAt: entry.nextReviewAt,
      recognition: entry.recognition
        ? {
            firstChoice: entry.recognition.firstChoice,
            hadError: entry.recognition.hadError,
            attempts: entry.recognition.attempts,
          }
        : undefined,
      spelling: entry.spelling
        ? {
            input: entry.spelling.input,
            correct: entry.spelling.correct,
            hadError: entry.spelling.hadError,
          }
        : undefined,
    })),
  };
}
