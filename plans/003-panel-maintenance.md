# 003 — 1Panel 日常维护与 Node 运行环境迁移计划

- 状态：计划稿，未迁移、未切换、未修改线上服务
- 日期：2026-09-20
- 目标：让日常查看、重启、更新、备份和回滚尽量在 1Panel 中完成
- 边界：不要求消灭 Docker；当前 Docker 编排仍作为可回滚的旧 API 运行方式保留
- 当前线上测试入口：`http://151.246.186.93/`（HTTP-only；不能当作 HTTPS 生产登录验收）

## 1. 已核验基线

以下是主代理已实测或已提供的事实；旧交接文档中的其他服务器描述不覆盖这些事实。

| 对象 | 当前事实 | 迁移前处理 |
| --- | --- | --- |
| 1Panel | 2.3.1 | 以当前面板实际菜单为准；菜单文字不同处记录截图/路径后再写入最终手册 |
| 静态网站 | `http://151.246.186.93/` | 保持现有网站不动，先只迁移 API |
| 静态根目录 | `/opt/1panel/www/sites/151.246.186.93cet-word-web/index` | 不把 `dist/` 目录层嵌入根目录；发布时整包替换并保留回滚副本 |
| 静态根内容 | 9 个发布文件：`index.html`、`404.html`、`assets/` 下 JS/CSS、3 个图标、manifest、`sw.js` | 不手工移动、重命名或混用 hash 资源 |
| 应用源码 | `/opt/cet-word-stack` | 作为 Node 运行环境项目目录；先记录版本和工作树状态 |
| API 当前运行 | 编排管理的自建 API 镜像，宿主机回环 `127.0.0.1:3000` | 保留容器、镜像、配置和启动方法，直到新运行环境验收完成 |
| MySQL 当前运行 | 1Panel MySQL 对**宿主机**发布 `127.0.0.1:3306` | 不迁移数据目录、不改卷、不执行 `down -v`；这不表示 Node 容器内可用同一个地址 |
| MySQL 数据目录 | `/opt/1panel/apps/mysql/mysql/data`（既有看板记录） | 仅记录和备份；不要为了目录整齐搬到项目目录 |
| Node 运行环境 | 1Panel 网站 → 运行环境 → Node.js 支持 24.15.0/24.x；当前列表为空 | 新建一个隔离运行环境，先使用备用回环端口 |
| OpenResty | 主机网络 | 当前 API 反代按宿主机 `127.0.0.1:3000` 处理；不要套用旧的容器共享网络 `cet-word-api:3000` 指南 |
| 线上源代码 | `/opt/cet-word-stack`，commit `b3f74ef`，工作树干净 | 迁移前再次记录；不能用本地 `main` 证明线上一致 |
| 本地 Git | `main` 无历史提交且 dirty | 不 reset/clean；先做版本清单，迁移只使用已经核对的候选版本 |
| 源码一致性 | 7 个 SHA-256 只证明改动前基线曾与线上一致 | 不能据此证明当前本地候选仍与线上一致；选择候选版本后必须重新逐项比对 |

### 1.1 当前状态的明确边界

- 当前站点是 HTTP 测试环境。HTTPS、域名、证书、HSTS、`COOKIE_SECURE=true` 尚未作为已完成事项记录。
- 当前 API 和 MySQL 的 `127.0.0.1` 均指宿主机发布地址；Node 运行环境若在 bridge 容器内，容器自己的 `127.0.0.1` 不是宿主机，也不是 MySQL 容器。必须选择共享私网 + 实际 MySQL 容器 DNS，或先验证 Node 运行环境使用 host 网络。
- 现有 API 与 Node 运行环境迁移都不需要搬迁 MySQL 数据。数据迁移、数据库卷迁移和重建 MySQL 不在本计划范围内。
- 旧 `project/deploy/docker/` 文档描述的外部 Docker 网络是另一种部署模型，不能覆盖本机当前“OpenResty host network + API 宿主机回环发布”的事实；迁移时仍要为 Node 与 MySQL 选择实际可达的网络路径。
- 本计划每个“待验收”项都必须在当前 1Panel 页面或直接回环检查中得到证据后，才能改成已完成。

## 2. 目录与维护归属决策

不现在移动或删除资产，只规定后续新增和发布时的归属。

| 类别 | 目标位置 | 维护方式 | 禁止事项 |
| --- | --- | --- | --- |
| 前端源码 | `/opt/cet-word-stack/app/` | Git 版本和本地构建 | 不把源码上传到静态网站根目录 |
| 前端构建配置 | `/opt/cet-word-stack/project/tooling/` | 随源码版本维护 | 不在 1Panel 网站配置里手改 hash 文件 |
| 后端源码 | `/opt/cet-word-stack/server/` | 1Panel Node 运行环境启动 | 不把 API 源码放入网站公开根目录 |
| MySQL migrations | `/opt/cet-word-stack/database/migrations/` | 仅维护操作执行；运行账号不承担 DDL | 不直接在生产库手工改表后假装有版本记录 |
| 后端秘密 | `/opt/cet-word-stack/server/.env`（`0600`）或 1Panel 环境变量字段二选一 | 只供 API 进程读取 | 不放 `app/public`、`dist`、网站根目录、Git、聊天或命令行值中 |
| 静态发布 | `/opt/1panel/www/sites/151.246.186.93cet-word-web/index/` | 1Panel 网站文件/发布目录 | 不只替换 `index.html`，不混用两次构建的 `assets/` |
| 发布回滚副本 | 网站根目录之外的版本目录（具体根路径待验收） | 只保留完整发布包 | 不把备份包放入可公开访问的 `/index` |
| API 日志 | 1Panel Node 运行环境日志或约定的日志目录 | 面板查看、轮转 | 不打印密码、Cookie、Session secret、环境文件完整内容 |
| MySQL 数据 | 1Panel 既有数据目录/卷 | 只由 MySQL 管理 | 不为“整齐”移动 `/opt/1panel/apps/mysql/mysql/data` |
| 数据库备份 | 1Panel 备份目标或 `/opt/cet-word-stack/backups/` 外置目录 | 每日 7 份、每周 4 份 | 不放网站根目录；不以静态包备份代替数据库备份 |
| 计划和证据 | 仓库 `plans/` | 记录目标、证据、未测项 | 不把计划文件当成线上已完成证明 |

### 2.1 静态文件分类规则

`index.html`、`404.html`、`manifest.webmanifest`、`sw.js`、图标和 `assets/` 必须作为同一次构建的完整发布集合。JS/CSS 的 hash 文件名由构建产生，禁止人工改名或把 `assets` 拆成手工维护的 JS/CSS 两套目录。需要回滚时切换完整版本目录，而不是逐个文件复制。

根目录的单文件设计稿或独立 HTML 不自动并入 `app/public/`，除非明确确认它是当前 Vite 应用的发布资源；否则作为设计/历史参考处理，避免被误上传到生产网站。

## 3. 迁移策略：先并行验证，再短暂切换

### 3.1 保留的旧路径

迁移前和迁移后均保留：

1. 当前 API 编排服务、镜像、配置和可启动命令；
2. 当前 MySQL 容器/应用、卷和数据目录；
3. 当前网站完整发布内容和至少一个旧版本副本；
4. 迁移前的 `server/.env` 或面板环境变量记录（秘密本身不写进本计划）；
5. 迁移前后的健康检查、版本指纹和备份证据。

不得为了验证 Node 运行环境而停止 MySQL、删除卷、删除旧 API 容器或覆盖当前网站根目录。

### 3.2 网络模式和备用端口

必须先确认 1Panel Node 运行环境的网络模式，再决定环境变量。宿主机发布 `127.0.0.1:3306` 不是容器内连接地址，Node 容器不得直接把 `MYSQL_HOST` 写成 `127.0.0.1`。

| Node 运行方式 | API 进程监听 | 宿主机发布/检查 | `MYSQL_HOST` 选择 |
| --- | --- | --- | --- |
| host 网络（仅在面板明确显示并实测） | `API_HOST=127.0.0.1`、`API_PORT=3001` | 直接使用宿主机 `127.0.0.1:3001` | `127.0.0.1`，因为进程与 MySQL 发布端口在同一宿主机网络命名空间 |
| bridge 容器（默认候选） | 容器内通常 `API_HOST=0.0.0.0`、容器端口例如 `3000` | 端口映射必须是宿主机 `127.0.0.1:3001` → 容器监听端口；宿主机和 OpenResty 只访问 `127.0.0.1:3001` | Node 容器必须加入 MySQL 所在共享私网，并使用 `docker inspect` 取得的真实 MySQL 容器 DNS/网络别名；不得使用容器内 `127.0.0.1` |

bridge 模式下若 MySQL 没有可供 Node 加入的共享私网，不能猜测服务名、使用公网地址或以宿主机回环代替；应暂停迁移，改为经过验证的 host 网络或先完成受控私网连接。API 的“宿主机只回环”与“容器内监听 `0.0.0.0`”可以同时成立，前者由端口映射限制。

bridge 模式的网络核对只能使用服务器上的实际结果，例如先读取当前 MySQL 容器的网络和别名，再决定 `MYSQL_HOST`：

```bash
docker inspect <实际MySQL容器名> --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{range $alias := .Aliases}}{{$alias}} {{end}}{{"\n"}}{{end}}'
docker network inspect <已确认的共享网络名>
```

`<实际MySQL容器名>`、网络名和别名必须来自当前服务器检查，不能从旧文档或示例中臆造；若 Node 运行环境不能加入该网络，就不要继续使用 bridge + 容器 DNS 的方案。

推荐先使用宿主机备用端口 `127.0.0.1:3001`。host 网络直接监听 `127.0.0.1:3001`；bridge 模式则让容器监听内部端口，并只把宿主机 `127.0.0.1:3001` 映射给它。无论哪种模式，`3001` 都不能绑定宿主机 `0.0.0.0`，也不能在安全组或 OpenResty 之外公开。验证阶段直接在服务器终端检查：

```bash
curl -sS -i http://127.0.0.1:3001/api/health
curl -sS -i http://127.0.0.1:3001/api/ready
curl -sS -i http://127.0.0.1:3001/api/auth/me
```

预期状态为 `200`、数据库为 `up` 的 `200`、未带 Cookie 的 `401`。这些是 HTTP/回环检查，不代表 HTTPS 或正式登录已完成。

### 3.3 切换时机

只有备用端口通过依赖、Argon2、配置、数据库和 API 检查后，才安排短暂切换：

1. 记录旧 API 的进程/容器状态和 `3000` 健康响应。
2. Node 运行环境先保持在已验证的 `3001`，不要为迁移强行改到 `3000`。
3. 备份当前 OpenResty 站点配置；在 1Panel 网站自定义配置中，将 API 上游从宿主机 `127.0.0.1:3000` 改为 `127.0.0.1:3001`，先执行配置检查再 reload。若 Node 是 bridge，OpenResty 仍访问宿主机端口映射，不直接访问容器内地址。
4. 通过公开站点检查同源 `/api/health`、`/api/ready` 和 `/api/auth/me`；错误必须仍是 JSON 和真实状态码。
5. 观察一个完整健康检查周期和登录/退出流程后，才决定是否停止旧 API；不停止旧 API 也可以把 `3001` 作为长期面板运行端口。
6. 静态网站不随 API 切换而重新上传；只有构建指纹和 API 验收均确认后，才安排独立的静态发布。

## 4. 1Panel Node 运行环境迁移步骤

以下是目标点击路径。页面字段名称可能随 1Panel 版本/语言包略有差异；遇到差异时只记录实际名称，不猜测已完成。

### 阶段 A：只读盘点和备份门禁

1. 登录 1Panel，进入“网站”并打开 `151.246.186.93cet-word-web`，记录网站运行目录、当前配置备份入口、访问日志/错误日志入口。
2. 进入“网站 → 运行环境 → Node.js”，确认可选的 Node 24.15.0（或实际 24.x）运行时、项目目录、自定义启动命令、包管理器、环境变量、挂载和端口字段。当前运行环境列表为空，不能写成已存在环境。
3. 进入“应用/数据库 → MySQL”对应的当前实例详情（具体左侧菜单名称待验收），记录实例名、运行状态、宿主机发布端口和备份入口。不要打开或复制密码字段。
4. 在服务器终端只读记录：

   ```bash
   cd /opt/cet-word-stack
   git rev-parse HEAD
   git status --short --branch
   node --version
   corepack pnpm --version
   sha256sum package.json pnpm-lock.yaml server/src/main.ts server/src/config.ts
   ```

5. 对线上源码与冻结后的本地候选版本生成不含秘密的文件清单/哈希清单。线上 `b3f74ef` 和改动前的 7 个 hash 只能作为历史基线，不得把它写成当前候选或全仓库一致。
6. 在 1Panel 备份 MySQL；若面板支持保留策略，设定“每日 7 份、每周 4 份”。实际字段、时区、保存目标和执行时间截图/记录为“待验收”。
7. 迁移门禁：备份成功、备份文件可见且不在网站根目录；若没有成功证据，停止迁移，不创建 Node 运行环境。

### 阶段 B：准备 Node 24 运行环境

1. 进入“网站 → 运行环境 → Node.js → 创建/添加运行环境”（实际按钮名待验收）。
2. 选择 Node `24.15.0` 或面板当前明确提供的 Node 24.x；记录精确版本，不只写“Node 24”。
3. 项目目录填写 `/opt/cet-word-stack`。
4. 包管理器选择面板实际支持且与 `pnpm-lock.yaml` 对应的 pnpm；安装必须等价于：

   ```bash
   corepack pnpm install --frozen-lockfile --prod
   ```

   不使用会重新解析 `latest` 依赖的普通 `pnpm install`，不在生产机器临时升级 lockfile。

5. 自定义启动命令先使用备用端口，并显式指定环境文件路径：

   ```bash
   node --env-file=/opt/cet-word-stack/server/.env server/src/main.ts
   ```

   若面板要求填写启动文件、启动参数和工作目录，则分别填写 `server/src/main.ts`、`--env-file=/opt/cet-word-stack/server/.env`、`/opt/cet-word-stack`，并在最终保存前确认实际拼接命令。

6. 当前 `server/src/config.ts` 只读取 `process.env`；它不会自行读取文件。`server/src/main.ts` 会按当前工作目录尝试 `server/.env`、`.env`，这仍依赖工作目录和 Node 版本。为了避免面板工作目录变化导致丢配置，生产运行环境应使用面板环境变量字段或绝对路径 `--env-file`，不要只依赖相对路径自动加载。
7. 运行环境环境变量字段或秘密文件二选一：

   - 面板字段：逐项录入 `NODE_ENV`、`API_HOST`、`API_PORT`、`APP_ORIGIN`、`COOKIE_SECURE`、`SESSION_SECRET`、`MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`，使用面板的隐藏/密码输入能力；
   - 秘密文件：服务器上创建 `/opt/cet-word-stack/server/.env`，权限 `0600`，启动命令只引用路径，不把值写进命令参数。

   两种方式不要同时填入冲突值。面板截图、日志、工单和聊天中不显示秘密值；计划只保留变量名和校验结果。
8. 先根据 3.2 节确认网络模式，再注入备用实例：host 网络才可使用 `API_HOST=127.0.0.1` 与 `MYSQL_HOST=127.0.0.1`；bridge 模式通常使用 `API_HOST=0.0.0.0`、容器端口 `3000` 和真实 MySQL 容器 DNS，宿主机只映射 `127.0.0.1:3001`。不要把容器内 loopback 当作宿主机地址，也不要先把宿主机端口绑定到所有网卡。

### 阶段 C：Node/Argon2/数据库兼容性验证

Node 24.15.0 可直接运行当前仓库 TypeScript 入口是候选能力，不是已验收事实。验证必须在目标 1Panel Node 运行环境内完成。

1. 记录 `node --version`、`node -p "process.platform + ' ' + process.arch"` 和实际运行时镜像/系统信息（面板能显示的范围内）。
2. 验证依赖安装严格使用 lockfile；不能因为安装失败而删掉 `node_modules`、重写 lockfile 或切换到未记录的 Node 版本。
3. 验证 Argon2 原生模块，不输出 hash：

   ```bash
   node --input-type=module -e "import argon2 from 'argon2'; const hash = await argon2.hash('panel-argon2-probe'); if (!(await argon2.verify(hash, 'panel-argon2-probe'))) process.exit(1); console.log('argon2-ok')"
   ```

4. 检查 native binary 的动态库可用性。只输出文件类型和缺失库结果，不输出环境文件：

   ```bash
   find node_modules/argon2 -type f -name '*.node' -print -exec file {} \;
   find node_modules/argon2 -type f -name '*.node' -print -exec ldd {} \;
   ```

5. 如果运行时是 musl/Alpine，而当前依赖或现有镜像要求 glibc，先停止迁移。选择与 1Panel runtime libc 兼容的 Node 24 运行时，或在该运行时按锁定版本重新构建并验证 native module；不能以“Node 版本相同”替代 libc/架构验证。
6. 直接访问备用 API：`/api/health`、`/api/ready`、`/api/auth/me`。确认日志没有密码、Cookie、Session secret 或完整环境变量。
7. 只有 `argon2-ok`、动态库无 `not found`、数据库 ready、API 错误 JSON 和回环端口限制全部有证据，才进入切换阶段。

### 阶段 D：回环 API 验证

1. 先不改 OpenResty；让旧 API 继续服务 `3000`，新 Node API 只服务 `3001`。
2. 使用面板“运行环境 → Node.js → 日志/重启”检查启动日志，确认工作目录、启动命令和端口；不要点击“删除环境”。
3. 用服务器终端完成三条健康检查和一次无 Cookie 的 `auth/me` 检查；保存状态码和响应头，不保存 Cookie 值。
4. 使用测试账号在临时验证范围内登录/退出和读取空或已授权数据；HTTP 环境只能记录“功能测试”，不能记录“生产登录完成”。
5. 检查 MySQL 仍由原 1Panel 实例提供，数据行数没有被迁移脚本意外改变。没有计划中的 schema 变化时不重复执行生产 migration。
6. 如果需要执行 migration，先备份；通过独立维护命令执行两次并核对 `schema_migrations`，运行账号不应依赖 DDL 权限。迁移失败时先停在数据库检查，不删除卷、不重建库。

### 阶段 E：推荐切换 OpenResty 上游到 3001

1. 在 1Panel 保存旧 API 状态、旧镜像/容器名、旧启动命令、旧环境变量来源和健康检查结果。
2. 确认当前 OpenResty 配置的 API 上游仍是宿主机 `127.0.0.1:3000`。不把旧文档中的 `cet-word-api:3000` 或容器内 loopback 套到当前 host-network 站点。
3. 让 Node 运行环境继续监听/发布已验证的宿主机 `127.0.0.1:3001`；bridge 模式下确认容器内部监听 `0.0.0.0` 且只有宿主机回环映射。
4. 备份站点配置，在 1Panel 自定义 OpenResty 配置中把上游改成 `127.0.0.1:3001`，执行 `nginx -t`（或面板等价配置检查）后 reload。不要直接改线上文件而跳过检查。
5. 通过网站公开入口检查：

   ```bash
   curl -sS -i http://151.246.186.93/api/health
   curl -sS -i http://151.246.186.93/api/ready
   curl -sS -i http://151.246.186.93/api/auth/me
   ```

   HTTP 返回只能作为当前联调证据；`COOKIE_SECURE=false`/无 HTTPS 时不能签收正式生产认证。
6. 检查 OpenResty access/error 日志和 Node 运行日志；确认 `/api/` 没有回退成 `index.html`，JSON 状态码没有被改成 200 HTML。
7. 切换后至少观察一个完整的健康检查周期和一轮登录/退出/读取流程。验收通过后可让 Node 继续使用 `3001`，不要求为了“统一端口”再切回 `3000`；旧 API 继续保留一段观察期。

如果后续确有端口统一需求，可在独立维护窗口把 Node 宿主机发布端口从 `3001` 改为 `3000`，但这不是本迁移的放行条件，也不能牺牲回滚路径。

### 阶段 F：失败回滚

任何一项失败均按以下顺序回滚：

1. 在 1Panel 自定义 OpenResty 配置中把上游恢复为宿主机 `127.0.0.1:3000`，执行配置检查后 reload。
2. 停止或隔离 Node `3001` 运行环境；若它是 bridge，先撤掉宿主机回环端口映射，不能只改容器内监听地址。
3. 启动原 API 容器/编排服务，恢复原来的 `127.0.0.1:3000`，检查回环 `/api/health`、`/api/ready`，再检查公开 `/api/health`。
4. 若静态文件也在同一发布窗口变更，恢复上一份完整网站版本，不从新旧版本混拷 `index.html` 和 `assets/`。
5. MySQL 不因 API 回滚而恢复、删除或移动；只有数据库变更造成数据风险时，才由单独的恢复演练流程处理。
6. 记录失败点（Node 版本、网络模式、启动命令、端口映射、依赖、Argon2、环境来源、数据库状态、日志摘要），不要把秘密值放进记录。

## 5. 日常 1Panel 维护手册（迁移完成后）

### 5.1 查看状态

1. 网站：进入 `网站 → 151.246.186.93cet-word-web`，查看网站运行状态、运行目录、访问日志和错误日志。
2. API：进入 `网站 → 运行环境 → Node.js → CET API`（名称为实际创建名），查看运行状态、启动命令、端口和日志。
3. 数据库：进入当前 MySQL 实例，查看运行状态和宿主机 `127.0.0.1:3306` 发布；若 API 在 bridge 容器内，另查共享私网和真实 MySQL DNS，不要把容器内 `127.0.0.1` 当成数据库地址；不要把数据库端口改成公网监听。
4. 服务器终端只做回环检查，不在面板输入框或命令行回显秘密。

### 5.2 重启 API

1. 先查看 Node 日志最后一段，确认是否是配置错误、端口占用、数据库连接或 Argon2 加载失败。
2. 点击 Node 运行环境“重启”；不要先重启 MySQL，也不要删除运行环境。
3. 等待运行状态为运行中后，依次检查回环 `health`、`ready`、`auth/me` 和公开 `health`。
4. 若失败，按第 4.6 节启动旧 API 回滚；不能连续反复重启掩盖故障。

### 5.3 发布后端版本

1. 先在本地确认源码版本、lockfile、测试、类型检查和构建指纹；当前本地 `main` 无提交，不能用本地分支名代替版本号。
2. 将候选版本放入 `/opt/cet-word-stack` 的受控目录；不覆盖生产秘密文件，不覆盖 MySQL 目录。
3. 依赖安装使用 `--frozen-lockfile`；Argon2 兼容性验证必须在目标 Node 24 运行环境重复一次。
4. 如有 migration，先做数据库备份和临时库演练，再在维护窗口执行；没有 migration 不运行迁移脚本。
5. 先用 `3001` 启动验证，再按第 4.5 节切换 OpenResty 上游到 `3001`；不要求 Node 再占用 `3000`。
6. 发布记录写明源码 commit/文件哈希、Node/pnpm 版本、迁移版本、备份编号、健康检查和回滚命令。

### 5.4 发布前端静态包

1. 在本地执行构建，得到完整 `dist/`；不要将 `dist/` 内的 hash 资源拆出重命名。
2. 在网站根目录之外保留上一版完整副本；具体版本目录路径由当前 1Panel 文件管理器/挂载情况确认后填写。
3. 进入网站文件管理器或使用已批准的文件传输方式，将 `dist/` 的**内容**上传到：

   ```text
   /opt/1panel/www/sites/151.246.186.93cet-word-web/index/
   ```

4. 确认根目录直接有 `index.html`、`assets/`、manifest、`sw.js` 和图标，不出现 `index/dist/index.html`。
5. 发布后先请求首页和本次 `index.html` 引用的 JS/CSS 指纹，再验证 `404.html`、manifest、SW。不要只看首页 200。
6. 发生资源混用或缓存问题时恢复上一版完整发布目录；不要单独替换某个 hash 文件。

### 5.5 账号维护

账号创建、密码重置和禁用属于后端管理任务，不在静态网站文件管理器中完成。任何账号命令必须使用隐藏输入/面板安全终端，不能把密码写进命令参数、日志、工单或计划文件。管理员和普通账号权限隔离、真实双账号验收仍是后续任务，不因 Node 运行环境迁移自动完成。

## 6. 备份、保留与恢复演练

### 6.1 保留策略

- 每日备份保留 7 个恢复点。
- 每周备份保留 4 个恢复点。
- 备份存储必须在网站根目录之外；优先使用 1Panel 数据库备份目标，具体目标路径和权限待面板验收。
- 每次备份记录时间、数据库实例、schema 版本、文件大小和完整性结果，不记录密码。
- 静态发布包、源码压缩包和数据库备份分开管理；一个不能替代另一个。

### 6.2 临时库恢复演练

1. 选择一份已完成 gzip/文件完整性检查的备份，不覆盖生产库。
2. 在同一 MySQL 实例创建隔离临时库，例如 `cet_words_restore_test`；创建动作需由有明确授权的维护窗口执行。
3. 将备份恢复到临时库，核对 `schema_migrations` 和当前实际表集合。
4. 比较至少这些表的行数：`users`、`words`、`word_progress`、`learning_events`、`review_drafts`、`review_submissions`、`user_settings`、`auth_sessions`。
5. 抽样检查用户隔离、词条/进度复合关联、草稿 revision、提交幂等记录和时间字段；不把抽样个人数据写入计划或聊天。
6. 用只读方式验证临时库可连接、迁移版本正确、关键约束存在；不让 API 指向临时库。
7. 记录恢复耗时、备份编号、行数结果和失败项；确认记录后再删除临时库。删除临时库前必须有明确维护授权，不能把恢复演练变成生产删除。
8. 若恢复失败，保留备份和临时库供调查，不删除生产库、不改生产卷。

### 6.3 面板点击路径待验收项

以下菜单因本次仅有基线事实、未执行面板操作，暂不能写成已确认：

- MySQL 备份入口的准确菜单名称。
- 备份计划任务中“日 7 / 周 4”的具体字段和轮换实现。
- 备份文件存储目标、访问权限和下载/恢复按钮。
- Node 运行环境日志导出、环境变量隐藏显示和运行时 libc 信息入口。
- 网站版本目录/原子切换能力。

## 7. 环境变量、秘密与安全门禁

1. `SESSION_SECRET` 至少 32 个字符；`MYSQL_PASSWORD`、迁移账号密码和任何管理密码只放面板隐藏字段或 `server/.env`，权限 `0600`。
2. 不使用 `VITE_` 前缀承载后端秘密；不能让秘密进入前端构建产物。
3. `NODE_ENV=production`、正式域名 HTTPS 和 `COOKIE_SECURE=true` 必须一起放行；当前 HTTP IP 阶段只做联调，不把 Secure Cookie 登录标记为完成。
4. `APP_ORIGIN` 必须等正式 HTTPS origin 确定后再设置；不要使用当前公网 IP 的 HTTP 作为生产 origin。
5. 面板日志、截图、导出配置、终端历史和本计划均不得出现环境文件正文、密码、Cookie 或 Session secret。
6. `--env-file` 只在启动命令中引用文件路径；它不会让 `config.ts` 自动读取文件。启动工作目录、绝对路径和进程环境必须在 Node 运行环境中逐项验证。
7. 当前 MySQL 对宿主机只发布 `127.0.0.1:3306`；bridge Node 必须走共享私网和真实 MySQL DNS，host Node 才能使用宿主机回环。任何模式都不要为了“方便连接”开放 3306 到公网。

## 8. 版本一致性与最终放行条件

### 8.1 版本清单

迁移/发布前记录以下不含秘密的清单：

- 线上 `/opt/cet-word-stack` commit 和工作树状态；
- 本地候选源码 commit/受控 release hash（当前本地无历史提交时不能使用 `main` 名称代替版本）；
- `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 的 SHA-256；
- `server/`、`database/migrations/`、`project/tooling/` 的文件清单和关键文件 hash；
- `dist/index.html` 引用的 JS/CSS 指纹；
- Node、pnpm、argon2 native binary 的平台/架构信息；
- 当前数据库 `schema_migrations` 版本；
- 备份编号和恢复演练结果。

线上 commit `b3f74ef` 与本地无提交 `main` 不可直接比较为“已同步”。7 个 hash 只是改动前基线，不能证明当前候选仍与线上一致；迁移前必须先冻结候选版本，再重新比对全部部署输入。

### 8.2 放行清单

- [ ] 旧 API 容器、镜像、配置、MySQL 数据和网站上一版仍可回滚。
- [ ] Node 24.15.0 运行环境已创建，但未误绑定公网地址。
- [ ] 工作目录、显式 `--env-file`/面板环境变量和端口在运行日志中可确认。
- [ ] pnpm frozen install 成功，没有重写 lockfile。
- [ ] Argon2 hash/verify 成功，native binary 的 `ldd` 无 `not found`，平台/架构一致。
- [ ] Node API 在 `127.0.0.1:3001` 通过 health/ready/auth-me 检查。
- [ ] MySQL 仍为原实例、原数据目录/卷，未移动、未重建、未清空。
- [ ] 备份已成功生成，日 7/周 4 策略和存储目标有面板证据。
- [ ] 临时库恢复演练完成并记录行数、约束和抽样结果。
- [ ] OpenResty 上游切换到宿主机 `127.0.0.1:3001` 后，公开 `/api/` 返回正确 JSON 状态；不要求迁移过程回切 Node 到 `3000`。
- [ ] 静态网站仍为完整 9 文件集合或同一次构建的新完整集合，没有 hash 混用。
- [ ] HTTP 阶段明确标注为联调；HTTPS、Cookie Secure、正式域名和双账号/双设备仍单独待验收。
- [ ] 迁移失败时，按回滚步骤恢复旧 API，且无删除 MySQL 卷或生产数据的动作。

## 9. 参考资料与不采用的旧假设

- [1Panel 官方 Node runtime 源码](https://github.com/1Panel-dev/runtime)：参考面板运行环境的组织方式；不因引用该仓库就声称当前已迁移。
- [1Panel Supervisor 文档](https://1panel.cn/docs/v2/user_manual/toolbox/supervisor/)：若 Node 运行环境无法满足长期进程管理，再评估 Supervisor；未确认前不把它作为现行方案。
- `project/deploy/docker/` 中关于共享 Docker 网络的旧部署模型：只作为备用/历史参考，不覆盖当前 OpenResty host-network 和 API 宿主机回环发布事实。

最终完成条件不是“Node 页面能启动”，而是：面板可见的运行环境、秘密来源、回环端口、Argon2 原生兼容、数据库连接、公开 API、完整静态发布、日 7/周 4 备份和临时库恢复演练均有可复核证据，并且旧 API 与 MySQL 数据仍可安全回滚。
