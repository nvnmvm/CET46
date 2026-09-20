import type { FastifyReply } from "fastify";
import type { ZodError } from "zod";

/**
 * 统一 JSON 错误响应。所有 /api/* 的失败都必须返回 JSON，
 * 绝不能让反向代理把错误请求回退到 SPA 的 index.html。
 */

export type ErrorBody = { error: { code: string; message: string; details?: string[] } };

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: string[],
): ErrorBody {
  reply.code(status);
  return details && details.length > 0
    ? { error: { code, message, details } }
    : { error: { code, message } };
}

/** 只回传字段路径与规则说明，不回显用户提交的值。 */
export function sendValidationError(reply: FastifyReply, error: ZodError): ErrorBody {
  const details = error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  return sendError(reply, 400, "invalid_request", "请求参数不合法", details);
}

export function sendUnauthorized(reply: FastifyReply): ErrorBody {
  return sendError(reply, 401, "unauthorized", "未登录或会话已失效");
}

/** 词条不存在与词条属于他人返回同一个响应，避免通过状态差异探测别人的数据。 */
export function sendNotFound(reply: FastifyReply): ErrorBody {
  return sendError(reply, 404, "not_found", "词条不存在");
}
