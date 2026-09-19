# 数据库（MySQL 8）第一批

## 执行迁移

```bash
corepack pnpm run db:migrate
```

`server/scripts/migrate.ts` 会：

1. 连接 `MYSQL_MIGRATION_USER` / `MYSQL_MIGRATION_PASSWORD`（未配置时回退到运行期账号）；
2. 建立 `schema_migrations` 表；
3. 按文件名升序执行 `database/migrations/*.sql`，每个文件只应用一次。

注意：MySQL 的 DDL 会隐式提交，迁移文件无法整体回滚；执行失败时先人工检查库内状态再重跑。
生产建议：运行期账号（`MYSQL_USER`）不授予建表/删库权限，迁移单独使用一个账号。

## 表与关键约束（001_initial_mysql.sql）

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `users` | 账号 | `UNIQUE(email)`（已小写规范化）；`password_hash` 只存 argon2id 摘要 |
| `auth_sessions` | 会话 | `UNIQUE(token_hash)`（sha256）；`KEY(user_id, expires_at)`；`FK → users(id)` |
| `words` | 词库 | `UNIQUE(user_id, normalized_word)`；`UNIQUE(user_id, id)` 供复合外键引用；`FK → users(id)` |
| `word_progress` | 学习进度 | `UNIQUE(user_id, word_id)`；复合外键 `(user_id, word_id) → words(user_id, id)`；`CHECK` review_stage 0—6、两个 score 0—5 |
| `learning_events` | 学习事件（趋势统计） | `KEY(user_id, occurred_at)`；复合外键同上；`CHECK` review_stage 0—6 |
| `user_settings` | 每日计划与倒计时 | 主键即 `user_id`；默认值与前端本地默认一致（target 20、groups 2、group words 10）；`CHECK` 0—100 / 1—20 / 1—20 |

公共约定：

- 引擎 `InnoDB`，字符集 `utf8mb4`（`utf8mb4_0900_ai_ci`）。
- 时间列一律 `DATETIME(3)`，由应用写入 UTC；不使用数据库侧 `NOW()`。
- 删除词条时 `word_progress` 与 `learning_events` 通过外键级联删除，与前端 `deleteWords` 的行为一致。
- `word_progress.version` 预留给后续乐观锁，本批不参与任何写入判断。

## 第二批 migration 与业务

`002_learning_workflow_mysql.sql` 新增：

- `review_drafts`：按 `(user_id, draft_key)` 唯一；保存版本、入口模式、范围、阶段和受服务端大小限制的 JSON payload；用户外键级联。
- `review_submissions`：按 `(user_id, submission_key)` 唯一；保存 `new` / `review` / `spelling` 的第一次结果，供重复提交幂等回放；用户外键级联。
- `user_settings.daily_plan_configured`：通过 `information_schema` 守卫增加，默认 0，用于忠实区分 localStore 的每日目标模式与“组数 × 每组词数”模式。

第二批服务端已实现设置、到期队列、拼写队列、学习事件、草稿和三类完成提交 API。完成提交在 MySQL 使用事务、行锁、`updated_at + next_review_at` 版本保护和唯一提交键；客户端不能指定最终 stage、score 或 nextReviewAt。

当前开发机没有 MySQL，因此本机没有运行真实 SQL 集成测试；`server/tests/learning.test.ts` 使用 fake repository 验证规则、幂等、冲突和回滚，不能替代 MySQL 集成测试。CI 已配置 MySQL 8.4 service：先执行 migration 两次，再由 `server/tests/mysql.integration.test.ts` 验证真实 SQL、约束、草稿 revision、三类提交和幂等。

尚未实现的更细粒度 `review_sessions` / `review_logs` / `import_batches` 不在本批范围内。

## 与历史 SQL 的关系

`project/archive/supabase/migrations/20260907_initial_schema.sql` 是 PostgreSQL/Supabase 草案，
**禁止执行、也不能改名后导入 MySQL**；它已被禁止改动，保留为历史参考。

## 尚未验证的部分

本开发机没有可用的测试 MySQL，因此本地没有运行真实 MySQL 集成测试；CI 配置了独立的 MySQL 8.4 service：

- 迁移 DDL 未在真实 MySQL 8 上执行过；
- SQL 语句、索引与 `CHECK` / 复合外键约束未在真实库上验证；
- CI 使用临时的 `cet_words_test` 数据库；本地可设置 `RUN_MYSQL_TESTS=1` 并提供 `MYSQL_*` 后运行 `corepack pnpm run db:migrate` 与 `corepack pnpm run test:mysql`。
