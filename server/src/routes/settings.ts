import type { FastifyPluginAsync } from "fastify";
import { sendValidationError } from "../http.ts";
import type { UpdateSettingsPatch } from "../repository.ts";
import { eventsQuerySchema, updateSettingsBodySchema } from "../schemas.ts";
import { serializeEvent, serializeSettings } from "../serialize.ts";
import { requireSessionContext } from "../session.ts";
import type { SessionDependencies } from "../session.ts";

export type SettingsRouteOptions = SessionDependencies;

/**
 * 设置与学习事件。
 *
 * 身份只来自会话 Cookie：请求体/查询串里的 userId 不参与授权（strictObject 会直接拒绝多余字段）。
 * 每日计划默认值与 localStore 一致（target 20、groups 2、每组 10）。
 */
export const settingsRoutes: FastifyPluginAsync<SettingsRouteOptions> = async (app, options) => {
  app.get("/settings", async (request, reply) => {
    const session = await requireSessionContext(request, reply, options);
    if ("body" in session) return session.body;

    const settings = await options.repository.ensureUserSettings(session.context.user.id);
    return { settings: serializeSettings(settings) };
  });

  app.patch("/settings", async (request, reply) => {
    const session = await requireSessionContext(request, reply, options);
    if ("body" in session) return session.body;

    const parsed = updateSettingsBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const body = parsed.data;
    const patch: UpdateSettingsPatch = {};
    if (body.dailyTarget !== undefined) patch.dailyTarget = body.dailyTarget;
    if (body.dailyGroups !== undefined) patch.dailyGroups = body.dailyGroups;
    if (body.dailyGroupWords !== undefined) patch.dailyGroupWords = body.dailyGroupWords;
    if (body.timezone !== undefined) patch.timezone = body.timezone;
    if (body.countdown !== undefined) {
      if (body.countdown === null) {
        patch.countdownLabel = null;
        patch.countdownTargetDate = null;
      } else {
        patch.countdownLabel = body.countdown.label;
        patch.countdownTargetDate = body.countdown.targetDate;
      }
    }

    const settings = await options.repository.updateUserSettings(session.context.user.id, patch);
    return { settings: serializeSettings(settings) };
  });

  app.get("/events", async (request, reply) => {
    const session = await requireSessionContext(request, reply, options);
    if ("body" in session) return session.body;

    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const { limit, offset } = parsed.data;
    const userId = session.context.user.id;
    const [total, events] = await Promise.all([
      options.repository.countEvents(userId),
      options.repository.listEvents(userId, { limit, offset }),
    ]);
    return { total, limit, offset, events: events.map(serializeEvent) };
  });
};
