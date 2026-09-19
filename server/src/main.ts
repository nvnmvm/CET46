import { ConfigError, loadConfig } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { buildApp } from "./app.ts";
import { createMysqlRepository } from "./repository.mysql.ts";

/**
 * 生产启动入口。默认只监听回环地址；Docker 容器会显式设为 0.0.0.0，
 * 但它没有发布宿主机端口，只接受同一私有 Docker 网络中的 OpenResty 流量。
 */

function loadEnvFiles(): void {
  for (const candidate of ["server/.env", ".env"]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // 文件不存在时继续尝试下一个候选路径；都没有就只用进程环境。
    }
  }
}

function readConfig(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "配置读取失败。");
    return process.exit(1);
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = readConfig();
  if (!config.database) {
    console.error(
      "配置无效：缺少数据库连接信息（MYSQL_HOST / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD）。",
    );
    process.exit(1);
  }

  const repository = createMysqlRepository(createPool(config.database));
  const app = buildApp({
    config,
    repository,
    logger: {
      level: config.isProduction ? "info" : "debug",
      // 会话 Cookie 与密码绝不进日志。
      redact: {
        paths: ["req.headers.cookie", 'res.headers["set-cookie"]', "req.body.password"],
        censor: "[REDACTED]",
      },
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "收到退出信号，正在关闭");
    try {
      await app.close();
      await repository.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.apiHost, port: config.apiPort });
}

await main();
