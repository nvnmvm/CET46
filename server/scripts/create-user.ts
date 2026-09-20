import process from "node:process";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";
import { createMysqlRepository } from "../src/repository.mysql.ts";
import { assertPasswordPolicy, hashPassword } from "../src/auth.ts";
import { newId } from "../src/ids.ts";
import { emailSchema } from "../src/schemas.ts";

/**
 * 一次性初始化账号命令（本批不提供公开注册）。
 *
 *   node server/scripts/create-user.ts --email someone@example.com [--username 学习者] [--password-stdin]
 *
 * 密码只从交互式（不回显）输入或标准输入读取，绝不作为命令行参数，避免进入 shell 历史。
 */

type Args = { email: string; username: string; passwordFromStdin: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { email: "", username: "", passwordFromStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--email") {
      args.email = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--username") {
      args.username = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--password-stdin") {
      args.passwordFromStdin = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/** 交互式隐藏输入：raw mode 下终端不回显，密码不会留在屏幕上。 */
async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("当前不是交互终端，请改用 --password-stdin 从标准输入读取密码。");
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("已取消。"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  loadEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const parsedEmail = emailSchema.safeParse(args.email);
  if (!parsedEmail.success) {
    throw new Error("请用 --email 提供合法邮箱地址。");
  }

  const config = loadConfig(process.env);
  if (!config.database) {
    throw new Error(
      "配置无效：缺少数据库连接信息（MYSQL_HOST / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD）。",
    );
  }

  const password = args.passwordFromStdin
    ? await readStdin()
    : await promptHidden(`请输入 ${parsedEmail.data} 的初始密码（不回显）：`);
  assertPasswordPolicy(password);

  const repository = createMysqlRepository(createPool(config.database, { connectionLimit: 1 }));
  try {
    const existing = await repository.findUserByEmail(parsedEmail.data);
    if (existing) {
      throw new Error(`账号已存在：${existing.email}`);
    }
    const created = await repository.createUser({
      id: newId("user"),
      email: parsedEmail.data,
      passwordHash: await hashPassword(password),
      username: args.username.trim() || null,
      timezone: "Asia/Shanghai",
    });
    console.log(`已创建账号 ${created.email}（id: ${created.id}）。`);
  } finally {
    await repository.close();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : String(error instanceof Error ? error.message : error));
  process.exit(1);
});
