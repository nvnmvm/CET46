import { useEffect, useState } from "react";

export type Route = "/" | "/review" | "/review/new" | "/review/review" | "/spell" | "/import" | "/words" | "/profile" | "/statistics" | "/login";

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
  "/login": "本地登录",
};

const currentRoute = (): Route => {
  const raw = (window.location.hash.replace(/^#/, "") || "/").split("?")[0] as Route;
  return raw in routeNames ? raw : "/";
};

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [, setLocationVersion] = useState(0);

  useEffect(() => {
    const sync = () => {
      setRoute(currentRoute());
      // `#/spell?...` may keep the same route while changing its scope.
      // Keep query-driven pages in sync even when the route label itself is unchanged.
      setLocationVersion((version) => version + 1);
    };
    window.addEventListener("hashchange", sync);
    if (!window.location.hash) window.location.hash = "/";
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return route;
}

export const getHashSearchParams = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");
