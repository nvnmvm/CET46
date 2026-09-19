# 1Panel 静态站点部署准备

这份说明只覆盖当前阶段的静态前端。它不会创建数据库、API 服务或任何远程资源。

> 当前已完成 1Panel 静态站点部署：`http://47.108.49.246/`。站点由 1Panel 管理的 OpenResty 提供服务，正式域名、DNS 和 HTTPS 证书仍待后续配置。完整服务器记录见 [`project/docs/部署交接文档.md`](../../docs/部署交接文档.md) 的 2026-09-19 记录。

## 生成发布目录

在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

将构建后的 `dist/` 目录中的全部内容上传到 1Panel 网站的静态目录。需要包含 `index.html`、`assets/`、`manifest.webmanifest`、`sw.js` 和图标文件。不要只上传根目录的 `index.html`，也不要上传 `.env`、数据库凭据或源码中的本地数据。

当前版本仍使用浏览器 `localStorage`，只能作为本机试用版。上线静态包不会自动实现账号、跨设备同步或 MySQL 读写。

## 1Panel 操作顺序

1. 在 1Panel 创建网站，类型选择“静态网站”，绑定域名并配置 HTTPS。当前 IP 直连站点已经创建，代号为 `cet-word-web`。
2. 将 `dist/` 内的文件上传到该网站的运行目录 `/opt/1panel/www/sites/cet-word-web/index`，确认 `index.html` 是默认文档。
3. 先访问首页、`#/import`、`#/review` 和 `#/words`，确认资源、哈希路由、移动端布局正常。
4. 在浏览器开发者工具的 Application/存储区域确认 Service Worker 已更新到 `cet-word-shell-v3`；清理旧站点缓存后再测一次。
5. 后续 API 服务准备好后，再按同域 `/api/` 反向代理示例配置代理。当前没有 API 服务，不能提前配置一个不存在的上游。

## 发布检查

- 静态站点只能看到构建产物，不应暴露 `.env.local`、MySQL 密码或后端会话密钥。
- `/api/` 的请求不能由静态站点回退成 `index.html`；未来应由 OpenResty 代理到后端并保留真实 4xx/5xx 状态。
- Service Worker 只缓存应用壳，不缓存 `/api`、登录、词库、复习和备份接口。
- 保存一份当前发布目录和构建时间，保留上一版以便静态回退；数据库回退必须单独处理。

## 本次发布实测（2026-09-19）

构建环境 Node 24.19.0：测试 22/22 通过，`tsc -b` 无报错，产物 8 个文件约 440 KB（zip 约 128 KB）。

发布包：项目根目录 `cet-word-static-20260919-0212.zip`，内容就是 `dist/`；已写入 `.gitignore`，不会随仓库提交。

实测确认：

- 路由是 hash 形式（`#/import`、`#/words`），服务器**不需要**配置 `try_files ... /index.html` 回退。
- 产物引用全部是根路径（`/assets/…`、`/manifest.webmanifest`、`/icon-192.png`），所以**必须部署在域名根路径**；要放子目录得先设置构建 `base` 再重新构建。
- 产物内没有 sourcemap、没有 `.env`、没有密钥字样，可以直接公开。
- Service Worker 只在 HTTPS 或 localhost 下注册，当前缓存名为 `cet-word-shell-v3`。

### 1Panel 实际运行状态

- OpenResty 应用：`1.31.1.1-2-4-noble`，容器 `openresty`，状态 `Running`。
- 网站：`cet-word-web`，网站 ID `1`，状态 `Running`，绑定 `47.108.49.246:80`。
- OpenResty 配置：`/opt/1panel/www/conf.d/cet-word-web.conf`，已加入 `try_files $uri $uri/ /index.html` 和 hash 静态资源缓存规则。
- 旧 Docker nginx：容器 `cet-word-web` 已停止，旧发布目录 `/opt/cet-word-web/releases/20260919-0206` 保留作回退。
- 外网检查：`http://47.108.49.246/` 返回 200；不存在的静态资源返回 404；主 JS 可加载。

上传后必须补的服务器侧设置：

1. 网站根目录直接指向解压后的目录（不要把 `dist/` 这层目录名带进去），默认文档 `index.html`。
2. 给 `/sw.js` 设 `Cache-Control: no-cache`：否则 1Panel 或浏览器长缓存会让它更新不了，用户拿到的还是旧应用壳。
3. 给 `/index.html` 同样设 `no-cache`；`/assets/` 可以长缓存（文件名带 hash，不会冲突）。
4. 确认 `.webmanifest` 返回 `application/manifest+json`；OpenResty 默认 `mime.types` 有时识别不到，会导致“添加到主屏”信息缺失。
5. 先配好 HTTPS 证书再验收 PWA，HTTP 下没有 Service Worker。
6. 每次发布新版静态资源，先 bump `app/public/sw.js` 的 `CACHE` 版本号再构建。
7. 以后接入 API 时，`/api/` 要在代理里保留真实的 4xx/5xx，不要回退到 `index.html`。

验收顺序：首页 → `#/import` → `#/review` → `#/words` → 手机端布局 → DevTools Application 确认 Service Worker 已激活、Cache Storage 里是 `cet-word-shell-v3`；随后清一次站点数据，再走一遍导入和复习，确认刷新后进度仍在。

## 后端就绪后的反向代理

`openresty.conf.example` 只是一段需要按服务器实际路径和端口修改的 location 示例，不含可直接使用的域名、证书或凭据。不要把它直接粘贴到生产环境而跳过预发布验证。
