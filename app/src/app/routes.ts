import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

export type Route = "/" | "/review" | "/review/new" | "/review/review" | "/spell" | "/import" | "/words" | "/profile" | "/statistics" | "/login" | "/admin";

export const routeNames: Record<Route, string> = {
  "/": "今日",
  "/review": "复习",
  "/review/new": "新学",
  "/review/review": "复习",
  "/spell": "拼写",
  "/import": "导入",
  "/words": "词库",
  "/profile": "个人",
  "/statistics": "学习统计",
  "/login": "账号登录",
  "/admin": "账号管理",
};

const currentRoute = (): Route => {
  const raw = (window.location.hash.replace(/^#/, "") || "/").split("?")[0] as Route;
  return raw in routeNames ? raw : "/";
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => {
    ready: Promise<void>;
    updateCallbackDone: Promise<void>;
    finished: Promise<void>;
  };
};

const settleSkippedTransition = (transition: ReturnType<NonNullable<ViewTransitionDocument["startViewTransition"]>>) => {
  // Rapid navigation intentionally skips the older snapshot. Consume the browser's
  // AbortError promises so this expected hand-off never reaches the global error log.
  void transition.ready.catch(() => undefined);
  void transition.updateCallbackDone.catch(() => undefined);
  void transition.finished.catch(() => undefined);
};

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [, setLocationVersion] = useState(0);

  useEffect(() => {
    const sync = () => {
      const commitLocation = () => {
        flushSync(() => {
          setRoute(currentRoute());
          // `#/spell?...` may keep the same route while changing its scope.
          // Keep query-driven pages in sync even when the route label itself is unchanged.
          setLocationVersion((version) => version + 1);
        });
      };
      const startViewTransition = (document as ViewTransitionDocument).startViewTransition;
      if (typeof startViewTransition !== "function") {
        commitLocation();
        return;
      }
      try {
        settleSkippedTransition(startViewTransition.call(document, commitLocation));
      } catch {
        // A browser can expose the API but reject a particular update. Keep navigation reliable.
        commitLocation();
      }
    };
    window.addEventListener("hashchange", sync);
    if (!window.location.hash) window.location.hash = "/";
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return route;
}

export const getHashSearchParams = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");
