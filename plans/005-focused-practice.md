# 005 — 稳定练习布局与连续操作

- Status: VERIFIED; automated checks and 7 browser acceptance groups passed
- Base: 52041be
- Date: 2026-10-15
- Scope: Level 2 presentation/refactor; App.tsx, styles/index.css, new components/PracticeSpellingCard.tsx

## Objective

参考 Monkeytype 的专注练习和结果层次、Qwerty Learner 的组内练习与后续操作，改善既有新学/复习/拼写体验。独立实现，不复制第三方代码或素材。保留所有评分、队列、API、缓存、草稿和幂等语义。

## Relevant files

- app/src/App.tsx: PageShell (190), NewStudyPage (2128), SpellingPracticePage (2339), ReviewPage (2668), ReviewProgress (3107), App.refresh (3224)
- app/src/styles/index.css: motion tokens, dark overrides, shared button/input styles
- app/src/types.ts: SpellingResponse
- package.json and .github/workflows/ci.yml: existing test/build commands

## Steps

1. PageShell 对 /review、/review/new、/review/review、/spell 使用 app-shell--practice：隐藏底部导航和账号入口，保留品牌、主题控件和页面内原有返回入口。主内容最大宽度 48rem，窄屏 padding-inline 1rem，减少为底栏预留的空白；避免影响游客/login/普通页面。
2. 新增 PracticeSpellingCard，两个拼写分支共用。Props 接受 word/meaning/phonetic/sentenceCn/source、answer/onAnswerChange、checked(SpellingResponse|null)、saving、actionRef、onCheck/onRetry/onContinue、continueLabel/correctedMessage。组件无 repository/API 调用，不计算评分。
3. 稳定的卡片结构：提示区、显式 label=英文拼写 的输入框、反馈区、一个主操作按钮始终保持位置。unchecked 输入可编辑；checked 输入 readOnly；saving 输入和操作按钮 disabled。feedback 默认为静态 Enter 提示，正确显示正确/订正文案，错误显示用户输入与正确答案（未经提交不能把正确答案渲染进 DOM）。反馈区 min-block-size 10rem，内容可自然增长，长单词使用 overflow-wrap:anywhere。不要给每题新增进入动画。
4. 使用 form onSubmit 处理键盘与点击：preventDefault；saving 或 composing 时忽略；unchecked 调 onCheck，checked 错误调 onRetry，checked 正确调 onContinue。不在 keydown 中 check 导致 Enter 继续触发新按钮。input spellCheck=false、autoCapitalize=none、autoCorrect=off。输入 ref 在 checked 变为 null 和单词变化时 focus({preventScroll:true})；checked 时复用现有父级 actionRef 聚焦行为。IME composition 期间 Enter 不得提交（可 ref 跟踪 composition 并阻止 Enter 默认提交）。不增加全局快捷键。
5. 用共享组件替换 standalone/review 两处拼写展示，保持原检查/订正/继续函数以及来源和完成标签差异。review 最后一步显示 saving=completionSaving、保存中…、disabled，和独立拼写一致。
6. 三个 withBack 包装加 practice-session 与 data-phase；新学学习卡、回忆卡添加 practice-card，结果/summary 加 practice-result。新学完成添加明确链接“拼写今天新学的词” href=#/spell；不能声称只练刚结束的这一组。词库拼写最后一组结果去掉重复“回到词库/查看词库”双链接，保留回到词库和回到今日两个明确动作。
7. 新学切换 learning/index、summary/complete 时对当前 h1 focus({preventScroll:true})；回忆 firstChoice 切换、index 切换或 summary/complete 时类似聚焦标题；标题 tabIndex=-1，避免全局热键或每次敲字抢焦点。modal 打开/关闭不应被这些 effect 夺走焦点。可使用本地 session ref 范围查 h1，依赖只含 phase/index/firstChoice，不含 answer/spellingChecked。
8. App.refresh 保留已挂载结果/学习页面：新增 cloudRefreshing 表示由已保存操作触发的刷新，refresh() 使用它代替 cloudLoading；初次登录/user effect 的 cloudLoading 阻塞行为不改。PageShell 接收 refreshing 并在布局外固定位置展示 role=status“正在更新学习数据…”的静态小提示（无无限动画），不改内容 key。错误处理沿用 handleCloudError；用户退出/401/!user 清除 cloudRefreshing。仅分离 UI 加载状态，不修改 hydrate、repository、请求或缓存逻辑。
9. 样式以现有 token 延伸：prompt 最小高度、feedback最小高度、卡片内容长文本可换行、桌面更舒展、手机 320px 无水平溢出；新增 dark 主题颜色。复用已有按钮反馈，不为键盘每题动作添加过渡。结果面板可用 opacity 125ms --ease-out @starting-style，reduce 时仅 opacity。不得 transition-all/布局动画/新增依赖。

## Constraints

- 一位 Executor 串行编辑；保留别人修改；不创建子代理。
- 不改后端、API client、repository、types、评分/队列/草稿字段/请求协议、service worker 或部署配置。
- 不清空用户数据；所有浏览器写入仅本地内存 fixture。
- 不在状态更新/async handler里引入动画等待或提交延迟。
- 如发现步骤不成立，停止相关步骤并反馈，不自行扩大功能范围。

## Acceptance criteria

- 320/390/1440px 学习页面无导航干扰、返回可用、主题可切换、无水平溢出。
- 输入→错误→订正→正确→下一词，输入框保持挂载，按钮位置对短答案保持稳定，焦点可连续 Enter 操作。
- 连按 Enter 不会一次提交跳过一词；IME Enter 不提交；错误答案需订正，hadError 含义不变。
- 复习末题保存时按钮禁用/文案正确，失败可重试。
- 新学/每日拼写/复习完成面板在 onFinished 刷新之后仍保留，显示正确语义；词库拼写不写学习记录。
- 减少动态效果时无位移动画，明暗主题可读。

## Tests

- PATH 使用 bundled Node runtime；运行 pnpm test、pnpm build（均为现有命令），记录真实结果。
- 主代理使用现有 preview-fixture.mjs + Playwright/隔离 Chrome 完成真实浏览器行为验收；现有 fixture 仅内存，不是 MySQL。
- 不添加只匹配源码文本的测试；有行为变化以真实浏览器脚本覆盖并保留验收脚本/结果供复查。

## References

- https://github.com/monkeytypegame/monkeytype/blob/master/frontend/src/ts/components/pages/test/result/TestResult.tsx
- https://github.com/RealKai42/qwerty-learner/blob/master/src/pages/Typing/components/ResultScreen/index.tsx
- https://github.com/RealKai42/qwerty-learner/blob/master/src/pages/Typing/components/Progress/index.tsx

## 验收结果（2026-10-15）

- `pnpm test`：81/81 通过；`pnpm build`：TypeScript 与 Vite 通过，两个 HTML 入口均生成。
- `project/tooling/practice-acceptance.mjs`：7 组通过，使用已安装 Chrome 的隔离 headless 会话，访问本地内存 fixture。
- 覆盖 320/390/1440 宽度、初始/答案焦点、错误订正、IME Enter、实际按住 Enter、保存中按钮锁定、503 后重试复用 submissionKey、复习错词回炉、三种完成结果在刷新后保留、词库拼写不更改学习进度。
- 明暗主题与减少动态效果已检查；截图等待动画结束后采集，截图产物位于 `/tmp/cet-practice-acceptance/`。
- 未执行 Safari / iPhone 真机验收。本地内存 fixture 不代表生产 MySQL 验收。
- GitHub 提交后再确认 CI；截至本地验收结束，原网站与 1Panel 均返回空响应，尚未部署本轮代码。

## 复验

先运行现有 `node project/tooling/preview-fixture.mjs`，再运行 `node project/tooling/practice-acceptance.mjs`。脚本固定访问 `http://127.0.0.1:5177`，会在内存 fixture 创建独立测试账号、导入示例并验证练习，不接受公网目标。

Playwright 不作为新增产品依赖；复验环境需提供 Playwright 和 Chrome。若包不在本项目模块搜索路径，可设置 `CET_PLAYWRIGHT_MODULE` 指向现有 Playwright 包目录，`CET_CHROME_PATH` 指向现有浏览器可执行文件；`CET_ACCEPTANCE_OUTPUT` 可更改截图保存目录。
