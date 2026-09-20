import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { SESSION_COOKIE_NAME } from "./config.ts";

/**
 * 密码与会话材料处理。
 *
 * - 密码只以 argon2id 摘要存储（m=19456 KiB, t=2, p=1，OWASP 推荐档位）。
 * - 会话 cookie 原文是 32 字节随机 token；数据库只存 token 的 sha256，泄露数据库也无法直接登录。
 * - Cookie 值带 SESSION_SECRET 的 HMAC 签名，篡改的 cookie 在查库前就被拒绝。
 * - token 原文只出现在 Set-Cookie 响应头，不写日志、不进 localStorage。
 */

export const PASSWORD_MIN_LENGTH = 8;

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符。`);
  }
  if (password.length > 200) {
    throw new Error("密码过长。");
  }
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // 摘要损坏或格式非法时按验证失败处理，不向调用方泄露细节。
    return false;
  }
}

let timingDummyHash: Promise<string> | null = null;

/**
 * 邮箱不存在时也执行一次同等成本的校验，避免通过响应时间枚举账号。
 */
export async function verifyPasswordOrDummy(
  hash: string | null,
  password: string,
): Promise<boolean> {
  if (hash) {
    return verifyPassword(hash, password);
  }
  timingDummyHash ??= argon2.hash("cet-session-timing-equalizer", ARGON2_OPTIONS);
  await verifyPassword(await timingDummyHash, password);
  return false;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function signSessionToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

export function formatCookieValue(token: string, secret: string): string {
  return `${token}.${signSessionToken(token, secret)}`;
}

/** 校验签名后返回原始 token；任何格式/签名问题都返回 null。 */
export function readSignedCookieValue(rawValue: string, secret: string): string | null {
  const separator = rawValue.indexOf(".");
  if (separator <= 0 || separator !== rawValue.lastIndexOf(".")) return null;
  const token = rawValue.slice(0, separator);
  const signature = rawValue.slice(separator + 1);
  const expected = signSessionToken(token, secret);
  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (provided.length !== computed.length) return null;
  return timingSafeEqual(provided, computed) ? token : null;
}

export type SessionCookieOptions = { secure: boolean; maxAgeSeconds: number };

export function buildSessionCookie(value: string, options: SessionCookieOptions): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function buildClearedSessionCookie(options: { secure: boolean }): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** 解析 Cookie 头；同名 cookie 取第一个，解不开的键值直接跳过。 */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
