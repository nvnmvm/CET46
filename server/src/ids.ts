import { randomBytes } from "node:crypto";

const ID_BYTES = 12;

/**
 * 服务端生成的稳定 ID。前缀用于区分实体，字符集为 [A-Za-z0-9_-]，与路由的 id 参数校验一致。
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(ID_BYTES).toString("base64url")}`;
}
