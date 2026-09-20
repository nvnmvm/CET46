# 001 — 修复小屏布局、弹窗和高频输入

- Status: IMPLEMENTED — automated checks pass; browser/real-device visual verification remains with the main agent
- Commit: 线上 `b3f74ef`；本机无HEAD。App/CSS/Statistics核对后以当前文件为基线；不创建虚假commit标记。
- Severity: HIGH
- Category: responsive, accessibility, purpose/frequency
- Scope: App.tsx、styles/index.css、StatisticsPage.tsx、新增独立UI组件/工具与必要回归测试。

## Problem

`app/src/styles/index.css:50` `.home-page` 使用 `isolation: isolate`；首页设置框嵌套于其中，即便 z-50 仍处于子层叠上下文，线上320×740截图显示header/nav遮住弹窗。
`App.tsx:1114`等六个对话框直接渲染在页面内部；部分面板缺最大高度/滚动。
`index.css:179` `.home-study-actions { display:flex; flex-shrink:0; gap:0.75rem; }`和并排标题使320px下标题折为5行。
`App.tsx:2642`输入卸载后，“重试/下一个词”没有焦点衔接；另一个复习拼写分支同样存在。
`App.tsx:922/1086/1189`滚轮默认smooth滚动未考虑reduced motion。
`StatisticsPage.tsx:49`左右键只更新active而未移动DOM focus。

## Target

沿用现有 `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`、`--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`。弹窗进入 transform 220ms、opacity 180ms；高频输入/下一题不增加装饰动画。reduced-motion的JS滚动改auto，现有静态颜色反馈保留。
所有模态挂document.body，层级高于顶栏和底部导航，独立滚动且有安全区。手机标题获得完整可读行宽；主要操作不受装饰过度挤压。

## References

- https://github.com/radix-ui/primitives/blob/main/packages/react/dialog/src/dialog.tsx ：参考Portal、焦点恢复、对话框隔离设计，MIT；不直接复制源码。
- https://github.com/RealKai42/qwerty-learner ：参考高频键盘练习的连续反馈，GPL3；不复制实现、不照搬桌面布局到手机。

## Steps

1. 新建 `app/src/components/ModalPortal.tsx`，使用ReactDOM createPortal将children挂body；对现有六个模态框逐个包裹，保留现有useModalDialog的Escape/焦点返回/保存行为。不要引入新库。
2. 若现有focus trap不足，则修正在独立hook/component中；背景不可交互、Tab不逃出；嵌套模态必须正确恢复，不能误释放另一模态的scroll lock。
3. 给统一modal面板提供 `max-height` 的100vh回退/100dvh和safe-area、安全内部滚动；手机横屏和短高度必须能到达关闭/保存，不再被nav覆盖。
4. 480px以下首页标题与工具栏改上下/可换行布局，工具触控面积至少44px；压缩插画高度和空隙，保留品牌和桌面布局。
5. 词库sticky偏移计入header safe-area；输入内容范围加入min-width:0和overflow-wrap:anywhere，不对整站粗暴隐藏溢出。
6. 三个滚轮点击路径根据matchMedia reduced-motion返回auto/smooth；键盘路径保持auto。封装可测小函数。
7. 拼写输入提交后焦点衔接结果操作按钮，再次学习恢复输入焦点；防止同一次Enter事件误触发下一题；不要改评分/提交协议。
8. 统计柱状图左右键移动焦点到真实按钮，可Home/End；窄屏标签应可读，不必展示每个冗余日期文本。

## Boundaries

不得改变学习规则、API、词库数据或部署。不得清理git/覆盖既有无关改动。不要增加动画库。退出动画为低优先级，本轮不为延迟卸载引入状态机。

## Verification

- 运行 `node --test app/tests/*.test.mjs` 和 `pnpm build`（使用已存在Node24路径，不安装系统环境）。
- 浏览器320/390/768/1440；首页标题清楚；模态盖住导航且保存可达；Tab/ShiftTab/Escape/返回焦点正确。
- 键盘完整连续完成两个拼写词，无额外Tab；触控不出现sticky hover；reduced motion滚轮无平滑滚动。
- 手机真机软键盘/Safari待用户配合；不能以Chrome模拟代替真机结论。

## Implementation handoff (2026-09-20)

- Added `app/src/components/ModalPortal.tsx`; all six existing dialogs now portal to `document.body` while retaining the existing focus/escape behavior.
- Added safe-area-aware modal padding, `100vh`/`100dvh` max-height fallback, internal scrolling, sticky-library offset compensation, narrow-home header stacking, and compact trend labels.
- Added `app/src/utils/scrollBehavior.ts`; wheel click scrolling now respects `prefers-reduced-motion` while keyboard paths remain `auto`.
- Added focus handoff from spelling submission to the result action in both spelling flows; next-word inputs retain their existing autofocus behavior.
- Added Home/End and real DOM focus movement for the statistics schedule buttons.
- Added long-token wrapping for import previews and learning content. Integrated the parent-provided `/admin` route with `AdminUsersPage` and `AdminEntry`.
- Added `app/src/components/modalManager.ts`: one shared modal stack now owns the document keydown listener, keeps only the top modal responsive to Escape/Tab, makes `#root` inert, and holds body scroll locking until the final modal closes while restoring the prior values. Focus returns only when the topmost modal unregisters.
- Added behavior tests for nested modal lock/escape ownership, outside-focus Tab recapture/wrapping, and the reduced-motion helper in `app/tests/modalManager.test.mjs`.
- Regression evidence: TypeScript app check passed; `node --test app/tests/*.test.mjs` passed 77/77; production TypeScript build and Vite build passed earlier in this task. No browser or real-device validation was run by this agent.
