import type { FastifyPluginAsync } from "fastify";
import { sendNotFound, sendValidationError } from "../http.ts";
import { updateProfileBodySchema } from "../schemas.ts";
import { requireSessionContext } from "../session.ts";
import type { SessionDependencies } from "../session.ts";
import { publicUser } from "./auth.ts";

/** 当前会话用户的资料。身份只来自 Cookie，不接受 userId 或邮箱字段。 */
export const accountRoutes: FastifyPluginAsync<SessionDependencies> = async (app, options) => {
  app.get("/account/profile", async (request, reply) => {
    const session = await requireSessionContext(request, reply, options);
    if ("body" in session) return session.body;
    return { user: publicUser(session.context.user) };
  });

  app.patch("/account/profile", async (request, reply) => {
    const session = await requireSessionContext(request, reply, options);
    if ("body" in session) return session.body;
    const parsed = updateProfileBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const updated = await options.repository.updateUserProfile(session.context.user.id, parsed.data);
    if (!updated) return sendNotFound(reply);
    return { user: publicUser(updated) };
  });
};
