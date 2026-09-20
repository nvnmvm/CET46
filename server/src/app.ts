import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config.ts";
import type { WordRepository } from "./repository.ts";
import { authRoutes } from "./routes/auth.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes } from "./routes/admin.ts";
import { healthRoutes } from "./routes/health.ts";
import { reviewRoutes } from "./routes/review.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { wordRoutes } from "./routes/words.ts";

/**
 * 可注入依赖的 Fastify app 工厂：测试直接 buildApp({ config, repository }) + app.inject()，
 * 不需要监听端口，也不需要 MySQL。
 */

export type BuildAppOptions = {
  config: AppConfig;
  repository: WordRepository;
  logger?: FastifyServerOptions["logger"];
};

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // 生产运行在 OpenResty 反代之后；这里不信任 X-Forwarded-*，Cookie 只依赖同源。
    trustProxy: false,
  });

  app.setErrorHandler((error, request, reply) => {
    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === "number" ? rawStatus : 500;
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    request.log.error({ status }, "请求处理失败");
    if (reply.sent) return;
    reply.code(status).send({
      error: {
        code: status === 500 ? "internal_error" : "request_error",
        message: status === 500 ? "服务器内部错误" : "请求处理失败",
      },
    });
  });

  // /api/* 的未知路径必须是 JSON 404，不能回退到 SPA 的 index.html。
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: "接口不存在" } });
  });

  const shared = { config: options.config, repository: options.repository };
  void app.register(healthRoutes, { prefix: "/api", ...shared });
  void app.register(authRoutes, { prefix: "/api", ...shared });
  void app.register(accountRoutes, { prefix: "/api", ...shared });
  void app.register(adminRoutes, { prefix: "/api", ...shared });
  void app.register(wordRoutes, { prefix: "/api", ...shared });
  void app.register(settingsRoutes, { prefix: "/api", ...shared });
  void app.register(reviewRoutes, { prefix: "/api", ...shared });

  return app;
}
