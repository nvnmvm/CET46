import process from "node:process";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";
import { createMysqlRepository } from "../src/repository.mysql.ts";
import { emailSchema } from "../src/schemas.ts";

/** 受控 bootstrap 命令：只提升已存在账号，不在 API 或前端开放角色编辑。 */

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

function parseEmail(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--email") {
    throw new Error("用法：node server/scripts/promote-user.ts --email someone@example.com");
  }
  const parsed = emailSchema.safeParse(argv[1]);
  if (!parsed.success) throw new Error("请提供合法邮箱地址。");
  return parsed.data;
}

async function main(): Promise<void> {
  loadEnvFiles();
  const email = parseEmail(process.argv.slice(2));
  const config = loadConfig(process.env);
  if (!config.database) throw new Error("缺少数据库连接信息。");
  const repository = createMysqlRepository(createPool(config.database, { connectionLimit: 1 }));
  try {
    const existing = await repository.findUserByEmail(email);
    if (!existing) throw new Error("账号不存在，请先用受控流程创建账号。");
    const promoted = await repository.promoteUserToAdmin(existing.id);
    if (!promoted) throw new Error("提升账号失败。");
    console.log(`已提升管理员账号 ${promoted.email}（id: ${promoted.id}）。`);
  } finally {
    await repository.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : String(error instanceof Error ? error.message : error));
  process.exit(1);
});

