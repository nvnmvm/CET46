# CET46 1Panel / Docker 部署材料

这些文件只提供可复用的部署骨架，不包含数据库密码、会话密钥、证书或账号密码。

## 生产前提

- 先准备实际域名和可用 HTTPS 证书；`APP_ORIGIN` 必须是该 HTTPS 源地址。
- `COOKIE_SECURE=true` 只适用于 HTTPS。公网 IP 的 HTTP 临时联调不能算正式登录上线。
- MySQL 只加入 `cet46_private` 网络，不发布宿主机 3306。
- API 只绑定宿主机 `127.0.0.1:3000`，由 OpenResty 反代 `/api/`。

## 在服务器准备

将仓库中的 `deploy/`、`server/`、`database/` 和根目录 `package.json`、`pnpm-lock.yaml` 放到独立目录，例如 `/opt/cet46/`，然后：

```bash
cd /opt/cet46/deploy
cp .env.example .env
chmod 600 .env
# 在本机终端编辑 .env；不要把真实值粘贴到聊天或 GitHub
docker compose --env-file .env -f compose.yaml build api
docker compose --env-file .env -f compose.yaml up -d mysql
docker compose --env-file .env -f compose.yaml run --rm api node server/scripts/migrate.ts
docker compose --env-file .env -f compose.yaml run --rm api node server/scripts/migrate.ts
docker compose --env-file .env -f compose.yaml up -d api
```

第二次 migration 也必须成功。随后在服务器终端用隐藏输入创建账号：

```bash
docker compose --env-file .env -f compose.yaml run --rm api node server/scripts/create-user.ts --email <邮箱> --username <显示名称>
```

不要使用带密码参数的账号创建命令。

## 健康检查

```bash
curl -sS -i http://127.0.0.1:3000/api/health
curl -sS -i http://127.0.0.1:3000/api/ready
curl -sS -i http://127.0.0.1:3000/api/auth/me
```

预期分别是 200 JSON、数据库为 `up` 的 200 JSON、未携带 Cookie 时 401 JSON。

将 `openresty-api-location.conf` 放入 1Panel 站点的 `server {}`，备份原配置后执行 `nginx -t` 再 reload。API 错误不得回退到 `index.html`。

## 前端发布

本机执行 `pnpm build` 后，将 `dist/` 内容整体发布到站点根目录；不要只替换 `index.html`。发布前保留完整旧目录作为回滚副本，并核对首页引用的 JS/CSS 指纹。

## 数据库备份

把 `backup-mysql.sh` 放入服务器并赋予执行权限，使用 cron 每日运行：

```bash
chmod 700 /opt/cet46/deploy/backup-mysql.sh
15 3 * * * /opt/cet46/deploy/backup-mysql.sh >> /opt/cet46/deploy/backups/backup.log 2>&1
```

脚本会生成 7 天日备份和约 5 周的周备份，并对每个 gzip 做完整性检查。首次正式使用前，必须把一份备份恢复到临时数据库 `cet46_restore_test`，核对 `users`、`words`、`word_progress`、`learning_events` 数量及随机用户的进度字段，再删除临时库；不要在生产库上做恢复演练。
