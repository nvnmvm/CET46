# CET 背词站后端（第一批垂直切片）

Node.js + TypeScript + Fastify + MySQL 8 的 API 服务。本批只交付可审查的后端切片：
前端仍走 `app/src/data/localStore.ts` 的 localStorage 版本，**未接入这个 API**。

## 目录

```text
server/
  src/
    app.ts                 # 可注入 config/repository 的 Fastify app 工厂
    main.ts                # 生产启动入口（默认监听 127.0.0.1）
    config.ts              # 环境变量校验，报错只含变量名
    db.ts                  # mysql2 连接池、事务、UTC 时间转换
    auth.ts                # argon2id 密码哈希、会话 token 哈希、Cookie 辅助
    schemas.ts             # zod 输入校验与规范化
    session.ts             # 从 HttpOnly Cookie 解析当前会话
    http.ts                # 统一 JSON 错误响应
    ids.ts                 # 服务端 ID 生成
    repository.ts          # 数据访问契约
    repository.mysql.ts    # MySQL 实现
    testing/fakeRepository.ts  # 无 MySQL 时的内存测试替身
    routes/health.ts       # /api/health、/api/ready
    routes/auth.ts         # /api/auth/*
    routes/words.ts        # /api/words/*
    routes/settings.ts     # /api/settings、/api/events
    routes/review.ts       # 到期/拼写/草稿/完成提交
    learningRules.ts       # 与 localStore 对齐的服务端纯规则
    serialize.ts           # 不回传 userId 的响应序列化
  scripts/migrate.ts       # 执行 database/migrations
  scripts/create-user.ts   # 管理员一次创建一个账号
  tests/*.test.ts          # node --test 直接运行，不需要 MySQL
```

## 环境变量

复制 `.env.example` 为 `server/.env`（已被 Git 忽略），填好 `MYSQL_*` 与 `SESSION_SECRET`。
`SESSION_SECRET` 至少 32 个字符；`COOKIE_SECURE=true` 在生产环境是强制的。
启动时会依次尝试加载 `server/.env`、`.env`，也可以显式使用 `node --env-file=server/.env ...`。

## 本地启动

```bash
corepack pnpm install                 # pnpm 不在 PATH 时用 corepack 调用，不要全局安装
corepack pnpm run typecheck:server
corepack pnpm run db:migrate          # 建表（需要可用的 MySQL 8）
corepack pnpm run user:create -- --email you@example.com
corepack pnpm run server:dev          # 默认监听 http://127.0.0.1:3000
```

首次创建的账号命令会交互式地隐藏输入密码；非交互环境改用 `--password-stdin`。
本批**没有**公开注册接口，`POST /api/register` 会返回 404。

## 测试

```bash
corepack pnpm run test:server     # fake repository；无 MySQL 也能运行
corepack pnpm run test:mysql      # 仅在 RUN_MYSQL_TESTS=1 且 MYSQL_* 可用时执行真实 SQL
corepack pnpm test                # 前端既有测试，保持不变
```

普通本地运行的 `test:server` 使用注入的内存替身（`server/src/testing/fakeRepository.ts`），
不连接任何数据库，用于验证认证、越权隔离、学习规则、幂等、冲突和回滚。
`server/tests/mysql.integration.test.ts` 是独立的真实 SQL 测试；没有 `RUN_MYSQL_TESTS=1` 时明确跳过。CI 会启动 MySQL 8.4 service，先运行两次 migration，再让 `test:server` 执行该集成测试。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 进程存活，`{ ok: true }`，不触碰数据库 |
| GET | `/api/ready` | 真实探测数据库；不可用返回 503 |
| POST | `/api/auth/login` | 邮箱 + 密码，成功下发 HttpOnly 会话 Cookie |
| POST | `/api/auth/logout` | 撤销当前会话并清 Cookie |
| GET | `/api/auth/me` | 当前用户，未登录 401 |
| GET | `/api/words` | 只返回会话用户的词条与进度，支持 `limit`(≤100)/`offset` |
| POST | `/api/words/import` | 接收 `WordInput[]`，服务端重新规范化并按用户合并 |
| PATCH | `/api/words/:id` | 只允许改 `phonetic` 与 `meaning` |
| DELETE | `/api/words/:id` | 只删除本人词条及其进度 |
| POST | `/api/words/:id/kill` / `restore` / `undo-kill` | 保持现有 kill/restore/undo 语义 |
| GET/PATCH | `/api/settings` | 当前会话用户的每日目标、组数、每组词数、时区、倒数日 |
| GET | `/api/events` | 当前用户的学习事件，分页窗口最多最近 5000 条 |
| GET | `/api/review/due` | 服务端按时区和每日计划计算，已学到期复习优先 |
| GET | `/api/spelling` | `daily` 当日新学词或 `library` 词库范围，均有限量 |
| GET/PUT/DELETE | `/api/review/draft` | 当前用户按 key 隔离，revision 冲突返回 409 |
| POST | `/api/study/new/complete` | 服务端计算新学进度并写 `new` event |
| POST | `/api/review/complete` | 服务端计算 grade/stage/score/日期并写 `review` event |
| POST | `/api/spelling/complete` | 只更新 spelling score/result，不推进 stage、不写 review event |

约定：

- 身份只来自同源 HttpOnly Cookie（`cet_session`）；请求体、查询串里的 `userId` 会被拒绝或不参与授权。
- 错误一律是 JSON：`{ "error": { "code": "...", "message": "..." } }`，不会回退到 SPA 的 `index.html`。
- 词条不存在与词条属于他人返回相同的 404，不泄露存在性。
- 响应不回传 `userId`，也不回传任何密码字段。
- 完成请求必须携带受限 `submissionKey`；同一用户同一 key 重试返回第一次结果，不重复计分。
- 完成请求只接受词条、答案和客户端看到的 `updatedAt` / `nextReviewAt` 版本；服务端不信任客户端 stage、score、最终日期或 userId。

## 会话与密码

- 密码：argon2id（m=19456 KiB, t=2, p=1），只存摘要。
- 会话：32 字节随机 token，数据库只存 sha256；Cookie 值附带 `SESSION_SECRET` 的 HMAC 签名，篡改的 Cookie 在查库前就被拒绝。
- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`、`Max-Age=30 天`，生产环境额外带 `Secure`。
- 日志：`main.ts` 对 `req.headers.cookie`、`res.headers["set-cookie"]`、`req.body.password` 做了 redact。

## 时间与字符集

- 所有时间列都是 `DATETIME(3)`，由应用层写入 UTC 字符串；代码里不使用 `NOW()` / `CURRENT_TIMESTAMP`。
- 连接固定 `utf8mb4`，库表也是 `utf8mb4` / InnoDB。
- `word_progress.user_id` + `word_id` 通过复合外键指向 `words(user_id, id)`，跨用户挂进度会被数据库直接拒绝。

## OpenResty 反向代理（部署占位，本批未在服务器执行）

线上静态站点仍是 `http://47.108.49.246/`。将来接入 API 时，在站点配置中加入同源 `/api` 反代，
并且**必须让 `/api/` 的错误回落到 JSON，而不是 SPA 的 `index.html`**：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Cookie $http_cookie;
    proxy_pass_request_body on;
    # 只有 API 自己返回的 JSON 才有意义；不要在 API 异常时回退到 index.html
    proxy_intercept_errors off;
}

# 兜底：/api 下未命中的路径也要返回 JSON，不能落到 SPA 路由
location = /api { return 404; }
```

注意：`API_HOST` 默认是 `127.0.0.1`，不要把 API 直接暴露到公网。Docker 内会显式
监听 `0.0.0.0`，但仅加入 OpenResty 所在的私有 Docker 网络、不发布宿主机端口；
HTTPS 与 Cookie 的 `Secure` 标志需要站点先具备可用证书。

## 第二批事务边界与测试边界

- MySQL 完成提交在一个事务内执行：读取/锁定进度、按版本条件更新、写学习事件、写幂等结果；中途失败由事务回滚。
- fake repository 使用 staged commit 模拟同样的整批原子性，并有失败注入测试；这不是 MySQL 集成测试。
- 草稿 payload 上限 64 KiB；完成批量最多 100 条；事件读取窗口最多最近 5000 条；所有动态数据值使用参数化查询。
- 本地验证没有 MySQL 测试库，未执行 migration 或真实 SQL 集成测试；不能据此宣称生产数据库或云同步完成。

## 本批明确没有做的事

- 前端未切换到远程 API（repository/localStore/TSV/复习算法/备份格式都没动）。
- 没有接入生产数据库，没有迁移任何真实用户数据，没有部署到 1Panel/服务器。
- 前端仍未切换到远程 API；`review_sessions` / `review_logs` / `import_batches` 等更细粒度业务留到后续批次。
