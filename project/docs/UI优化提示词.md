# CET 真题背词网站 UI 优化提示词

请使用 `emil-design-eng` skill 优化这个 React + Vite + Tailwind CET 真题背词网站。

项目目标：让“导入词汇 → 今日复习 → 主动回忆 → 拼写验证 → 查看进度”这条主路径更清晰、更有反馈感，同时保持中文、手机优先和本机 localStorage 数据模型不变。

请遵守以下要求：

1. 先阅读 `README.md`、`project/docs/源码导览.md`、`app/src/App.tsx`、`app/src/styles/index.css`、`app/src/data/localStore.ts`，确认现有功能和数据边界；不要把本地登录误改成真实登录，也不要删除备份、恢复和复习草稿功能。
2. 优先优化信息层级、按钮反馈、卡片状态、表单错误、弹窗行为、键盘操作和移动端触控尺寸。
3. 动画只服务于反馈和空间关系：按钮按下使用 100—160ms 的轻微缩放；弹窗从接近可见的状态进入；使用 `transform`、`opacity` 和明确的 transition 属性，不使用 `transition: all`，不使用 `scale(0)`。
4. 悬停位移必须放在 `@media (hover: hover) and (pointer: fine)` 中；加入 `prefers-reduced-motion: reduce`，减少位移和动画。
5. 复习进度条只过渡 `width`，统计柱只过渡 `height`；不要为了视觉效果给高频键盘操作增加延迟。
6. 弹窗要有 `role="dialog"`、`aria-modal`、明确标题、Esc 关闭和合理的初始焦点；选项卡要有 `role="tab"` 与 `aria-selected`；状态提示使用 `aria-live`。
7. 保持现有复习算法、localStorage key、TSV 8 列格式和备份格式兼容；任何数据结构变化都必须先说明迁移方案。
8. 检查页面文案是否与当前路线一致：当前是本机 localStorage 版本，后续计划是自建 Node API + MySQL，不要留下误导性的旧 Supabase 文案。
9. 完成后运行：
   - `pnpm exec tsc -p project/tooling/tsconfig.app.json --noEmit`
   - `pnpm exec tsc -p project/tooling/tsconfig.node.json --noEmit`
   - `pnpm test`
   - `pnpm build`
10. 最后报告：修改了哪些文件、用户能感知到什么变化、测试结果、仍未验证的浏览器行为。

审查或汇报 UI 改动时必须使用以下表格格式，不要把 Before/After 分成两段：

| Before | After | Why |
| --- | --- | --- |
| 现状 | 改法 | 对用户和交互的影响 |
