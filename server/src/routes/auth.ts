import type { FastifyPluginAsync } from "fastify";
import { newId } from "../ids.ts";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  formatCookieValue,
  generateSessionToken,
  hashSessionToken,
  verifyPasswordOrDummy,
} from "../auth.ts";
import { addSecondsIso } from "../db.ts";
import { sendError, sendUnauthorized, sendValidationError } from "../http.ts";
import { loginBodySchema } from "../schemas.ts";
import type { UserRecord } from "../repository.ts";
import { readSessionToken, resolveSession } from "../session.ts";
import type { SessionDependencies } from "../session.ts";

export type AuthRouteOptions = SessionDependencies;

/** 只回传浏览器需要的资料，绝不含 password_hash。 */
export function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    timezone: user.timezone,
    createdAt: user.createdAt,
  };
}

/**
 * 认证路由。本批不提供公开注册：首个账号由 `node server/scripts/create-user.ts` 一次性创建。
 */
export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  const { config, repository } = options;

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const user = await repository.findUserByEmail(parsed.data.email);
    // 账号不存在时也执行一次等价开销的校验，避免通过响应时间枚举账号。
    const valid = await verifyPasswordOrDummy(user?.passwordHash ?? null, parsed.data.password);
    if (!user || !valid) {
      return sendError(reply, 401, "invalid_credentials", "邮箱或密码不正确");
    }

    const token = generateSessionToken();
    const expiresAt = addSecondsIso(new Date(), config.sessionTtlSeconds);
    await repository.createSession({
      id: newId("sess"),
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });

    reply.header(
      "set-cookie",
      buildSessionCookie(formatCookieValue(token, config.sessionSecret), {
        secure: config.cookieSecure,
        maxAgeSeconds: config.sessionTtlSeconds,
      }),
    );
    return { user: publicUser(user) };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = readSessionToken(request, config);
    if (token) {
      await repository.revokeSession(hashSessionToken(token), new Date().toISOString());
    }
    reply.header("set-cookie", buildClearedSessionCookie({ secure: config.cookieSecure }));
    return { ok: true };
  });

  app.get("/auth/me", async (request, reply) => {
    const context = await resolveSession(request, options);
    if (!context) return sendUnauthorized(reply);
    return { user: publicUser(context.user) };
  });
};
