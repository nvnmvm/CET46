import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { sendNotFound, sendUnauthorized, sendValidationError } from "../http.ts";
import type { ErrorBody } from "../http.ts";
import {
  idParamSchema,
  importBodySchema,
  listWordsQuerySchema,
  updateWordBodySchema,
} from "../schemas.ts";
import type { ProgressRecord, WordWithProgress } from "../repository.ts";
import { serializeProgress, serializeWord } from "../serialize.ts";
import { resolveSession } from "../session.ts";
import type { SessionContext, SessionDependencies } from "../session.ts";

export type WordRouteOptions = SessionDependencies;

type SessionResolution = { context: SessionContext } | { body: ErrorBody };

export const wordRoutes: FastifyPluginAsync<WordRouteOptions> = async (app, options) => {
  /**
   * 注意：未登录时返回的是可以直接回给客户端的 body，
   * 不要把 Fastify 的 reply 对象当作响应值返回（那会让 Fastify 序列化 reply 自身）。
   */
  const requireSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionResolution> => {
    const context = await resolveSession(request, options);
    return context ? { context } : { body: sendUnauthorized(reply) };
  };

  app.get("/words", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = listWordsQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const { limit, offset } = parsed.data;
    const [words, total] = await Promise.all([
      options.repository.listWords(session.context.user.id, { limit, offset }),
      options.repository.countWords(session.context.user.id),
    ]);
    return { total, limit, offset, words: words.map(serializeWord) };
  });

  app.post("/words/import", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const parsed = importBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const result = await options.repository.importWords(
      session.context.user.id,
      parsed.data.words,
    );
    const total = await options.repository.countWords(session.context.user.id);
    return { added: result.added, existing: result.existing, total };
  });

  app.patch("/words/:id", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const body = updateWordBodySchema.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);

    const updated = await options.repository.updateWord(
      session.context.user.id,
      params.data.id,
      body.data,
    );
    if (!updated) return sendNotFound(reply);
    const pair = await options.repository.getWord(session.context.user.id, updated.id);
    if (!pair) return sendNotFound(reply);
    return { word: serializeWord(pair) };
  });

  app.delete("/words/:id", async (request, reply) => {
    const session = await requireSession(request, reply);
    if ("body" in session) return session.body;

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);

    const deleted = await options.repository.deleteWord(session.context.user.id, params.data.id);
    if (!deleted) return sendNotFound(reply);
    return { ok: true, deleted: true };
  });

  const progressAction = (
    action: "kill" | "restore" | "undo-kill",
    run: (userId: string, wordId: string) => Promise<ProgressRecord | null>,
  ) => {
    app.post(`/words/:id/${action}`, async (request, reply) => {
      const session = await requireSession(request, reply);
      if ("body" in session) return session.body;

      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return sendValidationError(reply, params.error);

      const progress = await run(session.context.user.id, params.data.id);
      if (!progress) return sendNotFound(reply);
      return { ok: true, progress: serializeProgress(progress) };
    });
  };

  progressAction("kill", (userId, wordId) => options.repository.killWord(userId, wordId));
  progressAction("restore", (userId, wordId) => options.repository.restoreWord(userId, wordId));
  progressAction("undo-kill", (userId, wordId) => options.repository.undoKillWord(userId, wordId));
};
