import type { FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.ts";
import type { WordRepository } from "../repository.ts";

export type HealthRouteOptions = { config: AppConfig; repository: WordRepository };

/**
 * 健康与就绪。
 * - /api/health：只要进程活着就返回 200，不触碰数据库（供反向代理与进程守护探活）。
 * - /api/ready：必须真实探测数据库；数据库不可用时返回 503，绝不返回 200 或 HTML。
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, options) => {
  app.get("/health", async () => ({ ok: true }));

  app.get("/ready", async (_request, reply) => {
    try {
      await options.repository.checkReadiness();
    } catch {
      // 只回报结论，不回传数据库错误细节（可能包含主机名、账号等）。
      reply.code(503);
      return { ok: false, database: "down" };
    }
    return { ok: true, database: "up" };
  });
};
