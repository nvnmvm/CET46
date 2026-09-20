import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { assertPasswordPolicy, hashPassword } from "../auth.ts";
import { sendError, sendValidationError } from "../http.ts";
import { newId } from "../ids.ts";
import {
  adminCreateUserBodySchema,
  adminPasswordResetBodySchema,
  adminStatusBodySchema,
  adminUsersQuerySchema,
  idParamSchema,
} from "../schemas.ts";
import {
  RepositoryConflictError,
  RepositoryForbiddenError,
} from "../repository.ts";
import { requireSessionContext } from "../session.ts";
import type { AppConfig } from "../config.ts";
import type { SessionContext, SessionDependencies } from "../session.ts";

export type AdminRouteOptions = SessionDependencies;
type SessionResolution = { context: SessionContext } | { body: ReturnType<typeof sendError> };

function serializeAdminUser(user: SessionContext["user"]) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    disabledAt: user.disabledAt,
    createdAt: user.createdAt,
  };
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AdminRouteOptions,
): Promise<SessionResolution> {
  const session = await requireSessionContext(request, reply, options);
  if ("body" in session) return session;
  if (session.context.user.role !== "admin") {
    return { body: sendError(reply, 403, "forbidden", "需要管理员权限") };
  }
  return session;
}

function requireSameOrigin(request: FastifyRequest, reply: FastifyReply, config: AppConfig) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin !== config.appOrigin) {
    return sendError(reply, 403, "origin_forbidden", "请求来源不被允许");
  }
  return null;
}

function repositoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof RepositoryConflictError) {
    return sendError(reply, 409, error.code, "账号操作冲突");
  }
  if (error instanceof RepositoryForbiddenError) {
    return sendError(reply, 403, error.code, "当前管理员操作不被允许");
  }
  throw error;
}

function assertAdminPassword(reply: FastifyReply, password: string) {
  try {
    assertPasswordPolicy(password);
    return null;
  } catch (error) {
    return sendError(reply, 400, "invalid_password", error instanceof Error ? error.message : "密码不符合策略");
  }
}

export const adminRoutes: FastifyPluginAsync<AdminRouteOptions> = async (app, options) => {
  app.get("/admin/me", async (request, reply) => {
    const session = await requireAdmin(request, reply, options);
    if ("body" in session) return session.body;
    return { isAdmin: true };
  });

  app.get("/admin/users", async (request, reply) => {
    const session = await requireAdmin(request, reply, options);
    if ("body" in session) return session.body;
    const parsed = adminUsersQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const result = await options.repository.adminListUsers(parsed.data);
    return {
      users: result.users.map(serializeAdminUser),
      total: result.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    };
  });

  app.post("/admin/users", async (request, reply) => {
    const session = await requireAdmin(request, reply, options);
    if ("body" in session) return session.body;
    const originError = requireSameOrigin(request, reply, options.config);
    if (originError) return originError;
    const parsed = adminCreateUserBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const passwordError = assertAdminPassword(reply, parsed.data.password);
    if (passwordError) return passwordError;
    try {
      const user = await options.repository.adminCreateUser(session.context.user.id, {
        id: newId("user"),
        email: parsed.data.email,
        username: parsed.data.username || null,
        passwordHash: await hashPassword(parsed.data.password),
        timezone: "Asia/Shanghai",
      });
      return { user: serializeAdminUser(user) };
    } catch (error) {
      return repositoryError(reply, error);
    }
  });

  app.patch("/admin/users/:id/status", async (request, reply) => {
    const session = await requireAdmin(request, reply, options);
    if ("body" in session) return session.body;
    const originError = requireSameOrigin(request, reply, options.config);
    if (originError) return originError;
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const parsed = adminStatusBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    try {
      const user = await options.repository.adminSetUserDisabled(
        session.context.user.id,
        params.data.id,
        parsed.data.disabled,
      );
      if (!user) return sendError(reply, 404, "not_found", "账号不存在");
      return { user: serializeAdminUser(user) };
    } catch (error) {
      return repositoryError(reply, error);
    }
  });

  app.post("/admin/users/:id/password-reset", async (request, reply) => {
    const session = await requireAdmin(request, reply, options);
    if ("body" in session) return session.body;
    const originError = requireSameOrigin(request, reply, options.config);
    if (originError) return originError;
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const parsed = adminPasswordResetBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const passwordError = assertAdminPassword(reply, parsed.data.password);
    if (passwordError) return passwordError;
    try {
      const user = await options.repository.adminResetUserPassword(
        session.context.user.id,
        params.data.id,
        await hashPassword(parsed.data.password),
      );
      if (!user) return sendError(reply, 404, "not_found", "账号不存在");
      return { user: serializeAdminUser(user) };
    } catch (error) {
      return repositoryError(reply, error);
    }
  });
};
