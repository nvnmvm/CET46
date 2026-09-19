import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "./config.ts";
import type { AppConfig } from "./config.ts";
import {
  hashSessionToken,
  readCookie,
  readSignedCookieValue,
} from "./auth.ts";
import { sendUnauthorized } from "./http.ts";
import type { ErrorBody } from "./http.ts";
import type { SessionRecord, UserRecord, WordRepository } from "./repository.ts";

/**
 * 会话解析：用户的唯一身份来源是同源 HttpOnly Cookie。
 * 请求体、查询串、请求头里的 userId 一律不作为权限依据。
 */

export type SessionContext = { session: SessionRecord; user: UserRecord };

export type SessionDependencies = { config: AppConfig; repository: WordRepository };

/** 取出 cookie 中经过签名校验的原始 token；格式或签名不对则返回 null。 */
export function readSessionToken(request: FastifyRequest, config: AppConfig): string | null {
  const raw = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  if (!raw) return null;
  return readSignedCookieValue(raw, config.sessionSecret);
}

export async function resolveSession(
  request: FastifyRequest,
  dependencies: SessionDependencies,
): Promise<SessionContext | null> {
  const token = readSessionToken(request, dependencies.config);
  if (!token) return null;
  const found = await dependencies.repository.findActiveSessionByTokenHash(
    hashSessionToken(token),
    new Date().toISOString(),
  );
  return found ?? null;
}

/**
 * 统一的会话解析结果：未登录时返回可以直接回给客户端的 body。
 * 不要把 Fastify 的 reply 对象当作响应值返回（那会让 Fastify 序列化 reply 自身）。
 */
export type SessionResolution = { context: SessionContext } | { body: ErrorBody };

export async function requireSessionContext(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: SessionDependencies,
): Promise<SessionResolution> {
  const context = await resolveSession(request, dependencies);
  return context ? { context } : { body: sendUnauthorized(reply) };
}
