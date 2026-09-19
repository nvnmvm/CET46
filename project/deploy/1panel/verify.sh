#!/usr/bin/env bash
# 静态站点发布验收脚本
# 用法：./verify.sh https://your-domain [本地dist目录]
# 只做只读 HTTP 检查，不修改服务器任何内容。

set -uo pipefail

BASE="${1:?用法: ./verify.sh https://域名 [dist目录]}"
BASE="${BASE%/}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="${2:-$SCRIPT_DIR/../../../dist}"

pass=0
warn=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }

status_of() { curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$1" 2>/dev/null; }
header_of() { curl -sSI --max-time 20 "$1" 2>/dev/null | tr -d '\r' | awk -F': ' -v k="$2" 'tolower($1)==tolower(k){print $2; exit}'; }
body_of()   { curl -sS --max-time 20 "$1" 2>/dev/null; }

echo "验收目标：$BASE"
case "$BASE" in
  https://*) ok "使用 HTTPS，Service Worker 与 PWA 可正常启用" ;;
  *) note "当前是 HTTP；HTTP 下浏览器不会注册 Service Worker，PWA 与离线壳无法验收" ;;
esac

echo
echo "[1] 入口页面"
HOME_HTML="$(body_of "$BASE/")"
HOME_CODE="$(status_of "$BASE/")"
if [ "$HOME_CODE" = "200" ]; then ok "首页返回 200"; else bad "首页返回 $HOME_CODE"; fi
if printf '%s' "$HOME_HTML" | grep -q '<div id="root">'; then
  ok "首页是应用壳（含 #root 挂载点）"
else
  bad "首页内容不像构建产物，可能上传了源码 index.html 或目录索引"
fi

echo
echo "[2] 静态资源与路径形态"
JS_PATH="$(printf '%s' "$HOME_HTML" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)"
CSS_PATH="$(printf '%s' "$HOME_HTML" | grep -oE '/assets/[A-Za-z0-9._-]+\.css' | head -1)"
if [ -n "$JS_PATH" ]; then
  code="$(status_of "$BASE$JS_PATH")"
  [ "$code" = "200" ] && ok "JS 资源可访问（$JS_PATH）" || bad "JS 资源返回 $code（$JS_PATH）"
  note "产物引用根路径 $JS_PATH：站点必须挂在域名根路径，子目录部署需先设置构建 base"
else
  bad "首页里找不到 /assets/*.js，构建产物不完整"
fi
[ -n "$CSS_PATH" ] && { code="$(status_of "$BASE$CSS_PATH")"; [ "$code" = "200" ] && ok "CSS 资源可访问（$CSS_PATH）" || bad "CSS 资源返回 $code（$CSS_PATH）"; }

echo
echo "[3] 是否为本次最新构建"
if [ -f "$DIST/index.html" ]; then
  LOCAL_JS="$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$DIST/index.html" | head -1)"
  if [ -n "$LOCAL_JS" ] && [ "$LOCAL_JS" = "$JS_PATH" ]; then
    ok "线上资源与本地 dist 一致（$LOCAL_JS）"
  else
    bad "线上资源与本地 dist 不一致：线上 $JS_PATH，本地 $LOCAL_JS（可能是旧版本或缓存）"
  fi
else
  note "未找到本地 $DIST/index.html，跳过版本比对"
fi

echo
echo "[4] PWA 资源与响应头"
code="$(status_of "$BASE/manifest.webmanifest")"
ct="$(header_of "$BASE/manifest.webmanifest" 'Content-Type')"
if [ "$code" = "200" ]; then
  case "$ct" in
    *manifest+json*) ok "manifest 返回 200 且类型正确（$ct）" ;;
    *) note "manifest 返回 200 但 Content-Type 是 $ct，建议在服务器补 application/manifest+json" ;;
  esac
else
  bad "manifest 返回 $code"
fi

for icon in icon-192.png icon-512.png icon.svg sw.js; do
  code="$(status_of "$BASE/$icon")"
  [ "$code" = "200" ] && ok "$icon 可访问" || bad "$icon 返回 $code"
done

sw_cc="$(header_of "$BASE/sw.js" 'Cache-Control')"
case "$sw_cc" in
  ""|*no-cache*|*no-store*|*max-age=0*) ok "sw.js 未被长效缓存（Cache-Control: ${sw_cc:-未设置}）" ;;
  *) note "sw.js 被长效缓存（Cache-Control: $sw_cc）：会让用户卡在旧应用壳，建议改为 no-cache" ;;
esac

idx_cc="$(header_of "$BASE/" 'Cache-Control')"
case "$idx_cc" in
  ""|*no-cache*|*no-store*|*max-age=0*) ok "index.html 未被长效缓存（Cache-Control: ${idx_cc:-未设置}）" ;;
  *) note "index.html 被长效缓存（Cache-Control: $idx_cc）：新版本可能推不出去，建议改为 no-cache" ;;
esac

echo
echo "[5] API 边界（静态站阶段）"
api_code="$(status_of "$BASE/api/health")"
api_ct="$(header_of "$BASE/api/health" 'Content-Type')"
if [ "$api_code" = "404" ] || [ "$api_code" = "000" ]; then
  ok "/api/ 未回退到首页（返回 $api_code）"
elif [ "$api_code" = "200" ] && printf '%s' "$api_ct" | grep -qi 'text/html'; then
  bad "/api/ 被 SPA 回退成 200 的 HTML：接后端后会把 401/404/500 全变成 200，建议加 location ^~ /api/ { return 404; }"
else
  note "/api/ 返回 $api_code（$api_ct），与本阶段预期不符，人工确认"
fi

echo
echo "[6] 需要人工在浏览器确认（脚本查不了）"
echo "  - 逐个打开 #/import、#/review、#/words、#/statistics 和手机端布局"
echo "  - 导入一份 TSV，刷新页面确认进度保留"
echo "  - DevTools → Application：Service Worker 已激活，Cache Storage 为 cet-word-shell-v3"

echo
printf '结果：通过 %d，警告 %d，失败 %d\n' "$pass" "$warn" "$fail"
[ "$fail" -eq 0 ] || exit 1
