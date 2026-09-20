import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { ConfigError, loadConfig } from "../src/config.ts";
import { nowUtc } from "../src/db.ts";

/**
 * 独立 MySQL migration 执行器。
 *
 * - 只读取 database/migrations/*.sql，按文件名升序执行，每个文件用 schema_migrations 记录一次。
 * - 优先使用 MYSQL_MIGRATION_USER / MYSQL_MIGRATION_PASSWORD（单独账号），未提供时回退到运行期账号。
 * - 需要读多条语句，因此开启 multipleStatements：这里只执行仓库内受审查的 SQL 文件。
 * - MySQL 的 DDL 会隐式提交，迁移文件必须写成可安全重跑的形式；失败时先人工检查库内状态再重跑。
 */

const MIGRATIONS_DIR = path.join("database", "migrations");

function loadEnvFiles(): void {
  for (const candidate of ["server/.env", ".env"]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // 继续尝试下一个路径。
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig(process.env);
  const target = config.migrationDatabase ?? config.database;
  if (!target) {
    console.error(
      "配置无效：缺少数据库连接信息（MYSQL_HOST / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD）。",
    );
    process.exit(1);
  }

  const connection = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    multipleStatements: true,
    timezone: "Z",
  });

  try {
    await connection.query("SET time_zone = '+00:00'");
    await connection.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    VARCHAR(191) NOT NULL,
         applied_at DATETIME(3)  NOT NULL,
         PRIMARY KEY (version)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    );

    const [appliedRows] = await connection.query<(RowDataPacket & { version: string })[]>(
      "SELECT version FROM schema_migrations",
    );
    const applied = new Set(appliedRows.map((row) => row.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
    if (files.length === 0) {
      console.error(`没有找到迁移文件：${MIGRATIONS_DIR}`);
      process.exit(1);
    }

    let appliedCount = 0;
    for (const file of files) {
      const version = path.basename(file, ".sql");
      if (applied.has(version)) {
        console.log(`跳过（已应用）：${version}`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`应用迁移：${version}`);
      await connection.query(sql);
      await connection.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [version, nowUtc()],
      );
      appliedCount += 1;
    }
    console.log(`迁移结束：本次应用 ${appliedCount} 个文件，共 ${files.length} 个。`);
  } finally {
    await connection.end();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : "迁移失败，请查看上面的输出。");
  process.exit(1);
});
