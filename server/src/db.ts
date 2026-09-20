import mysql from "mysql2/promise";
import type { DatabaseConfig } from "./config.ts";

/**
 * mysql2 连接池与事务封装。
 *
 * 时间约定：所有时间列都是 DATETIME(3)，由应用层统一写入 UTC 字符串。
 * 连接层不依赖数据库服务器的 time_zone，也不使用 NOW() / CURRENT_TIMESTAMP 默认值。
 * charset 固定 utf8mb4，保证 4 字节字符（emoji 等）可以正常存储。
 */

export type MysqlPool = mysql.Pool;

/** 允许出现在参数化查询里的值类型。 */
export type SqlParameter = string | number | boolean | Date | null;

export function createPool(
  config: DatabaseConfig,
  options: { connectionLimit?: number } = {},
): MysqlPool {
  const connectionLimit = options.connectionLimit ?? 10;
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit,
    maxIdle: connectionLimit,
    queueLimit: 0,
    timezone: "Z",
    charset: "utf8mb4",
    supportBigNumbers: true,
    dateStrings: false,
  });
  return pool;
}

/** JS Date → MySQL DATETIME(3) 字面量（UTC，不含时区后缀）。 */
export function toMysqlUtc(date: Date): string {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

export function nowUtc(): string {
  return toMysqlUtc(new Date());
}

export function addSecondsIso(from: Date, seconds: number): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/** DB 返回的 DATETIME → ISO 字符串；无法解析时返回 null，不猜时间。 */
export function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function toIsoRequired(value: Date | string): string {
  const iso = toIsoOrNull(value);
  if (iso === null) throw new Error("数据库返回了无法解析的时间值。");
  return iso;
}

export async function withTransaction<T>(
  pool: MysqlPool,
  work: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // 回滚失败不能覆盖原始错误。
    }
    throw error;
  } finally {
    connection.release();
  }
}
