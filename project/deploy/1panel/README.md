# 1Panel / OpenResty 部署说明

这份说明记录 1Panel 静态站点和同源 API 反代的边界。它不会替代服务器上的凭据操作，也不会把尚未完成的生产联调写成已上线。

> 历史记录：`http://47.108.49.246/` 曾由 1Panel 管理的 OpenResty 提供静态站点。当前后端 API、MySQL、HTTPS 和双账号验收仍需在新服务器上完成；不能只上传新版前端来代替后端部署。

## 正式部署入口

对现有 1Panel OpenResty 容器，使用同级的 [`../docker/README.md`](../docker/README.md)：

1. Compose 启动 MySQL 和 API，API 加入 OpenResty 使用的外部 Docker 网络。
2. OpenResty 的 `/api/` 反代到 `cet-word-api:3000`，不使用容器内的 `127.0.0.1`。
3. 静态站根目录继续由 1Panel 管理；API 错误保留 JSON 状态码，不回退到 `index.html`。

不要把根目录 [`deploy/compose.yaml`](../../../deploy/compose.yaml) 与这里的 1Panel 容器网络方案混用；它是宿主机回环反代的备用 Compose。

## 生成发布目录

在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

将构建后的 `dist/` 目录中的全部内容上传到 1Panel 网站的静态目录。需要包含 `index.html`、`assets/`、`manifest.webmanifest`、`sw.js` 和图标文件。不要只上传根目录的 `index.html`，也不要上传 `.env`、数据库凭据或源码中的本地数据。

当前前端核心学习数据已经通过同源 API 访问服务器；但在 API、MySQL、HTTPS 尚未完成前，静态包不能单独提供登录、跨设备同步或生产持久化。

## 1Panel 操作顺序

1. 在 1Panel 创建网站，类型选择“静态网站”，绑定正式域名并配置 HTTPS。旧 IP 直连站点只能作为历史回退，不满足 Secure Cookie 的生产前提。
2. 将 `dist/` 内的文件上传到该网站的运行目录 `/opt/1panel/www/sites/cet-word-web/index`，确认 `index.html` 是默认文档。
3. 先访问首页、`#/import`、`#/review` 和 `#/words`，确认资源、哈希路由、移动端布局正常。
4. 在浏览器开发者工具的 Application/存储区域确认 Service Worker 已更新到 `cet-word-shell-v3`；清理旧站点缓存后再测一次。
5. 后续 API 服务准备好后，再按同域 `/api/` 反向代理示例配置代理。当前没有 API 服务，不能提前配置一个不存在的上游。

## 发布检查

- 静态站点只能看到构建产物，不应暴露 `.env.local`、MySQL 密码或后端会话密钥。
- `/api/` 的请求不能由静态站点回退成 `index.html`；未来应由 OpenResty 代理到后端并保留真实 4xx/5xx 状态。
- Service Worker 只缓存应用壳，不缓存 `/api`、登录、词库、复习和备份接口。
- 保存一份当前发布目录和构建时间，保留上一版以便静态回退；数据库回退必须单独处理。

## 历史静态发布记录（2026-09-19）

构建环境 Node 24.19.0：测试 22/22 通过，`tsc -b` 无报错，产物 8 个文件约 440 KB（zip 约 128 KB）。

发布包：项目根目录 `cet-word-static-20260919-0212.zip`，内容就是 `dist/`；已写入 `.gitignore`，不会随仓库提交。

实测确认：

- 路由是 hash 形式（`#/import`、`#/words`），服务器**不需要**配置 `try_files ... /index.html` 回退。
- 产物引用全部是根路径（`/assets/…`、`/manifest.webmanifest`、`/icon-192.png`），所以**必须部署在域名根路径**；要放子目录得先设置构建 `base` 再重新构建。
- 产物内没有 sourcemap、没有 `.env`、没有密钥字样，可以直接公开。
- Service Worker 只在 HTTPS 或 localhost 下注册，当前缓存名为 `cet-word-shell-v3`。

### 旧 1Panel 实际运行状态

- OpenResty 应用：`1.31.1.1-2-4-noble`，容器 `openresty`，状态 `Running`。
- 网站：`cet-word-web`，网站 ID `1`，状态 `Running`，绑定 `47.108.49.246:80`。
- OpenResty 配置：`/opt/1panel/www/conf.d/cet-word-web.conf`，已加入 `try_files $uri $uri/ /index.html` 和 hash 静态资源缓存规则。
- 旧 Docker nginx：容器 `cet-word-web` 已停止，旧发布目录 `/opt/cet-word-web/releases/20260919-0206` 保留作回退。
- 外网检查：`http://47.108.49.246/` 返回 200；不存在的静态资源返回 404；主 JS 可加载。

旧静态站上传后仍必须补的服务器侧设置：

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

后端实际迁移、双账号创建、Cookie 验收和数据库备份恢复演练，统一按照 [`../docker/README.md`](../docker/README.md) 执行。
