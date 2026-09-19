import { z } from "zod";

/**
 * 环境变量校验。
 *
 * 约束：
 * - 只读取进程环境；报错信息只包含变量名，绝不包含变量值，避免把密码或密钥写进日志。
 * - 秘密（SESSION_SECRET / MYSQL_PASSWORD）不允许以 VITE_ 前缀出现，否则会被打进前端产物。
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const originPattern = /^https?:\/\/[^\s/]+$/;

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // 默认只接收本机流量。Docker 容器内可显式设为 0.0.0.0，但 Compose 不发布
  // 宿主机端口，只让共享私有网络中的 OpenResty 访问。
  API_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  APP_ORIGIN: z
    .string()
    .default("http://localhost:4173")
    .refine((value) => originPattern.test(value), {
      message: "必须是 http(s) 源地址，例如 http://localhost:4173",
    }),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  SESSION_SECRET: z.string().min(32, "至少需要 32 个字符"),
  MYSQL_HOST: z.string().optional(),
  MYSQL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  MYSQL_DATABASE: z.string().optional(),
  MYSQL_USER: z.string().optional(),
  MYSQL_PASSWORD: z.string().optional(),
  MYSQL_MIGRATION_USER: z.string().optional(),
  MYSQL_MIGRATION_PASSWORD: z.string().optional(),
});

export type DatabaseConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  apiPort: number;
  apiHost: "127.0.0.1" | "0.0.0.0";
  appOrigin: string;
  cookieSecure: boolean;
  sessionSecret: string;
  sessionTtlSeconds: number;
  /** 运行期账号；测试环境下允许为 null（由测试注入的 fake repository 承担数据访问）。 */
  database: DatabaseConfig | null;
  /** 迁移专用账号；只有显式提供 MYSQL_MIGRATION_* 时才存在。 */
  migrationDatabase: DatabaseConfig | null;
};

/** 会话 30 天；与 HttpOnly Cookie 的 Max-Age 保持一致。 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_COOKIE_NAME = "cet_session";

const nonEmpty = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(`配置无效：${details.join("；")}`);
  }
  const raw = parsed.data;
  const problems: string[] = [];

  for (const forbidden of ["VITE_SESSION_SECRET", "VITE_MYSQL_PASSWORD", "VITE_MYSQL_USER"]) {
    if (nonEmpty(env[forbidden])) {
      problems.push(`${forbidden} 不允许使用 VITE_ 前缀，秘密不能进入前端构建`);
    }
  }

  const isProduction = raw.NODE_ENV === "production";
  if (isProduction && raw.COOKIE_SECURE !== "true") {
    problems.push("生产环境必须设置 COOKIE_SECURE=true，会话 Cookie 才会带 Secure 标志");
  }

  const host = nonEmpty(raw.MYSQL_HOST);
  const database = nonEmpty(raw.MYSQL_DATABASE);
  const user = nonEmpty(raw.MYSQL_USER);
  const password = nonEmpty(raw.MYSQL_PASSWORD);
  const port = raw.MYSQL_PORT ?? 3306;

  let databaseConfig: DatabaseConfig | null = null;
  if (raw.NODE_ENV === "test") {
    databaseConfig =
      host && database && user && password ? { host, port, database, user, password } : null;
  } else {
    const missing = [
      !host ? "MYSQL_HOST" : null,
      !database ? "MYSQL_DATABASE" : null,
      !user ? "MYSQL_USER" : null,
      !password ? "MYSQL_PASSWORD" : null,
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) {
      problems.push(`缺少数据库配置：${missing.join("、")}`);
    } else if (host && database && user && password) {
      databaseConfig = { host, port, database, user, password };
    }
  }

  const migrationUser = nonEmpty(raw.MYSQL_MIGRATION_USER);
  const migrationPassword = nonEmpty(raw.MYSQL_MIGRATION_PASSWORD);
  const migrationDatabase =
    migrationUser && migrationPassword && host && database
      ? { host, port, database, user: migrationUser, password: migrationPassword }
      : null;

  if (problems.length > 0) {
    throw new ConfigError(`配置无效：${problems.join("；")}`);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    isProduction,
    apiPort: raw.API_PORT,
    apiHost: raw.API_HOST,
    appOrigin: raw.APP_ORIGIN,
    cookieSecure: raw.COOKIE_SECURE === "true",
    sessionSecret: raw.SESSION_SECRET,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    database: databaseConfig,
    migrationDatabase,
  };
}
