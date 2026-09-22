# 004 — 让前台路由和后台状态平滑切换

- **Status**: VERIFIED — automated checks and local browser acceptance passed
- **Commit**: 463237d
- **Severity**: HIGH
- **Category**: missed opportunities, accessibility, performance
- **Estimated scope**: 4 files, small focused change

## Problem

前台哈希路由在 `app/src/app/routes.ts:29-33` 直接提交 React 状态，旧页面立即被新页面替换：

```ts
const sync = () => {
  setRoute(currentRoute());
  setLocationVersion((version) => version + 1);
};
```

`app/src/App.tsx:247-266` 的稳定页面壳已经把顶栏、主内容和底部导航分开，但主内容没有独立转场边界：

```tsx
<main id="main-content" ref={mainRef} tabIndex={-1} className={...}>
  {storageStatus && (...)}
  {children}
</main>
```

因此点击“今日 / 词库 / 个人”、进入学习或使用浏览器前进后退时，内容区域瞬间跳变。`app/src/AdminApp.tsx:94-98` 又通过多个 early return 在权限检查、登录、无权限和后台主界面之间整页硬切。

GitHub Primer 的动效指导要求动效必须有用途、保持轻微，并尊重 `prefers-reduced-motion`。MDN 和 Chrome 的 View Transition 文档建议在 SPA 路由更新回调中使用 `document.startViewTransition()`，用 `view-transition-name` 只截取真正变化的区域，让稳定导航留在原位。

## Target

- 前台每次哈希导航（包括浏览器前进/后退与同一路径查询参数变化）通过 View Transition API 提交 React DOM 更新；不支持该 API 时仍立即更新，并用 keyed 内容容器做短暂 CSS 进入过渡。
- 只过渡主内容，不移动固定顶栏和底部导航。
- 默认旧内容 100ms 淡出并上移 2px，新内容 200ms 淡入并从下方 6px 到位；使用 `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`，只动画 `opacity` 与 `transform`。
- `prefers-reduced-motion: reduce` 时取消位移，仅保留 100ms 透明度变化。
- 管理员页的 `checking / anonymous / forbidden / ready` 状态使用相同的 180ms 淡入与 4px 位移，并通过 `key={state}` 确保状态变化时重新挂载；减少动态效果时仅淡入。
- 不增加依赖，不改学习规则、鉴权协议、数据加载语义或路由地址。

## Repo conventions to follow

- 动效 token 位于 `app/src/styles/index.css:5-9`；沿用 `--ease-out`，不要另写近似曲线。
- 弹层在 `app/src/styles/index.css:1120-1159` 已使用 `opacity`、`transform` 和 `@starting-style`；页面状态进入沿用这一模式。
- `app/src/styles/index.css:1188-1237` 已集中处理减少动态效果；把新选择器加入同一策略，不创建互相冲突的媒体查询。
- `PageShell` 已将 header 和 nav 放在 `<main>` 外；转场名只加到 `#main-content`。

## Steps

1. 在 `app/src/app/routes.ts` 导入 `flushSync`。定义最小本地类型来读取可选的 `document.startViewTransition`，避免引入 polyfill。
2. 在 `hashchange` 的 `sync` 内先构造 `commitLocation`：用一个 `flushSync` 同时执行 `setRoute(currentRoute())` 和 `setLocationVersion(...)`，确保浏览器在转场回调结束前看到新的 DOM。
3. 若 `startViewTransition` 可用，用 `startViewTransition.call(document, commitLocation)`；不可用时直接调用 `commitLocation`。若 API 同步抛错，执行一次直接回退，不能丢失导航更新。
4. 给 `PageShell` 增加 `contentKey: string`，在 `main` 内用 `<div key={contentKey} className="route-transition-content">` 包住 `children`。调用处用当前完整 hash（含查询参数，空值回退 route）生成 key。
5. 给 `#main-content` 设置唯一的 `view-transition-name: route-content`。添加 `route-content-out`、`route-content-in` 两组关键帧和对应的 `::view-transition-old(route-content)` / `new` 规则；总时长不得超过 200ms。
6. 在不支持 `view-transition-name` 的浏览器里，让 `.route-transition-content` 使用 180ms 进入动画。不要同时给支持 View Transition 的浏览器播放 fallback，避免双重动画。
7. 重构 `AdminApp`，先根据 `state` 生成现有内容，再统一返回 `<div key={state} className="admin-state-surface">`；保留当前文案、请求、错误处理与布局语义。
8. 给 `.admin-state-surface` 添加 180ms `opacity/translateY(4px)` 的 `@starting-style` 进入过渡。
9. 在减少动态效果媒体查询中，将路由转场和管理员状态改为仅透明度 100ms，无 `transform`。

## Boundaries

- Do NOT touch server, API client, repository, authentication timing, learning state, modal manager, service worker, deployment config, or existing unrelated uncommitted changes.
- Do NOT add an animation library or React routing library.
- Do NOT animate layout properties, blur the whole page, add parallax, or exceed 200ms for route changes.
- Preserve `PageShell` focus transfer to `#main-content` and browser back/forward behavior.
- If `flushSync` cannot typecheck with the installed ReactDOM types, STOP and report instead of replacing it with timers.

## Verification

- **Mechanical**: run `node --test app/tests/*.test.mjs` and `pnpm build`; all existing tests and TypeScript/Vite production build must pass.
- **Feel check**: in a real browser, click 今日 → 词库 → 个人 → 今日, enter and leave a learning route, then use Back/Forward. Confirm:
  - header and bottom navigation remain visually fixed;
  - only main content fades/slides, with no white flash or duplicate page;
  - rapid repeated navigation ends on the last selected page;
  - focus still moves to `#main-content` after route changes.
- Open `/admin.html` and confirm checking → login (or ready) no longer hard-cuts.
- Emulate `prefers-reduced-motion: reduce` and repeat navigation; confirm there is no positional movement and the content change still has a brief opacity cue.
- **Done when**: automated checks pass and browser inspection confirms all four behaviors above at desktop and mobile widths.

## Sources

- https://primer.style/accessibility/design-guidance/motion-and-animation/
- https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using
- https://developer.chrome.com/docs/web-platform/view-transitions/same-document

## Verification result (2026-09-22)

- Frontend tests: 81/81 passed.
- Server tests: 61 passed, 1 real-MySQL integration case skipped because this local fixture has no MySQL.
- Server typecheck and Vite production build passed; build contains both `index.html` and `admin.html`.
- Browser fixture verified 今日 → 词库 → 个人, Back/Forward, rapid repeated navigation, and the independent admin permission state at desktop and 390×844 mobile size.
- Reduced-motion emulation reported `prefers-reduced-motion: reduce`, `route-content-fade-in`, and `transform: none`.
- Rapid navigation initially exposed an expected skipped-transition `AbortError`; the implementation now consumes all ViewTransition settlement promises. A second rapid-navigation run ended on the final route with no warning/error logs.
