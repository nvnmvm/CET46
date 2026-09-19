# Supabase 历史方案（已停用）

> 此文件夹已归档到 `project/archive/`，仅用于核对旧字段；不要执行其中 SQL。

2026-09-13 起，项目改为自有服务器 + 1Panel + 后端 API + MySQL。此目录仅保留未执行的旧设计以供核对字段，不含项目 URL、anon key 或任何用户数据。

不要按旧计划执行 `supabase db push`，也不要将 `migrations/20260907_initial_schema.sql` 导入 MySQL。它依赖 PostgreSQL 语法、Supabase Auth 和 RLS，不能直接复用。历史草案包含：

- `words`（含 `phonetic` IPA 音标字段）与 `word_progress` 表；
- 同用户词形唯一约束与进度唯一约束；
- 复习阶段、分数范围、最近一次四档调度结果，以及 `killed_at` / `last_restored_at` 斩词状态；
- 基于 `auth.uid()` 的 RLS policy；
- `word_progress.user_id` 与 `words.user_id` 一致的复合外键。

下一阶段应编写独立的 MySQL migration，并新增后端认证、权限校验和事务；旧表也未完整覆盖每日目标、草稿及完整复习历史。

当前 `.env.example` 已改为服务器 API / 后端配置占位，无需填写 Supabase 字段。后续 MySQL 凭据仅用于服务器后端，不写入前端变量或网站静态目录。最新架构和阶段验收见 [项目交接文档](../../docs/交接文档.md)。
