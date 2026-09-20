# 002：最小管理员账号管理（后端）

状态：后端本地实现已落地；真实 MySQL 迁移与部署待验证。本计划只覆盖后端与 MySQL 迁移，不包含 `app/**`、依赖、部署或生产数据操作。

## 目标与边界

- 管理员可以创建账号、禁用/启用账号、重置密码。
- 所有管理权限由服务端当前会话的 `users.role` 判断；前端隐藏入口不能替代授权。
- 管理员只看到账号元数据，不提供查看朋友词库、进度、事件或草稿的接口。
- 不开放公开注册、角色编辑、账号删除或生产账号自动提升。
- 禁用和密码重置必须撤销目标账号全部会话；普通资料更新不得改变角色或状态。
- 密码继续使用现有 Argon2id 策略，明文不写日志、数据库、URL、响应或审计记录。

## API 契约

所有路径均在 `/api` 下，JSON 严格校验；未登录返回 `401 unauthorized`，已登录但非管理员返回 `403 forbidden`。

### `GET /api/admin/me`

管理员返回：

```json
{"isAdmin":true}
```

非管理员返回 403；不泄露其他账号信息。

### `GET /api/admin/users?limit=50&offset=0`

仅管理员可用，返回：

```json
{"users":[{"id":"user_x","email":"a@example.com","username":"A","role":"learner","disabledAt":null,"createdAt":"..."}],"total":1,"limit":50,"offset":0}
```

不返回 `passwordHash`、学习数据、会话 token 或审计详情。

### `POST /api/admin/users`

请求体：`{email, username?, password}`。成功返回创建账号的元数据；重复邮箱返回 409 `email_exists`。

### `PATCH /api/admin/users/:id/status`

请求体：`{disabled:boolean}`。禁用时撤销全部会话；不能禁用自己或任何管理员。本版本不开放角色变更。

### `POST /api/admin/users/:id/password-reset`

请求体：`{password}`。成功更新 Argon2id 摘要、更新时间并撤销全部会话；不返回密码或摘要。

## 实施步骤

1. 新增 `database/migrations/003_admin_accounts_mysql.sql`：为 `users` 增加 `role`、`disabled_at`，新增不含密码/学习内容的 `admin_audit_logs`，保留 InnoDB、外键。正常完成后由 migration runner 记录并跳过；DDL 部分失败时不能盲目重跑原 SQL，必须核对实际结构和 schema_migrations 后恢复。
2. 扩展仓储契约、MySQL 实现与 fake repository：管理员列表、创建、状态切换、密码重置、全会话撤销和审计写入；相关状态变化使用事务。
3. 将禁用校验接入登录与会话解析；`publicUser` 不需要为本轮管理 API 扩展字段，管理员状态由独立 `/admin/me` 查询。
4. 新增严格 schema、Origin 校验与 admin routes，并在 `app.ts` 注册。写操作在同源 `Origin` 缺失或不匹配时拒绝；不信任任意 `X-Forwarded-For`。
5. 新增受控 `promote-user.ts --email` CLI，仅用于人工 bootstrap，不自动执行线上提升；不改普通 `create-user` 的角色边界。
6. 增加 fake/API 测试：401/403、普通用户绕过、创建重复、禁用/启用、重置密码撤销旧会话、自己/管理员禁用保护、Origin/严格请求体、审计无密码。
7. 增加真实 MySQL 集成测试覆盖迁移与约束；本地无 MySQL 时明确跳过，不能将 fake 测试写成真实库已验证。
8. 只更新 `database/README.md` 的迁移和权限说明；不部署、不操作真实用户。

## 验收

- A/B 用户：B 无法调用任一 admin endpoint；A 管理操作不改变 B 的词库/进度。
- 禁用账号的旧 Cookie 立即 401；重新启用后必须重新登录；密码重置后所有旧 Cookie 401。
- 重复邮箱稳定 409；密码策略与现有 CLI 一致；响应、日志和审计记录无明文密码/摘要。
- admin 列表只返回约定元数据，分页参数受限，未知字段返回 400。
- 写请求必须有精确匹配 `APP_ORIGIN` 的 Origin；错误均为 JSON。
- 真实 MySQL 迁移、复合外键、事务和会话撤销在集成环境通过后，才可单独宣称数据库验证完成。

## 未纳入本轮

提交幂等摘要、批量 SQL/N+1、云端 hydration、前端管理员页面、登录限流实现、备份恢复演练与部署权限收敛另列任务；本轮只记录边界，不混改。
