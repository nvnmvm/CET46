import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { wordRepository } from "./data/repository";
import { ApiError, apiClient } from "./data/apiClient";
import { buildEditableTsv } from "./data/editableTsv";
import { buildLearningStatistics } from "./data/statisticsService";
import StatisticsPage from "./pages/StatisticsPage";
import ModalPortal from "./components/ModalPortal";
import { modalManager } from "./components/modalManager";
import { getMotionScrollBehavior } from "./utils/scrollBehavior";
import { getHashSearchParams, routeNames, useHashRoute, type Route } from "./app/routes";
import { parseTsv } from "./features/import/parseTsv";
import type {
  CountdownSettings,
  LocalUser,
  LocalProfile,
  RecognitionResponse,
  ReviewCompletion,
  ReviewDraft,
  SpellingResponse,
  ThemeMode,
  WordInput,
  WordWithProgress,
} from "./types";

type ReviewMode = "all" | "new" | "review";
type MemoryState = "new" | "learning" | "review" | "mastered" | "killed";
type WordListFilter = "all" | "today" | "new" | "learning" | "mastered" | "killed";
type SpellingScope = "daily" | "library";
type ActiveReviewPhase = ReviewDraft["phase"];
type ReviewPhase = "ready" | Exclude<ActiveReviewPhase, "learning"> | "complete";
type NewStudyPhase = "ready" | "learning" | "complete";
type SpellingPracticePhase = "ready" | "spelling" | "complete";

const MAX_SESSION_WORDS = 20;
const AVATAR_OPTIONS = ["◎", "✦", "◒", "☀", "♢", "✺"];

const SAMPLE_TSV_WITH_PHONETIC = `word\tphonetic\tmeaning\tphrase\tsentence\tsentence_cn\tsource\ttype
alleviate\t/əˈliːvieɪt/\tv. 缓解；减轻\talleviate financial pressure\tThe policy could alleviate financial pressure.\t这项政策可以缓解经济压力。\t2025-12 CET6 阅读1\tmarked
implement\t/ˈɪmplɪment/\tv. 实施；执行\timplement a policy\tThe government implemented the policy.\t政府实施了这项政策。\t2025-12 CET6 阅读1\tadded`;

const GPT_PHOTO_PROMPT = `请识别我随消息附上的英语真题、练习题或单词笔记照片，并生成能直接导入“CET 真题个人背单词系统”的 TSV 文本。

提取规则：
1. 优先提取照片中被圈出、下划线、标黄、箭头或手写标记的英文单词；如果没有明显标记，提取 5—15 个适合 CET4/CET6 学习的重点词。
2. word 使用小写词典原形；同一个单词只保留一行。
3. phonetic 必须填写规范 IPA，并保留两侧斜杠，例如 /ˈæləkeɪt/。
4. meaning 必须以词性缩写开头，再写简洁中文释义，优先采用照片语境中的含义。例如“v. 分配；拨出”、“n. 资源；财力”、“adj. 普遍的；流行的”；有多个常用词性时用“；”分隔，例如“n. 影响；作用；v. 影响”。不要只写中文释义。
5. phrase 填写包含该词的常用搭配；sentence 优先抄录照片中的完整英文原句；sentence_cn 给出准确中文翻译。
6. source 尽量填写可识别的考试、年份、题型或页码；无法判断时填写“图片识别”。
7. 照片中由我标记的词，type 写 marked；你额外补充的同句重点词，type 写 added。
8. 照片模糊、遮挡或无法确认的内容不要猜测；原句只在能从照片确认时抄录，补写例句请保留为空，来源也不要编造。

输出规则：
- 只能输出纯 TSV，不要解释、标题、序号、Markdown 表格或代码块。
- 第一行必须严格是下面 8 列，顺序不能改变：
word\tphonetic\tmeaning\tphrase\tsentence\tsentence_cn\tsource\ttype
- 每个字段之间必须使用一个 Tab 制表符，不要用空格代替。
- 每个单词占一行；单元格内部不要换行或插入 Tab。
- word、phonetic、meaning 和 type 不得留空；其他信息无法从图片确认时保留空单元格，但整行仍必须保持 8 列。
- type 只能是 marked 或 added。
- 输出前逐行检查列数、音标、单词原形和重复项。

正确示例 1（我在图片中标记的词）：
allocate\t/ˈæləkeɪt/\tv. 分配；拨出\tallocate resources\tThe city allocated more resources to public transport.\t这座城市为公共交通分配了更多资源。\t2024-06 CET4 阅读2\tmarked

正确示例 2（你从同句补充的重点词）：
prevalent\t/ˈprevələnt/\tadj. 普遍存在的；流行的\ta prevalent view\tThis view is increasingly prevalent among young people.\t这种观点在年轻人中越来越普遍。\t图片识别\tadded`;

const typeLabel = (type: "marked" | "added") => (type === "marked" ? "我标记的" : "AI 补充");

const memoryState = (item: WordWithProgress): MemoryState => {
  if (item.progress.killedAt) return "killed";
  if (!item.progress.lastReviewAt) return "new";
  if (item.progress.reviewStage >= 5) return "mastered";
  if (item.progress.reviewStage >= 3) return "review";
  return "learning";
};

const memoryStateLabel: Record<MemoryState, string> = {
  new: "新词",
  learning: "记忆中",
  review: "巩固中",
  mastered: "已掌握",
  killed: "已斩",
};

const wordListFilterLabels: Record<WordListFilter, string> = {
  all: "全部",
  today: "今日",
  new: "未学习",
  learning: "学习中",
  mastered: "已熟识",
  killed: "已斩",
};

const isWordListFilter = (value: string | null): value is WordListFilter =>
  value === "all" || value === "today" || value === "new" || value === "learning" || value === "mastered" || value === "killed";

const filterWordGroup = (words: WordWithProgress[], filter: WordListFilter, todayWordIds: Set<string>) =>
  words.filter((item) =>
    filter === "all" ||
    (filter === "today" ? todayWordIds.has(item.id) :
      filter === "learning" ? ["learning", "review"].includes(memoryState(item)) : memoryState(item) === filter),
  );

const memoryStateClass: Record<MemoryState, string> = {
  new: "bg-blue-50 text-blue-700 ring-blue-100",
  learning: "bg-amber-50 text-amber-800 ring-amber-100",
  review: "bg-sky-50 text-sky-700 ring-sky-100",
  mastered: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  killed: "bg-slate-100 text-slate-600 ring-slate-200",
};

const displayDate = (iso: string | null) => {
  if (!iso) return "尚未复习";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(iso));
};

/** 将所有 API 失败收敛为页面可理解的提示，避免各页面回显不一致的底层错误。 */
const apiErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : fallback;
  if (error.status === 0 || error.code === "network_error") return "网络连接失败，本次操作尚未确认保存。";
  if (error.code === "invalid_credentials") return "邮箱或密码不正确。";
  if (error.code === "account_disabled") return "账号已被管理员禁用。";
  if (error.status === 401) return "登录状态已过期，请重新登录。";
  if (error.status === 404) return "词条不存在或已经被删除，请重新加载。";
  if (error.status === 409 || error.code === "revision_conflict") return "另一设备已经更新了本轮进度，请重新读取后再继续。";
  if (error.status >= 500) return "服务器暂时异常，数据没有确认保存，请稍后重试。";
  return error.message || fallback;
};

const formatToday = (date = new Date()) =>
  new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(date);

const daysUntil = (targetDate: string) => {
  const [year, month, day] = targetDate.split("-").map(Number);
  if (!year || !month || !day) return null;
  const now = new Date();
  const todayAtUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const targetAtUtc = Date.UTC(year, month - 1, day);
  return Math.round((targetAtUtc - todayAtUtc) / (24 * 60 * 60 * 1000));
};

const countdownText = (countdown: CountdownSettings | null) => {
  if (!countdown) return null;
  const days = daysUntil(countdown.targetDate);
  if (days === null) return null;
  if (days === 0) return `${countdown.label}就在今天`;
  return days > 0 ? `距离${countdown.label}还有${days}天` : `${countdown.label}已过${Math.abs(days)}天`;
};

const speakWord = (word: string) => {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  utterance.rate = 0.86;
  window.speechSynthesis.speak(utterance);
};

const downloadTextFile = (content: string, filename: string, type = "application/json") => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

/**
 * 只用于不影响学习结果的清理操作（例如清掉已完成的旧草稿）。
 * 所有真正的保存/提交操作都必须由调用方 await 并显示失败状态。
 */
const ignoreCleanupFailure = (operation: Promise<unknown>) => {
  void operation.catch(() => undefined);
};

function PageShell({
  route,
  user,
  themeMode,
  onThemeChange,
  children,
  contentKey,
  storageStatus,
  onDownloadDamagedData,
  onStartFresh,
}: {
  route: Route;
  user: LocalUser | null;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  children: React.ReactNode;
  contentKey: string;
  storageStatus: ReturnType<typeof wordRepository.getStorageStatus>;
  onDownloadDamagedData: () => void;
  onStartFresh: () => void;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const previousRoute = useRef(route);
  const navigation: Array<{ route: Route; icon: string; label: string }> = [
    { route: "/", icon: "⌂", label: "今日" },
    { route: "/words", icon: "▤", label: "词库" },
    { route: "/profile", icon: "◎", label: "个人" },
  ];
  const isLogin = route === "/login";
  useEffect(() => {
    document.title = `${routeNames[route]} · CET 真题背词`;
    if (previousRoute.current !== route) {
      mainRef.current?.focus({ preventScroll: true });
      previousRoute.current = route;
    }
  }, [route]);

  return (
    <div className="app-shell min-h-screen bg-gradient-to-b from-blue-50 via-slate-50 to-amber-50/50 text-slate-900">
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus({ preventScroll: false })}>跳到主要内容</button>
      <header className="sticky top-0 z-10 border-b border-blue-100/80 bg-white/90 px-5 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="mx-auto flex items-center justify-between gap-3 max-w-3xl lg:max-w-5xl">
          <a href="#/" className="flex min-h-11 min-w-0 shrink items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-blue-700 text-sm text-white shadow-sm">C</span>
            <span className="truncate">CET 真题背词</span>
          </a>
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <ThemeMenu mode={themeMode} onChange={onThemeChange} />
            {!isLogin && (
              <a
                href="#/login"
                className="inline-flex min-h-11 max-w-[8rem] items-center truncate rounded-full bg-white px-3 text-xs text-slate-600 ring-1 ring-stone-200 sm:max-w-[10rem]"
              >
                {user ? user.email : "登录服务器账号"}
              </a>
            )}
          </div>
        </div>
      </header>
      <main
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        className={`mx-auto max-w-3xl px-5 pb-10 pt-10 focus:outline-none lg:max-w-5xl lg:px-7 ${isLogin ? "" : "pb-28 pt-7"}`}
      >
        {storageStatus && (
          <section className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950" role="alert">
            <p className="font-bold">本机数据需要处理</p>
            <p className="mt-1">{storageStatus.message}</p>
            {storageStatus.kind === "corrupt" && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={onDownloadDamagedData} className="button-secondary px-3 text-sm">下载保护副本</button>
                <button type="button" onClick={onStartFresh} className="button-quiet px-3 text-sm">确认后开始新档案</button>
              </div>
            )}
          </section>
        )}
        <div key={contentKey} className="route-transition-content">{children}</div>
      </main>
      {!isLogin && (
      <nav aria-label="主导航" className="fixed inset-x-0 bottom-0 z-20 border-t border-blue-100 bg-white/95 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
          <div className="mx-auto flex max-w-md items-center justify-around">
            {navigation.map((item) => {
              const isReviewRoute = route === "/review" || route === "/review/new" || route === "/review/review";
              const isNavActive = item.route === route || (item.route === "/" && isReviewRoute);
              return (
                <a
                  key={item.route}
                  href={`#${item.route}`}
                  aria-current={isNavActive ? "page" : undefined}
                  className={`bottom-nav-link flex min-h-12 min-w-14 flex-col items-center justify-center rounded-xl px-2 text-xs ${
                    isNavActive ? "bg-blue-50 font-semibold text-blue-800" : "text-slate-500"
                  }`}
                >
                  <span aria-hidden="true" className="text-lg leading-none">{item.icon}</span>
                  <span className="mt-1">{item.label}</span>
                </a>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}

const themeModeLabel: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "日间",
  dark: "夜间",
};

function ThemeMenu({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = "theme-menu";
  const options = ["system", "light", "dark"] as const;

  const focusOption = (index: number) => {
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    buttons?.[index]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => focusOption(Math.max(0, options.indexOf(mode))));
  }, [mode, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1 + buttons.length) % buttons.length;
    else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="theme-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`主题：${themeModeLabel[mode]}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span aria-hidden="true" className="text-base leading-none">{mode === "dark" ? "☾" : mode === "light" ? "☀" : "◐"}</span>
        <span className="hidden sm:inline">{themeModeLabel[mode]}</span>
      </button>
      {open && (
        <div id={menuId} className="theme-menu" role="menu" aria-label="选择主题" onKeyDown={handleMenuKeyDown}>
          <p className="theme-menu-title">显示主题</p>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option}
              className={`theme-option ${mode === option ? "bg-blue-50 text-blue-800" : "text-slate-600"}`}
              onClick={() => { onChange(option); setOpen(false); triggerRef.current?.focus(); }}
            >
              <span aria-hidden="true" className="w-5 text-center">{option === "dark" ? "☾" : option === "light" ? "☀" : "◐"}</span>
              <span>{themeModeLabel[option]}</span>
              {mode === option && <span aria-hidden="true" className="ml-auto text-blue-700">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useModalDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const unregister = modalManager.register({ dialog, onEscape: () => onCloseRef.current() });
    const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
    (focusable[0] ?? dialog).focus({ preventScroll: true });
    return () => {
      if (unregister() && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const onBackdropPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onCloseRef.current();
  };

  return { dialogRef, onBackdropPointerDown };
}

function AuthChecking() {
  return (
    <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100" role="status" aria-live="polite">
      <p className="text-sm text-slate-500">正在检查登录状态…</p>
    </section>
  );
}

function SignInRequired() {
  return (
    <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
      <p className="text-sm font-medium text-blue-700">需要服务器账号</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">登录服务器账号</h1>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500">
        登录后即可继续导入和复习。本系统不提供公开注册，账号由管理员创建；词库、学习进度和设置由服务器保存，可在已登录的设备间同步。
      </p>
      <a href="#/login" className="button-primary mt-6 inline-flex">
        登录服务器账号
      </a>
    </section>
  );
}

function HomeStudyIllustration() {
  return (
    <div className="home-study-visual" aria-hidden="true">
      <svg viewBox="0 0 720 260" role="presentation" focusable="false">
        <path className="home-visual-blob" d="M238 207c-58-6-109-28-114-66-5-36 37-50 74-57 47-9 60-53 118-58 54-4 77 31 116 34 53 4 88-28 133-5 39 20 29 57 56 76 25 18 31 52 5 76-34 31-113 22-167 22-77 0-149-13-221-22Z" />
        <g>
          <path d="M124 205c1-49 7-91 36-128" fill="none" stroke="#4cae81" strokeWidth="8" strokeLinecap="round" />
          <path d="M147 109c-32 1-47-17-46-40 30-1 47 14 46 40Z" fill="#72c49d" />
          <path d="M156 87c-6-29 7-48 32-57 8 27-2 49-32 57Z" fill="#5ab486" />
          <path d="M128 151c-31 5-51-9-57-33 30-7 50 7 57 33Z" fill="#83cca6" />
          <path d="M139 137c18-28 41-34 63-20-16 27-38 35-63 20Z" fill="#67ba8e" />
          <path d="M88 190h75l-8 50H97Z" fill="#d8e9fb" />
          <ellipse cx="126" cy="190" rx="38" ry="9" fill="#eef6ff" />
        </g>
        <g>
          <path d="M241 177h294c18 0 28 12 25 27l-5 27H241c-14 0-25-11-25-25v-4c0-14 11-25 25-25Z" fill="#dcecff" />
          <path d="M250 184h278c-7 12-8 25-2 39H250c-12 0-21-8-21-19s9-20 21-20Z" fill="#f7fbff" />
          <path d="M273 102h271c17 0 26 11 23 26l-6 43H273c-18 0-31-13-31-31v-7c0-18 13-31 31-31Z" fill="#3275eb" />
          <path d="M298 113h235c-8 15-9 29-3 46H298c-18 0-32-9-32-23s14-23 32-23Z" fill="#5e98f2" />
          <path d="M289 102c70-17 168-17 255 0l-17 16H300Z" fill="#75a8f7" />
          <text x="313" y="146" fill="#dcecff" fontSize="34" fontWeight="800">CET</text>
          <text x="280" y="211" fill="#77a8ee" fontSize="25" fontWeight="700">Better You</text>
        </g>
        <g transform="rotate(-7 588 160)">
          <rect x="548" y="112" width="112" height="116" rx="8" fill="#fff8dc" />
          <path d="M570 145h67M570 166h55M570 187h62" stroke="#4774c8" strokeWidth="5" strokeLinecap="round" opacity=".72" />
          <path d="M574 207c21-8 42-7 61-2" fill="none" stroke="#4774c8" strokeWidth="4" strokeLinecap="round" />
        </g>
        <ellipse cx="370" cy="241" rx="268" ry="13" fill="#c8dcf4" opacity=".45" />
      </svg>
    </div>
  );
}

function HomePage({ user, words, dueWords, onLoadDemo, onChanged }: { user: LocalUser; words: WordWithProgress[]; dueWords: WordWithProgress[]; onLoadDemo: () => Promise<void>; onChanged: () => void }) {
  const [groupsError, setGroupsError] = useState("");
  const [groupWordsError, setGroupWordsError] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupWordsOpen, setGroupWordsOpen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState("");
  const [dailyGroups, setDailyGroups] = useState(() => wordRepository.getDailyGroups(user.id));
  const [dailyGroupWords, setDailyGroupWords] = useState(() => wordRepository.getDailyGroupWords(user.id));
  useEffect(() => {
    setDailyGroups(wordRepository.getDailyGroups(user.id));
    setDailyGroupWords(wordRepository.getDailyGroupWords(user.id));
  }, [user.id]);
  const newCount = dueWords.filter((item) => memoryState(item) === "new").length;
  const reviewCount = dueWords.length - newCount;
  const totalReviewCount = words.filter((item) => {
    const state = memoryState(item);
    return state !== "new" && state !== "killed";
  }).length;
  const countGroups = (count: number) => count > 0 ? Math.ceil(count / dailyGroupWords) : 0;
  const newGroups = countGroups(newCount);
  const reviewGroups = countGroups(reviewCount);
  const totalReviewGroups = countGroups(totalReviewCount);
  const learnedCount = words.filter((item) => memoryState(item) !== "new").length;
  const learningRate = words.length === 0 ? 0 : Math.round((learnedCount / words.length) * 100);
  const dailyGoal = dailyGroups * dailyGroupWords;
  const totalNewCount = words.filter((item) => memoryState(item) === "new").length;
  const newWordsBelowPlan = totalNewCount > 0 && totalNewCount < dailyGoal;
  const countdown = wordRepository.getCountdown(user.id);
  const countdownDescription = countdownText(countdown);
  const statistics = useMemo(() => buildLearningStatistics(words, wordRepository.getLearningEvents(user.id)), [user.id, words]);

  const handleLoadDemo = async () => {
    if (demoBusy) return;
    setDemoBusy(true);
    setDemoError("");
    try {
      await onLoadDemo();
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : "示例词导入失败，请稍后重试。");
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className={`home-page ${words.length > 0 ? "home-page--focused" : ""}`}>
      <section className="home-welcome">
        <div className="home-welcome-header">
          <div>
            <p className="text-sm font-medium text-blue-700">你好，{user.email.split("@")[0]}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">今天准备好学习了吗？</h1>
            <p className="home-date">
              <time>{formatToday()}</time>
              {countdownDescription && <span className="home-countdown">{countdownDescription}</span>}
            </p>
          </div>
        </div>
      </section>

      <section className="home-course" aria-label="学习计划">
        <section className="home-study-card home-study-card--focused">
          <div className="home-study-card-header">
            <div className="min-w-0">
              <p className="home-study-eyebrow">今日学习计划</p>
              <h2 className="home-study-title">CET 4/6 真题词库</h2>
            </div>
            <div className="home-study-actions">
              <a href="#/statistics" className="home-icon-button home-statistics-button" aria-label="查看学习统计" title="学习统计">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V10M12 19V5M19 19v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </a>
              <button
                type="button"
                onClick={() => { setGroupsError(""); setGroupsOpen(true); }}
                className="home-icon-button home-plan-control"
                aria-label="修改每日组数"
                title="修改每日组数"
              >
                <span aria-hidden="true" className="home-plan-control-glyph">☷</span>
                <span className="home-plan-control-label">每日组数</span>
              </button>
              <button
                type="button"
                onClick={() => { setGroupWordsError(""); setGroupWordsOpen(true); }}
                className="home-icon-button home-plan-control"
                aria-label="修改每组词数"
                title="修改每组词数"
              >
                <span aria-hidden="true" className="home-plan-control-glyph">⚙</span>
                <span className="home-plan-control-label">每组词数</span>
              </button>
            </div>
          </div>

          <HomeStudyIllustration />

          <div className="home-progress-row">
            <div className="home-progress-track" role="progressbar" aria-label={`已学习 ${learnedCount} 个，共 ${words.length} 个词`} aria-valuetext={`${learnedCount} / ${words.length} 个词`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={learningRate}>
              <div className="home-progress-fill" style={{ width: `${learningRate}%` }} />
            </div>
            <p className="home-progress-count">{learnedCount} / {words.length} 词</p>
          </div>

          <p className="home-review-forecast">今日待复习 {statistics.reviewDueCount} 词 · 明日预计 {statistics.tomorrowCount} 词</p>

          <div className="home-action-row">
            <a href="#/spell" className="home-spell-button" aria-label="开始拼写练习">拼写</a>
            <a href="#/review/new" className="home-study-action" aria-label={`开始新学，今日 ${newGroups} 组，共 ${dailyGroups} 组`}>
              <span>新学</span>
              <span>{newGroups}/{dailyGroups} 组</span>
            </a>
            <a href="#/review/review" className="home-study-action" aria-label={`开始复习，今日 ${reviewGroups} 组，共 ${totalReviewGroups} 组`}>
              <span>复习</span>
              <span>{reviewGroups}/{totalReviewGroups} 组</span>
            </a>
          </div>
          {newWordsBelowPlan && (
            <p className="home-plan-note" role="status">
              新词仅剩 {totalNewCount} 个，少于今日计划 {dailyGoal} 个；今天按实际数量完成即可。
            </p>
          )}
        </section>
      </section>

      {words.length === 0 && (
        <section className="rounded-2xl border border-dashed border-blue-200 bg-white/90 p-5">
          <p className="font-semibold">还没有单词</p>
          <p className="mt-1 text-sm leading-6 text-slate-500">导入自己的 TSV，或加载 3 个示例词体验完整流程。</p>
          <div className="mt-4 flex gap-3">
            <a href="#/import" className="button-secondary">去导入</a>
            <button type="button" onClick={() => void handleLoadDemo()} disabled={demoBusy} className="button-quiet">{demoBusy ? "导入中…" : "加载示例"}</button>
          </div>
          {demoError && <p role="alert" className="mt-3 text-sm text-rose-600">{demoError}</p>}
        </section>
      )}
      {groupsOpen && (
        <DailyGroupsModal
          value={dailyGroups}
          groupWords={dailyGroupWords}
          wordCount={words.length}
          error={groupsError}
          onCancel={() => setGroupsOpen(false)}
          onSave={async (value) => {
            try {
              await wordRepository.setDailyGroups(user.id, value);
              setDailyGroups(value);
              setGroupsError("");
              setGroupsOpen(false);
              onChanged();
            } catch (error) {
              setGroupsError(apiErrorMessage(error, "组数未能保存，请检查网络和服务器状态后重试。"));
            }
          }}
        />
      )}
      {groupWordsOpen && (
        <DailyGroupWordsModal
          value={dailyGroupWords}
          groups={dailyGroups}
          error={groupWordsError}
          onCancel={() => setGroupWordsOpen(false)}
          onSave={async (value) => {
            try {
              await wordRepository.setDailyGroupWords(user.id, value);
              setDailyGroupWords(value);
              setGroupWordsError("");
              setGroupWordsOpen(false);
              onChanged();
            } catch (error) {
              setGroupWordsError(apiErrorMessage(error, "每组词数未能保存，请检查网络和服务器状态后重试。"));
            }
          }}
        />
      )}
    </div>
  );
}

function ProfilePage({ user, words, dueWords, onUserChanged }: { user: LocalUser; words: WordWithProgress[]; dueWords: WordWithProgress[]; onUserChanged: (user: LocalUser) => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [countdownOpen, setCountdownOpen] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const stateStats: Array<{ state: MemoryState; label: string; value: number; color: string }> = useMemo(() => {
    const counts: Record<MemoryState, number> = { new: 0, learning: 0, review: 0, mastered: 0, killed: 0 };
    words.forEach((item) => { counts[memoryState(item)] += 1; });
    return [
      { state: "new", label: "新词", value: counts.new, color: "bg-blue-500" },
      { state: "learning", label: "记忆中", value: counts.learning, color: "bg-amber-400" },
      { state: "review", label: "巩固中", value: counts.review, color: "bg-sky-500" },
      { state: "mastered", label: "已掌握", value: counts.mastered, color: "bg-emerald-500" },
      { state: "killed", label: "已斩", value: counts.killed, color: "bg-slate-500" },
    ];
  }, [words]);
  const maxCount = Math.max(...stateStats.map((item) => item.value), 1);
  const masteredCount = stateStats.find((item) => item.state === "mastered")?.value ?? 0;
  const completedToday = words.filter((item) => item.progress.lastReviewAt && new Date(item.progress.lastReviewAt).toDateString() === new Date().toDateString()).length;
  const masteryRate = words.length === 0 ? 0 : Math.round((masteredCount / words.length) * 100);
  const countdown = wordRepository.getCountdown(user.id);
  const countdownDescription = countdownText(countdown);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">个人中心</h1>
      <section className="flex items-center gap-4 rounded-3xl border border-blue-100 bg-white p-5 shadow-sm">
        <button
          type="button"
          onClick={() => { setProfileMessage(""); setSettingsOpen(true); }}
          className="profile-avatar-button grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-blue-50 text-3xl text-blue-700"
          aria-label="打开账号设置"
          title="账号设置"
        >
          {user.avatar ?? AVATAR_OPTIONS[0]}
        </button>
        <div className="min-w-0">
          <p className="truncate text-lg font-bold text-slate-900">{user.username ?? user.email.split("@")[0]}</p>
          <p className="mt-1 truncate text-sm text-slate-500">{user.email}</p>
        </div>
      </section>
      {profileMessage && <p className="rounded-2xl bg-blue-50 p-3 text-sm text-blue-800">{profileMessage}</p>}

      <section className="flex items-center justify-between gap-4 rounded-2xl border border-blue-100 bg-white/90 p-5">
        <div className="min-w-0">
          <p className="text-sm font-semibold">倒数日</p>
          {countdown ? (
            <>
              <p className="mt-1 truncate text-base font-bold text-slate-900">{countdown.label}</p>
              <p className="mt-1 text-sm text-slate-500">{countdown.targetDate} · {countdownDescription}</p>
            </>
          ) : (
            <p className="mt-1 text-sm leading-6 text-slate-500">设置六级、雅思、考研或任意目标日期。</p>
          )}
        </div>
        <button type="button" onClick={() => { setProfileMessage(""); setCountdownOpen(true); }} className="button-secondary shrink-0 px-3 text-sm">{countdown ? "修改" : "设置"}</button>
      </section>

      <section className="rounded-3xl border border-blue-100 bg-white/90 p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">记忆状态分布</p>
            <p className="mt-1 text-xs text-slate-500">柱高按当前词库中的数量相对显示。</p>
          </div>
          <p className="shrink-0 text-2xl font-bold text-blue-800">{words.length}<span className="ml-1 text-xs font-medium text-slate-500">个词</span></p>
        </div>
        <div className="mt-6 grid grid-cols-5 items-end gap-2 sm:gap-4" role="img" aria-label={stateStats.map((item) => `${item.label}${item.value}个`).join("，")}>
          {stateStats.map((item) => {
            const height = item.value === 0 ? 4 : Math.max(10, Math.round((item.value / maxCount) * 100));
            return (
              <div key={item.state} className="flex min-w-0 flex-col items-center gap-2">
                <span className="text-xs font-bold text-slate-700">{item.value}</span>
                <div className="flex h-44 w-full items-end rounded-2xl bg-slate-100 p-1.5 sm:h-52" aria-hidden="true">
                  <div className={`w-full rounded-xl ${item.color}`} style={{ height: `${height}%` }} />
                </div>
                <span className="truncate text-center text-xs font-medium text-slate-500">{item.label}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid grid-cols-3 gap-3">
        <ProfileStat label="已掌握率" value={`${masteryRate}%`} tone="blue" />
        <ProfileStat label="今日完成" value={`${completedToday}`} tone="amber" />
        <ProfileStat label="待处理" value={`${dueWords.length}`} tone="sky" />
      </section>

      <section className="rounded-2xl border border-blue-100 bg-white/90 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">词库设置</p>
            <p className="mt-1 text-sm leading-6 text-slate-500">导入带音标的 TSV，继续扩充你的学习词库。</p>
          </div>
          <a href="#/import" className="button-secondary shrink-0 px-3 text-sm">导入词库</a>
        </div>
      </section>
      {settingsOpen && (
        <AccountSettingsModal
          user={user}
          onCancel={() => setSettingsOpen(false)}
          onSaved={(nextUser) => {
            setSettingsOpen(false);
            setProfileMessage("账号资料已保存。");
            onUserChanged(nextUser);
          }}
        />
      )}
      {countdownOpen && (
        <CountdownSettingsModal
          value={countdown}
          onCancel={() => setCountdownOpen(false)}
          onSaved={async (nextCountdown) => {
            await wordRepository.setCountdown(user.id, nextCountdown);
            setCountdownOpen(false);
            setProfileMessage(nextCountdown ? "倒数日已保存。" : "倒数日已清除。");
            onUserChanged(user);
          }}
        />
      )}
    </div>
  );
}

function AccountSettingsModal({ user, onCancel, onSaved }: { user: LocalUser; onCancel: () => void; onSaved: (user: LocalUser) => void }) {
  const { dialogRef, onBackdropPointerDown } = useModalDialog(onCancel);
  const [profile, setProfile] = useState<LocalProfile>({
    username: user.username ?? user.email.split("@")[0],
    avatar: user.avatar ?? AVATAR_OPTIONS[0],
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      onSaved(await apiClient.updateProfile({
        username: profile.username.trim(),
        avatar: profile.avatar.trim() || null,
      }));
    } catch (saveError) {
      setError(apiErrorMessage(saveError, "账号资料保存失败，请检查网络后重试。"));
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const previous = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? AVATAR_OPTIONS.length - 1
        : (index + (previous ? -1 : 1) + AVATAR_OPTIONS.length) % AVATAR_OPTIONS.length;
    const avatar = AVATAR_OPTIONS[nextIndex];
    setProfile((current) => ({ ...current, avatar }));
    document.getElementById(`avatar-option-${nextIndex}`)?.focus();
  };

  return (
    <ModalPortal>
      <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="account-settings-title" aria-describedby="account-settings-description" onPointerDown={onBackdropPointerDown}>
      <section ref={dialogRef} tabIndex={-1} className="modal-panel max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-blue-700">个人资料</p>
            <h2 id="account-settings-title" className="mt-1 text-2xl font-bold tracking-tight">账号设置</h2>
            <p id="account-settings-description" className="sr-only">修改服务器账号的头像和用户名。</p>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} className="button-quiet px-3 text-sm" aria-label="关闭账号设置">关闭</button>
        </div>

        <div className="mt-6">
          <p className="text-sm font-semibold">选择头像</p>
          <div className="mt-3 grid grid-cols-6 gap-2" role="radiogroup" aria-label="选择头像">
            {AVATAR_OPTIONS.map((avatar, index) => (
              <button
                key={avatar}
                id={`avatar-option-${index}`}
                type="button"
                role="radio"
                aria-checked={profile.avatar === avatar}
                aria-label={`头像 ${index + 1}`}
                tabIndex={profile.avatar === avatar ? 0 : -1}
                onClick={() => setProfile((current) => ({ ...current, avatar }))}
                disabled={saving}
                onKeyDown={(event) => handleAvatarKeyDown(event, index)}
                className={`avatar-option grid aspect-square place-items-center rounded-2xl text-2xl ${profile.avatar === avatar ? "bg-blue-100 text-blue-700 ring-2 ring-blue-500" : "bg-blue-50 text-slate-500"}`}
              >
                {avatar}
              </button>
            ))}
          </div>
        </div>

        <label className="mt-5 block text-sm font-semibold">
          用户名
          <input
            value={profile.username}
            maxLength={24}
            onChange={(event) => setProfile((current) => ({ ...current, username: event.target.value }))}
            disabled={saving}
            className="input mt-2"
            placeholder="输入你的用户名"
          />
        </label>

        <label className="mt-4 block text-sm font-semibold">
          邮箱
          <input value={user.email} readOnly className="input mt-2 bg-slate-50 text-slate-500" />
          <span className="mt-1 block text-xs font-normal text-slate-400">邮箱来自服务器账号，当前版本不支持在这里修改。</span>
        </label>

        <div className="mt-4 rounded-2xl bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-700">修改密码</p>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs text-slate-500">暂不支持</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">密码由服务器账号管理，这个页面不保存也不修改密码。</p>
        </div>

        {error && <p role="alert" className="mt-4 text-sm text-rose-600">{error}</p>}
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={onCancel} disabled={saving} className="button-secondary flex-1">取消</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="button-primary flex-1">{saving ? "保存中…" : "保存资料"}</button>
        </div>
      </section>
      </div>
    </ModalPortal>
  );
}

function formatDateValue(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function DateWheelColumn({ id, label, value, options, suffix, onChange, disabled = false }: { id: string; label: string; value: number; options: number[]; suffix: string; onChange: (value: number) => void; disabled?: boolean }) {
  const wheelRef = useRef<HTMLDivElement>(null);
  const itemHeight = 44;

  useEffect(() => {
    const index = Math.max(0, options.indexOf(value));
    if (wheelRef.current) wheelRef.current.scrollTop = index * itemHeight;
  }, [options, value]);

  const selectOption = (option: number, behavior: ScrollBehavior = getMotionScrollBehavior()) => {
    if (disabled) return;
    onChange(option);
    const index = options.indexOf(option);
    wheelRef.current?.scrollTo({ top: index * itemHeight, behavior });
  };

  const handleScroll = () => {
    if (disabled) return;
    const wheel = wheelRef.current;
    if (!wheel) return;
    const index = Math.max(0, Math.min(options.length - 1, Math.round(wheel.scrollTop / itemHeight)));
    if (options[index] !== value) onChange(options[index]);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const currentIndex = Math.max(0, options.indexOf(value));
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown" || event.key === "PageDown") nextIndex = Math.min(options.length - 1, currentIndex + 1);
    else if (event.key === "ArrowUp" || event.key === "PageUp") nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    else return;
    event.preventDefault();
    selectOption(options[nextIndex], "auto");
  };

  return (
    <div className="date-wheel-column">
      <div
        ref={wheelRef}
        className="date-wheel-scroll"
        role="listbox"
        aria-label={label}
        aria-activedescendant={`${id}-${value}`}
        tabIndex={0}
        aria-disabled={disabled}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >
        {options.map((option) => (
          <button
            type="button"
            id={`${id}-${option}`}
            key={option}
            role="option"
            aria-selected={option === value}
            tabIndex={-1}
            disabled={disabled}
            className={`date-wheel-option ${option === value ? "is-selected" : ""}`}
            onClick={() => selectOption(option)}
          >
            {option}<span>{suffix}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CountdownSettingsModal({ value, onCancel, onSaved }: { value: CountdownSettings | null; onCancel: () => void; onSaved: (value: CountdownSettings | null) => void | Promise<void> }) {
  const { dialogRef, onBackdropPointerDown } = useModalDialog(onCancel);
  const [label, setLabel] = useState(value?.label ?? "");
  const now = new Date();
  const defaultDate = formatDateValue(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const [targetDate, setTargetDate] = useState(value?.targetDate ?? defaultDate);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedYear, selectedMonth, selectedDay] = targetDate.split("-").map(Number);
  const yearOptions = useMemo(() => Array.from({ length: 101 }, (_, index) => 2000 + index), []);
  const monthOptions = useMemo(() => Array.from({ length: 12 }, (_, index) => index + 1), []);
  const dayOptions = useMemo(() => Array.from({ length: new Date(selectedYear, selectedMonth, 0).getDate() }, (_, index) => index + 1), [selectedMonth, selectedYear]);

  const updateDatePart = (year: number, month: number, day: number) => {
    const safeDay = Math.min(day, new Date(year, month, 0).getDate());
    setTargetDate(formatDateValue(year, month, safeDay));
    setError("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await onSaved({ label, targetDate });
    } catch (saveError) {
      setError(apiErrorMessage(saveError, "倒数日保存失败，请重试。"));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSaved(null);
    } catch (clearError) {
      setError(apiErrorMessage(clearError, "倒数日清除失败，请重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal>
      <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="countdown-settings-title" aria-describedby="countdown-settings-description" onPointerDown={onBackdropPointerDown}>
      <section ref={dialogRef} tabIndex={-1} className="modal-panel w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-blue-700">个人目标</p>
            <h2 id="countdown-settings-title" className="mt-1 text-2xl font-bold tracking-tight">设置倒数日</h2>
            <p id="countdown-settings-description" className="mt-2 text-sm leading-6 text-slate-500">例如“六级考试”“雅思考试”或“考研初试”。剩余天数会按本地日期每天更新。</p>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} className="button-quiet px-3 text-sm" aria-label="关闭倒数日设置">关闭</button>
        </div>
        <form className="mt-6 space-y-4" onSubmit={save}>
          <label className="block text-sm font-semibold">
            目标名称
            <input value={label} maxLength={32} onChange={(event) => setLabel(event.target.value)} disabled={saving} className="input mt-2" placeholder="例如：六级考试" autoComplete="off" />
          </label>
          <fieldset className="countdown-date-fieldset">
            <legend className="text-sm font-semibold">目标日期</legend>
            <div className="countdown-date-wheel" aria-label={`目标日期：${selectedYear}年${selectedMonth}月${selectedDay}日`}>
              <div className="date-wheel-selection" aria-hidden="true" />
              <DateWheelColumn id="countdown-year" label="选择年份" value={selectedYear} options={yearOptions} suffix="年" disabled={saving} onChange={(year) => updateDatePart(year, selectedMonth, selectedDay)} />
              <DateWheelColumn id="countdown-month" label="选择月份" value={selectedMonth} options={monthOptions} suffix="月" disabled={saving} onChange={(month) => updateDatePart(selectedYear, month, selectedDay)} />
              <DateWheelColumn id="countdown-day" label="选择日期" value={selectedDay} options={dayOptions} suffix="日" disabled={saving} onChange={(day) => updateDatePart(selectedYear, selectedMonth, day)} />
            </div>
          </fieldset>
          {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
          {value && <button type="button" onClick={() => void clear()} disabled={saving} className="button-quiet w-full text-sm text-rose-600">{saving ? "保存中…" : "清除倒数日"}</button>}
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={onCancel} disabled={saving} className="button-secondary">取消</button>
            <button type="submit" disabled={saving} className="button-primary">{saving ? "保存中…" : "保存"}</button>
          </div>
        </form>
      </section>
      </div>
    </ModalPortal>
  );
}

function DailyGroupsModal({ value, groupWords, wordCount, error, onCancel, onSave }: { value: number; groupWords: number; wordCount: number; error: string; onCancel: () => void; onSave: (value: number) => void | Promise<void> }) {
  const { dialogRef, onBackdropPointerDown } = useModalDialog(onCancel);
  const [selected, setSelected] = useState(value);
  const options = Array.from({ length: 20 }, (_, index) => index + 1);
  const wheelRef = useRef<HTMLDivElement>(null);
  const wheelItemHeight = 52;
  const [saving, setSaving] = useState(false);
  const completionDays = (groups: number) => wordCount === 0 ? 0 : Math.ceil(wordCount / (groups * groupWords));

  useEffect(() => {
    const wheel = wheelRef.current;
    if (!wheel) return;
    wheel.scrollTop = (value - 1) * wheelItemHeight;
    const syncSelected = () => {
      const nextIndex = Math.max(0, Math.min(options.length - 1, Math.round(wheel.scrollTop / wheelItemHeight)));
      setSelected(nextIndex + 1);
    };
    wheel.addEventListener("scroll", syncSelected, { passive: true });
    syncSelected();
    return () => wheel.removeEventListener("scroll", syncSelected);
  }, [value, options.length]);

  const selectOption = (option: number, behavior: ScrollBehavior = getMotionScrollBehavior()) => {
    setSelected(option);
    wheelRef.current?.scrollTo({ top: (option - 1) * wheelItemHeight, behavior });
  };

  const handleWheelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (saving) return;
    let next = selected;
    if (event.key === "ArrowDown" || event.key === "PageDown") next = Math.min(options.length, selected + 1);
    else if (event.key === "ArrowUp" || event.key === "PageUp") next = Math.max(1, selected - 1);
    else if (event.key === "Home") next = 1;
    else if (event.key === "End") next = options.length;
    else return;
    event.preventDefault();
    selectOption(next, "auto");
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(selected);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal>
      <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="daily-groups-title" aria-describedby="daily-groups-description" onPointerDown={onBackdropPointerDown}>
      <section ref={dialogRef} tabIndex={-1} className="modal-panel max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-blue-700">调整每日学习计划</p>
            <h2 id="daily-groups-title" className="mt-1 text-2xl font-bold tracking-tight">调整计划</h2>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} className="button-quiet px-3 text-sm" aria-label="关闭设置">关闭</button>
        </div>
        <p id="daily-groups-description" className="mt-3 text-sm leading-6 text-slate-500">每组按 {groupWords} 个词计算，到期旧词优先安排；右侧天数按当前词库 {wordCount} 个词估算。</p>
        <div className="mt-5 grid grid-cols-2 border-b border-slate-200 px-4 pb-3 text-center text-sm font-semibold text-slate-700">
          <span>每日组数（每组 {groupWords} 词）</span>
          <span>完成天数</span>
        </div>
        <div className="relative mt-5" aria-label="每日学习组数">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-0 h-[52px] -translate-y-1/2 border-y border-blue-200 bg-blue-100/90" />
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-24 rounded-t-3xl bg-gradient-to-b from-white via-white/85 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-24 rounded-b-3xl bg-gradient-to-t from-white via-white/85 to-transparent" />
          <div
            ref={wheelRef}
            className="daily-groups-wheel relative z-10 h-[260px] snap-y snap-mandatory overflow-y-auto overscroll-contain rounded-3xl border border-blue-100"
            style={{ paddingTop: 104, paddingBottom: 104 }}
            role="listbox"
            aria-label="选择每天背词组数"
            aria-activedescendant={`daily-groups-option-${selected}`}
            tabIndex={0}
            onKeyDown={handleWheelKeyDown}
          >
            {options.map((option) => (
              <button
                type="button"
                key={option}
                id={`daily-groups-option-${option}`}
                onClick={() => selectOption(option)}
                disabled={saving}
                tabIndex={-1}
                className={`wheel-option grid h-[52px] w-full snap-center grid-cols-2 items-center px-4 text-center ${selected === option ? "text-2xl font-bold text-blue-900" : "text-lg font-medium text-slate-400"}`}
                role="option"
                aria-selected={selected === option}
              >
                <span>{option} 组</span>
                <span className={`text-xl font-semibold ${selected === option ? "text-blue-900" : "text-slate-400"}`}>{completionDays(option)} 天</span>
              </button>
            ))}
          </div>
        </div>
        <p className="mt-4 text-center text-sm text-slate-500">每天 {selected} 组，共 {selected * groupWords} 个词，预计 {completionDays(selected)} 天完成当前词库。</p>
        {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
        <button type="button" onClick={() => void save()} disabled={saving} className="button-primary mt-5 w-full">{saving ? "保存中…" : "保存计划"}</button>
      </section>
      </div>
    </ModalPortal>
  );
}

function DailyGroupWordsModal({ value, groups, error, onCancel, onSave }: { value: number; groups: number; error: string; onCancel: () => void; onSave: (value: number) => void | Promise<void> }) {
  const { dialogRef, onBackdropPointerDown } = useModalDialog(onCancel);
  const [selected, setSelected] = useState(value);
  const options = Array.from({ length: 20 }, (_, index) => index + 1);
  const wheelRef = useRef<HTMLDivElement>(null);
  const wheelItemHeight = 52;
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const wheel = wheelRef.current;
    if (!wheel) return;
    wheel.scrollTop = (value - 1) * wheelItemHeight;
    const syncSelected = () => {
      const nextIndex = Math.max(0, Math.min(options.length - 1, Math.round(wheel.scrollTop / wheelItemHeight)));
      setSelected(nextIndex + 1);
    };
    wheel.addEventListener("scroll", syncSelected, { passive: true });
    syncSelected();
    return () => wheel.removeEventListener("scroll", syncSelected);
  }, [value, options.length]);

  const selectOption = (option: number, behavior: ScrollBehavior = getMotionScrollBehavior()) => {
    setSelected(option);
    wheelRef.current?.scrollTo({ top: (option - 1) * wheelItemHeight, behavior });
  };

  const handleWheelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (saving) return;
    let next = selected;
    if (event.key === "ArrowDown" || event.key === "PageDown") next = Math.min(options.length, selected + 1);
    else if (event.key === "ArrowUp" || event.key === "PageUp") next = Math.max(1, selected - 1);
    else if (event.key === "Home") next = 1;
    else if (event.key === "End") next = options.length;
    else return;
    event.preventDefault();
    selectOption(next, "auto");
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(selected);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal>
      <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="daily-group-words-title" aria-describedby="daily-group-words-description" onPointerDown={onBackdropPointerDown}>
      <section ref={dialogRef} tabIndex={-1} className="modal-panel max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-blue-700">调整每日学习计划</p>
            <h2 id="daily-group-words-title" className="mt-1 text-2xl font-bold tracking-tight">调整每组词数</h2>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} className="button-quiet px-3 text-sm" aria-label="关闭设置">关闭</button>
        </div>
        <p id="daily-group-words-description" className="mt-3 text-sm leading-6 text-slate-500">每组可设置 1—20 个词；当前每天 {groups} 组，调整后今日上限为 {groups * selected} 个词。</p>
        <div className="mt-5 border-b border-slate-200 px-4 pb-3 text-center text-sm font-semibold text-slate-700">
          <span>每组词数（最多 20）</span>
        </div>
        <div className="relative mt-5" aria-label="每组词数设置">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-0 h-[52px] -translate-y-1/2 border-y border-blue-200 bg-blue-100/90" />
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-24 rounded-t-3xl bg-gradient-to-b from-white via-white/85 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-24 rounded-b-3xl bg-gradient-to-t from-white via-white/85 to-transparent" />
          <div
            ref={wheelRef}
            className="daily-groups-wheel relative z-10 h-[260px] snap-y snap-mandatory overflow-y-auto overscroll-contain rounded-3xl border border-blue-100"
            style={{ paddingTop: 104, paddingBottom: 104 }}
            role="listbox"
            aria-label="选择每组单词数"
            aria-activedescendant={`daily-group-words-option-${selected}`}
            tabIndex={0}
            onKeyDown={handleWheelKeyDown}
          >
            {options.map((option) => (
              <button
                type="button"
                key={option}
                id={`daily-group-words-option-${option}`}
                onClick={() => selectOption(option)}
                disabled={saving}
                tabIndex={-1}
                className={`wheel-option grid h-[52px] w-full snap-center grid-cols-1 items-center px-4 text-center ${selected === option ? "text-2xl font-bold text-blue-900" : "text-lg font-medium text-slate-400"}`}
                role="option"
                aria-selected={selected === option}
              >
                <span>{option} 个</span>
              </button>
            ))}
          </div>
        </div>
        <p className="mt-4 text-center text-sm text-slate-500">每天 {groups} 组，每组 {selected} 个，共 {groups * selected} 个词。</p>
        {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
        <button type="button" onClick={() => void save()} disabled={saving} className="button-primary mt-5 w-full">{saving ? "保存中…" : "保存计划"}</button>
      </section>
      </div>
    </ModalPortal>
  );
}

function LoginPage({ user, onLogin, onLogout, notice = "" }: { user: LocalUser | null; onLogin: (email: string, password: string) => Promise<void>; onLogout: () => Promise<void>; notice?: string }) {
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  // 异步回调可能在组件卸载后返回：用 ref 拦住卸载后的状态写入。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (notice) setError(notice);
  }, [notice]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("请输入格式正确的邮箱。");
      return;
    }
    if (!password) {
      setError("请输入密码。");
      return;
    }
    setError("");
    setBusy("login");
    try {
      await onLogin(email.trim(), password);
      if (!mountedRef.current) return;
      setPassword("");
    } catch (loginError) {
      if (!mountedRef.current) return;
      setError(apiErrorMessage(loginError, "登录失败，请稍后重试。"));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const logout = async () => {
    if (busy) return;
    setError("");
    setBusy("logout");
    try {
      await onLogout();
    } catch (logoutError) {
      if (!mountedRef.current) return;
      setError(apiErrorMessage(logoutError, "退出登录失败，请稍后重试。"));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <a href="#/" className="inline-flex min-h-11 items-center text-sm text-slate-500">← 返回首页</a>
      <section className="mt-7 rounded-3xl bg-white p-7 shadow-card ring-1 ring-stone-100">
        <p className="text-sm font-medium text-blue-700">服务器账号登录</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">登录后继续背真题词汇</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          使用已有的服务器账号登录，登录状态由服务器保存。本系统不提供公开注册，账号由管理员创建。
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            邮箱
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              className="input mt-2"
              disabled={busy === "login"}
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="input mt-2"
              disabled={busy === "login"}
            />
          </label>
          {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
          <button className="button-primary w-full" type="submit" disabled={busy !== null}>
            {busy === "login" ? "登录中…" : "登录"}
          </button>
        </form>
        <p className="mt-3 text-xs leading-5 text-slate-400">
          登录后词库、学习进度和设置由服务器保存，可在已登录的设备间同步。
        </p>
        {user && (
          <button
            type="button"
            onClick={logout}
            disabled={busy !== null}
            className="inline-flex min-h-11 w-full items-center justify-center text-sm text-slate-500 underline underline-offset-4"
          >
            {busy === "logout" ? "正在退出…" : "退出登录"}
          </button>
        )}
      </section>
    </div>
  );
}

function ImportPage({ user, words, onImported }: { user: LocalUser; words: WordWithProgress[]; onImported: () => void }) {
  const [mode, setMode] = useState<"batch" | "manual">("batch");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const [importBusy, setImportBusy] = useState<"batch" | "manual" | null>(null);
  const [manual, setManual] = useState<WordInput>({
    word: "", phonetic: "", meaning: "", phrase: "", sentence: "", sentenceCn: "", source: "", type: "marked",
  });
  const parsed = useMemo(() => parseTsv(value), [value]);
  const existingWords = useMemo(() => new Set(words.map((item) => item.word)), [words]);
  const existing = parsed.rows.filter((row) => existingWords.has(row.word)).length;
  const placeholder = "word\tphonetic\tmeaning\tphrase\tsentence\tsentence_cn\tsource\ttype";

  const confirmImport = async () => {
    if (importBusy) return;
    if (parsed.errors.length > 0 || parsed.rows.length === 0) return;
    setImportBusy("batch");
    try {
      const result = await wordRepository.importWords(user.id, parsed.rows);
      setMessage(`已完成导入：新增 ${result.added} 个，更新已有 ${result.existing} 个；原有学习进度没有被重置。`);
      setValue("");
      onImported();
    } catch (error) {
      setMessage(apiErrorMessage(error, "导入失败，请检查网络和服务器状态。"));
    } finally {
      setImportBusy(null);
    }
  };

  const addManualWord = async (event: FormEvent) => {
    event.preventDefault();
    if (importBusy) return;
    const word = manual.word.trim().toLowerCase();
    if (!word) {
      setMessage("请先填写英文单词。");
      return;
    }
    if (!/^[a-z][a-z'-]*$/.test(word)) {
      setMessage("英文单词应为词典原形，只能包含字母、连字符或撇号。");
      return;
    }
    if (!/^\/[^/]+\/$/.test(manual.phonetic.trim())) {
      setMessage("请填写带斜杠的 IPA 音标，例如 /ˈæləkeɪt/。");
      return;
    }
    if (!manual.meaning.trim()) {
      setMessage("请填写词性 + 中文释义，例如 v. 分配；拨出。");
      return;
    }
    const cleanedManual = Object.fromEntries(
      Object.entries({ ...manual, word }).map(([key, fieldValue]) => [key, typeof fieldValue === "string" ? fieldValue.trim() : fieldValue]),
    ) as WordInput;
    setImportBusy("manual");
    try {
      const result = await wordRepository.importWords(user.id, [cleanedManual]);
      setMessage(result.added ? `已添加 ${word}，现在会进入今日学习任务。` : `已更新 ${word}；原有学习进度没有被重置。`);
      setManual({ word: "", phonetic: "", meaning: "", phrase: "", sentence: "", sentenceCn: "", source: "", type: "marked" });
      onImported();
    } catch (error) {
      setMessage(apiErrorMessage(error, "添加失败，请检查网络和服务器状态。"));
    } finally {
      setImportBusy(null);
    }
  };

  const loadLocalFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      setMessage("单次文件不能超过 1 MB，请分批导入。");
      return;
    }
    try {
      setValue(await file.text());
      setMessage("");
    } catch {
      setMessage("文件读取失败，请改用复制粘贴。");
    }
  };

  const setManualField = <K extends keyof WordInput>(field: K, next: WordInput[K]) => {
    setManual((previous) => ({ ...previous, [field]: next }));
    setMessage("");
  };

  const selectImportMode = (nextMode: "batch" | "manual") => {
    setMode(nextMode);
    setMessage("");
  };

  const handleImportTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextMode = event.key === "ArrowLeft" || event.key === "Home" ? "batch" : "manual";
    selectImportMode(nextMode);
    window.requestAnimationFrame(() => document.getElementById(`import-tab-${nextMode}`)?.focus());
  };

  const copyGptPrompt = async () => {
    try {
      await navigator.clipboard.writeText(GPT_PHOTO_PROMPT);
      setPromptCopied(true);
      setMessage("");
    } catch {
      setMessage("提示词复制失败，请展开后手动全选复制。");
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm font-medium text-blue-700">添加真题词汇</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">把单词放进自己的学习队列</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">拍照交给 GPT 识别，或手动添加单词；所有导入词都带 IPA 音标，重复词只更新内容、不重置学习进度。</p>
      </section>

      <section className="overflow-hidden rounded-3xl border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-amber-50 p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">拍照识词助手</p>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-900">复制提示词，连同照片发给 GPT</h2>
          </div>
          <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">含 2 个示例</span>
        </div>
        <ol className="mt-4 grid gap-2 text-sm leading-6 text-slate-600 sm:grid-cols-3">
          <li className="rounded-xl bg-white/80 px-3 py-2"><strong className="text-blue-700">1.</strong> 拍摄真题或单词笔记</li>
          <li className="rounded-xl bg-white/80 px-3 py-2"><strong className="text-blue-700">2.</strong> 照片和提示词一起发给 GPT</li>
          <li className="rounded-xl bg-white/80 px-3 py-2"><strong className="text-blue-700">3.</strong> 复制 GPT 结果到下方导入</li>
        </ol>
        <button type="button" onClick={() => void copyGptPrompt()} className="button-primary mt-4 w-full">
          {promptCopied ? "已复制，可去发送照片" : "复制 GPT 图片识别提示词"}
        </button>
        <details className="mt-3 rounded-xl bg-white/75 text-sm ring-1 ring-blue-100">
          <summary className="cursor-pointer px-4 py-3 font-medium text-blue-800">查看完整提示词和两个正确示例</summary>
          <div className="border-t border-blue-100 p-3">
            <textarea readOnly value={GPT_PHOTO_PROMPT} aria-label="GPT 图片识别提示词" className="min-h-96 w-full resize-y rounded-lg border border-stone-200 bg-white p-3 font-mono text-xs leading-6 text-slate-600 outline-none focus:border-blue-400" />
          </div>
        </details>
      </section>

      <div className="grid grid-cols-2 rounded-2xl bg-blue-50 p-1" role="tablist" aria-label="添加方式">
        <button id="import-tab-batch" type="button" role="tab" aria-selected={mode === "batch"} aria-controls="batch-import-panel" tabIndex={mode === "batch" ? 0 : -1} onClick={() => selectImportMode("batch")} onKeyDown={handleImportTabKeyDown} className={`import-tab min-h-11 rounded-xl text-sm font-semibold ${mode === "batch" ? "bg-white text-blue-800 shadow-sm" : "text-slate-500"}`}>批量导入</button>
        <button id="import-tab-manual" type="button" role="tab" aria-selected={mode === "manual"} aria-controls="manual-import-panel" tabIndex={mode === "manual" ? 0 : -1} onClick={() => selectImportMode("manual")} onKeyDown={handleImportTabKeyDown} className={`import-tab min-h-11 rounded-xl text-sm font-semibold ${mode === "manual" ? "bg-white text-blue-800 shadow-sm" : "text-slate-500"}`}>手动添加</button>
      </div>

      {mode === "batch" ? (
        <div id="batch-import-panel" role="tabpanel" aria-labelledby="import-tab-batch">
          <section className="rounded-2xl border border-stone-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">固定导入格式</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">仅支持含音标的 8 列 TSV；音标须为 /.../ 格式，meaning 写成“词性 + 中文释义”，例如 v. 分配；拨出。</p>
              </div>
              <span className="shrink-0 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">含音标 · 8 列</span>
            </div>
            <p className="mt-3 break-all rounded-xl bg-stone-50 p-3 font-mono text-[11px] leading-5 text-slate-500">{placeholder}</p>
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <label htmlFor="tsv" className="text-sm font-semibold">粘贴 TSV 内容</label>
              <div className="flex items-center gap-3">
                <label className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-blue-700 underline underline-offset-4">
                  选择 .tsv 文件
                  <input type="file" accept=".tsv,.txt,text/tab-separated-values,text/plain" className="sr-only" onChange={(event) => { void loadLocalFile(event.target.files?.[0]); event.target.value = ""; }} />
                </label>
                <button type="button" onClick={() => { setValue(SAMPLE_TSV_WITH_PHONETIC); setMessage(""); }} className="inline-flex min-h-11 items-center text-sm font-medium text-blue-700 underline underline-offset-4">填入含音标示例</button>
              </div>
            </div>
            <textarea
              id="tsv"
              value={value}
              onChange={(event) => { setValue(event.target.value); setMessage(""); }}
              placeholder={placeholder}
              className="tsv-input min-h-64 w-full resize-y rounded-xl border border-blue-100 bg-blue-50/50 p-3 font-mono text-xs leading-6 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              spellCheck="false"
            />
          </section>

          {value && (
            <section className="space-y-3">
              {parsed.errors.length > 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <p className="font-semibold">暂时无法导入</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">{parsed.errors.map((error) => <li key={error}>{error}</li>)}</ul>
                </div>
              ) : (
                <>
                  <div className="rounded-2xl bg-blue-50 p-4 text-sm text-blue-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold">校验通过</p>
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs">含音标 8 列</span>
                    </div>
                    <p className="mt-2">准备导入：{parsed.rows.length} · 新增：{parsed.rows.length - existing} · 更新：{existing}</p>
                    {parsed.duplicateLines > 0 && <p className="mt-1 text-blue-800">本次内容内合并了 {parsed.duplicateLines} 行重复词，marked 优先保留。</p>}
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
                    <div className="border-b border-stone-100 px-4 py-3 text-sm font-semibold">导入预览</div>
                    <div className="divide-y divide-stone-100">
                      {parsed.rows.slice(0, 6).map((row) => (
                        <div key={row.word} className="px-4 py-3">
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <div className="min-w-0 break-words"><strong className="break-words text-base [overflow-wrap:anywhere]">{row.word}</strong>{row.phonetic && <span className="ml-2 break-words font-mono text-xs text-blue-700 [overflow-wrap:anywhere]">{row.phonetic}</span>}</div>
                            <span className={`tag ${row.type === "marked" ? "tag-marked" : "tag-added"}`}>{typeLabel(row.type)}</span>
                          </div>
                          <p className="mt-1 text-sm text-slate-600">{row.meaning || "（未填写释义）"}</p>
                          {row.source && <p className="mt-1 text-xs text-slate-400">{row.source}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <button type="button" onClick={() => void confirmImport()} disabled={importBusy !== null} className="button-primary w-full">{importBusy === "batch" ? "导入中…" : `确认导入 ${parsed.rows.length} 个词`}</button>
                </>
              )}
            </section>
          )}
        </div>
      ) : (
        <form id="manual-import-panel" role="tabpanel" aria-labelledby="import-tab-manual" onSubmit={addManualWord} className="space-y-4 rounded-2xl border border-stone-200 bg-white p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="英文单词 *"><input value={manual.word} onChange={(event) => setManualField("word", event.target.value)} placeholder="allocate" className="input mt-2" autoCapitalize="none" autoCorrect="off" /></Field>
            <Field label="IPA 音标 *"><input required value={manual.phonetic} onChange={(event) => setManualField("phonetic", event.target.value)} placeholder="/ˈæləkeɪt/" className="input mt-2 font-mono" /></Field>
          </div>
          <Field label="词性 + 中文释义 *"><input required value={manual.meaning} onChange={(event) => setManualField("meaning", event.target.value)} placeholder="v. 分配；拨出" className="input mt-2" /></Field>
          <Field label="常用搭配"><input value={manual.phrase} onChange={(event) => setManualField("phrase", event.target.value)} placeholder="allocate resources" className="input mt-2" /></Field>
          <Field label="英文真题句"><textarea value={manual.sentence} onChange={(event) => setManualField("sentence", event.target.value)} className="input mt-2 min-h-24 py-3" /></Field>
          <Field label="中文翻译"><textarea value={manual.sentenceCn} onChange={(event) => setManualField("sentenceCn", event.target.value)} className="input mt-2 min-h-24 py-3" /></Field>
          <Field label="来源"><input value={manual.source} onChange={(event) => setManualField("source", event.target.value)} placeholder="2025-12 CET6 阅读1" className="input mt-2" /></Field>
          <div>
            <p className="text-sm font-medium text-slate-700">词汇来源类型</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setManualField("type", "marked")} className={`tap-feedback min-h-11 rounded-xl text-sm font-medium ring-1 ${manual.type === "marked" ? "bg-amber-50 text-amber-900 ring-amber-300" : "bg-white text-slate-600 ring-stone-200"}`}>我标记的</button>
              <button type="button" onClick={() => setManualField("type", "added")} className={`tap-feedback min-h-11 rounded-xl text-sm font-medium ring-1 ${manual.type === "added" ? "bg-blue-50 text-blue-800 ring-blue-300" : "bg-white text-slate-600 ring-stone-200"}`}>AI 补充</button>
            </div>
          </div>
          <button type="submit" disabled={importBusy !== null} className="button-primary w-full">{importBusy === "manual" ? "添加中…" : "添加到今日学习"}</button>
        </form>
      )}

      {message && <p role="status" aria-live="polite" className="rounded-2xl bg-blue-50 p-4 text-sm leading-6 text-blue-800">{message}</p>}
    </div>
  );
}

function WordsPage({ user, words, todayWords, onChanged }: { user: LocalUser; words: WordWithProgress[]; todayWords: WordWithProgress[]; onChanged: () => void }) {
  const [keyword, setKeyword] = useState("");
  const deferredKeyword = useDeferredValue(keyword);
  const [openId, setOpenId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<WordListFilter>("all");
  const [allMeaningsVisible, setAllMeaningsVisible] = useState(false);
  const [revealedMeaningIds, setRevealedMeaningIds] = useState<Set<string>>(() => new Set());
  const [undoWord, setUndoWord] = useState<{ id: string; word: string } | null>(null);
  const [pendingKill, setPendingKill] = useState<WordWithProgress | null>(null);
  const [dataMessage, setDataMessage] = useState("");
  const [editing, setEditing] = useState<{ id: string; phonetic: string; meaning: string } | null>(null);
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const [batchManaging, setBatchManaging] = useState(false);
  const [selectedWordIds, setSelectedWordIds] = useState<Set<string>>(() => new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const automaticBackup = wordRepository.getAutomaticBackup(user.id);
  const missingPhoneticCount = words.filter((item) => !item.phonetic.trim()).length;
  const libraryCounts = useMemo(() => {
    const counts: Record<MemoryState, number> = { new: 0, learning: 0, review: 0, mastered: 0, killed: 0 };
    words.forEach((item) => { counts[memoryState(item)] += 1; });
    return counts;
  }, [words]);
  const dueCount = words.filter((item) => !item.progress.killedAt && new Date(item.progress.nextReviewAt).getTime() <= Date.now()).length;
  const todayWordIds = useMemo(() => new Set(todayWords.map((item) => item.id)), [todayWords]);
  const wordFilterOptions: Array<{ id: WordListFilter; label: string; count: number }> = [
    { id: "all", label: wordListFilterLabels.all, count: words.length },
    { id: "today", label: wordListFilterLabels.today, count: todayWords.length },
    { id: "new", label: wordListFilterLabels.new, count: libraryCounts.new },
    { id: "learning", label: wordListFilterLabels.learning, count: libraryCounts.learning + libraryCounts.review },
    { id: "mastered", label: wordListFilterLabels.mastered, count: libraryCounts.mastered },
    { id: "killed", label: wordListFilterLabels.killed, count: libraryCounts.killed },
  ];
  const scopedWords = useMemo(
    () => filterWordGroup(words, stateFilter, todayWordIds),
    [stateFilter, todayWordIds, words],
  );
  const filtered = useMemo(() => {
    const normalizedKeyword = deferredKeyword.trim().toLowerCase();
    return scopedWords.filter((item) =>
      `${item.word} ${item.phonetic} ${item.meaning} ${item.source}`.toLowerCase().includes(normalizedKeyword),
    );
  }, [deferredKeyword, scopedWords]);
  const allFilteredSelected = filtered.length > 0 && filtered.every((item) => selectedWordIds.has(item.id));
  const selectionScopeLabel = keyword.trim() ? "当前搜索结果" : `当前${wordListFilterLabels[stateFilter]}分组`;

  const remove = async (item: WordWithProgress) => {
    if (mutationBusy) return;
    if (!window.confirm(`确定删除 “${item.word}” 吗？该词的学习进度也会一并删除。`)) return;
    setMutationBusy(`delete:${item.id}`);
    try {
      await wordRepository.deleteWord(user.id, item.id);
      setUndoWord(null);
      setSelectedWordIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      onChanged();
    } catch (error) {
      setDataMessage(apiErrorMessage(error, "删除失败，请检查网络和服务器状态。"));
      if (error instanceof ApiError && error.status === 404) onChanged();
    } finally {
      setMutationBusy(null);
    }
  };

  const kill = (item: WordWithProgress) => {
    setPendingKill(item);
  };

  const confirmKill = async () => {
    if (mutationBusy) return;
    const item = pendingKill;
    if (!item) return;
    setMutationBusy(`kill:${item.id}`);
    try {
      if (!await wordRepository.killWord(user.id, item.id)) return;
      setUndoWord({ id: item.id, word: item.word });
      setPendingKill(null);
      setOpenId(null);
      onChanged();
    } catch (error) {
      setDataMessage(apiErrorMessage(error, "斩词失败，请检查网络和服务器状态。"));
      if (error instanceof ApiError && error.status === 404) onChanged();
    } finally {
      setMutationBusy(null);
    }
  };

  const restore = async (item: WordWithProgress) => {
    if (mutationBusy) return;
    setMutationBusy(`restore:${item.id}`);
    try {
      if (!await wordRepository.restoreWord(user.id, item.id)) return;
      setUndoWord(null);
      setOpenId(null);
      onChanged();
    } catch (error) {
      setDataMessage(apiErrorMessage(error, "恢复失败，请检查网络和服务器状态。"));
      if (error instanceof ApiError && error.status === 404) onChanged();
    } finally {
      setMutationBusy(null);
    }
  };

  const undoKill = async () => {
    if (mutationBusy) return;
    setMutationBusy("undo-kill");
    try {
      if (!undoWord || !await wordRepository.undoKillWord(user.id, undoWord.id)) return;
      setUndoWord(null);
      onChanged();
    } catch (error) {
      setDataMessage(apiErrorMessage(error, "撤销失败，请检查网络和服务器状态。"));
      if (error instanceof ApiError && error.status === 404) onChanged();
    } finally {
      setMutationBusy(null);
    }
  };

  const toggleAllMeanings = () => {
    setAllMeaningsVisible((visible) => {
      const nextVisible = !visible;
      if (!nextVisible) setRevealedMeaningIds(new Set());
      return nextVisible;
    });
  };

  const revealMeaning = (wordId: string) => {
    setRevealedMeaningIds((current) => {
      const next = new Set(current);
      next.add(wordId);
      return next;
    });
  };

  const hideMeaning = (wordId: string) => {
    setRevealedMeaningIds((current) => {
      const next = new Set(current);
      next.delete(wordId);
      return next;
    });
  };

  const downloadBackup = () => {
    downloadTextFile(wordRepository.exportBackup(user.id), `cet-word-library-${new Date().toISOString().slice(0, 10)}.json`);
    setDataMessage(`已导出 ${words.length} 个词的词库文件；学习阶段和复习历史由服务器数据库保存。`);
  };

  const downloadEditableTsv = () => {
    downloadTextFile(
      `\uFEFF${buildEditableTsv(words)}`,
      `cet-word-library-${new Date().toISOString().slice(0, 10)}.tsv`,
      "text/tab-separated-values;charset=utf-8",
    );
    setDataMessage(`已导出 ${words.length} 个词的可编辑 TSV。修改后直接重新导入同名单词，学习进度会保留。`);
  };

  const toggleBatchManaging = () => {
    setBatchManaging((current) => !current);
    setSelectedWordIds(new Set());
    setBatchDeleteOpen(false);
  };

  const toggleWordSelection = (wordId: string) => {
    setSelectedWordIds((current) => {
      const next = new Set(current);
      if (next.has(wordId)) next.delete(wordId);
      else next.add(wordId);
      return next;
    });
  };

  const toggleFilteredSelection = () => {
    setSelectedWordIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) filtered.forEach((item) => next.delete(item.id));
      else filtered.forEach((item) => next.add(item.id));
      return next;
    });
  };

  const confirmBatchDelete = async () => {
    if (mutationBusy) return;
    setMutationBusy("batch-delete");
    try {
      const deleted = await wordRepository.deleteWords(user.id, [...selectedWordIds]);
      setBatchDeleteOpen(false);
      setSelectedWordIds(new Set());
      setOpenId(null);
      setEditing(null);
      setUndoWord(null);
      if (deleted === 0) {
        setDataMessage("没有找到可删除的词，词库可能已在其他页面更新。");
        return;
      }
      setDataMessage(`已永久删除 ${deleted} 个词及其学习进度。`);
      onChanged();
    } catch (error) {
      setDataMessage(apiErrorMessage(error, "批量删除失败，请检查网络和服务器状态。"));
      if (error instanceof ApiError && error.status === 404) onChanged();
    } finally {
      setMutationBusy(null);
    }
  };

  const restoreBackup = async (file: File | undefined) => {
    if (mutationBusy) return;
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setDataMessage("备份文件超过 5 MB，已停止读取。");
      return;
    }
    setMutationBusy("restore-backup");
    try {
      const raw = await file.text();
      let preview = "词库文件内容将先经过格式校验。";
      try {
        const parsed = JSON.parse(raw) as { words?: unknown };
        const incomingNames = Array.isArray(parsed.words)
          ? [...new Set(parsed.words.flatMap((item) => item && typeof item === "object" && typeof (item as { word?: unknown }).word === "string" ? [(item as { word: string }).word.trim().toLowerCase()] : []))]
          : [];
        const existingNames = new Set(words.map((item) => item.word.trim().toLowerCase()));
        const existing = incomingNames.filter((name) => existingNames.has(name)).length;
        preview = `共检测到 ${incomingNames.length} 个词\n预计新增：${incomingNames.length - existing}\n已存在：${existing}\n\n已有词条的学习进度不会重置。确定导入词库吗？`;
      } catch {
        // 交给仓库做完整格式校验，并在下方统一显示受控错误。
      }
      if (!window.confirm(preview)) return;
      const result = await wordRepository.restoreBackup(user.id, raw);
      setUndoWord(null);
      setOpenId(null);
      setDataMessage(`词库导入完成：新增 ${result.added} 个，已存在 ${result.existing} 个；已有云端学习进度保持不变。`);
      onChanged();
    } catch (error) {
      setDataMessage(apiErrorMessage(error, "备份恢复失败，请检查文件。"));
    } finally {
      setMutationBusy(null);
    }
  };

  return (
    <div className="space-y-5 pb-24">
      <h1 className="sr-only">我的词库</h1>
      <section className="word-library-summary" aria-labelledby="word-library-title">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="word-library-eyebrow">我的词库</p>
            <h2 id="word-library-title" className="mt-1 text-2xl font-bold tracking-tight">CET 4/6 真题词库</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">按记忆状态查看、复习和恢复单词。</p>
          </div>
          <div className="shrink-0 text-right">
            <strong className="word-library-total">{words.length}</strong>
            <span className="ml-1 text-sm font-semibold text-slate-500">个词</span>
          </div>
        </div>
        <div className="word-library-stats" aria-label="词库记忆状态统计">
          <div className="word-library-stat"><span>新词</span><strong>{libraryCounts.new}</strong></div>
          <div className="word-library-stat"><span>记忆中</span><strong>{libraryCounts.learning}</strong></div>
          <div className="word-library-stat"><span>已掌握</span><strong>{libraryCounts.mastered}</strong></div>
          <div className="word-library-stat"><span>待复习</span><strong>{dueCount}</strong></div>
        </div>
      </section>
      <section className="word-library-management" aria-labelledby="word-library-management-title">
        <div className="min-w-0">
          <h2 id="word-library-management-title" className="text-sm font-semibold text-slate-900">词库整理</h2>
          <p className="word-library-management-copy">导出可编辑 TSV；修改音标后直接重新导入同名单词，学习进度会保留。</p>
        </div>
        <div className="word-library-management-actions">
          <button type="button" onClick={downloadEditableTsv} disabled={words.length === 0} className="button-secondary px-3 text-sm">导出 TSV</button>
          <button type="button" onClick={toggleBatchManaging} aria-pressed={batchManaging} className={`button-quiet px-3 text-sm ${batchManaging ? "word-library-management-active" : ""}`}>
            {batchManaging ? "完成管理" : "批量删除"}
          </button>
        </div>
      </section>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-white p-4">
        <div>
          <p className="text-sm font-semibold">词库导出与导入</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">JSON 只包含单词内容，不包含学习阶段、复习历史或账号身份；核心学习数据由服务器数据库备份保护。</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={downloadBackup} disabled={mutationBusy !== null} className="button-secondary px-3 text-sm">导出词库</button>
          <label className={`button-quiet cursor-pointer px-3 text-sm ${mutationBusy !== null ? "pointer-events-none opacity-60" : ""}`}>
            {mutationBusy === "restore-backup" ? "导入中…" : "导入词库"}
            <input type="file" accept=".json,application/json" disabled={mutationBusy !== null} className="sr-only" onChange={(event) => { void restoreBackup(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
        </div>
        {automaticBackup && (
          <button
            type="button"
            onClick={() => downloadTextFile(automaticBackup, `cet-word-before-restore-${new Date().toISOString().slice(0, 10)}.json`)}
            className="inline-flex min-h-11 w-full items-center text-left text-xs font-medium text-blue-700 underline underline-offset-4"
          >
            下载最近一次恢复前的自动备份
          </button>
        )}
      </section>
      {dataMessage && <p role="status" aria-live="polite" className="rounded-2xl bg-blue-50 p-4 text-sm text-blue-800">{dataMessage}</p>}
      {missingPhoneticCount > 0 && (
        <p className="rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          有 {missingPhoneticCount} 个旧词缺少音标。请用含音标 TSV 重新导入同名单词，学习进度不会重置。
        </p>
      )}
      <div className="word-library-sticky-tools" role="region" aria-label="词库显示设置">
        <span className="word-library-sticky-label">中文释义</span>
        <button
          type="button"
          className="word-visibility-toggle"
          onClick={toggleAllMeanings}
          aria-pressed={allMeaningsVisible}
          aria-label={allMeaningsVisible ? "隐藏全部中文释义" : "显示全部中文释义"}
        >
          <span aria-hidden="true">{allMeaningsVisible ? "◉" : "◎"}</span>
          <span>{allMeaningsVisible ? "隐藏释义" : "显示释义"}</span>
        </button>
      </div>
      <label htmlFor="word-search" className="sr-only">搜索词库</label>
      <input id="word-search" type="search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索单词、音标、释义或来源" className="input" />
      <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="按词库阶段筛选">
        {wordFilterOptions.map(({ id, label, count }) => {
          const selected = stateFilter === id;
          return (
            <button
              type="button"
              key={id}
              onClick={() => setStateFilter(id)}
              aria-pressed={selected}
              className={`filter-chip shrink-0 rounded-full px-3 text-xs font-medium ${selected ? "bg-blue-700 text-white" : "bg-white text-slate-600 ring-1 ring-blue-100"}`}
            >
              {label} {count}
            </button>
          );
        })}
      </div>
      {batchManaging && (
        <section className="word-library-batch-toolbar" aria-label="批量管理词库" aria-live="polite">
          <div className="min-w-0">
            <p className="text-sm font-semibold">已选择 {selectedWordIds.size} 个词</p>
            <p className="word-library-batch-note">可全选{selectionScopeLabel}；删除前建议导出 JSON 备份。</p>
          </div>
          <div className="word-library-batch-actions">
            <button type="button" onClick={toggleFilteredSelection} disabled={filtered.length === 0} className="button-secondary px-3 text-sm">
              {allFilteredSelected ? "取消全选" : `全选 ${filtered.length} 个`}
            </button>
            <button type="button" onClick={() => setBatchDeleteOpen(true)} disabled={selectedWordIds.size === 0} className="batch-delete-trigger">
              删除已选 {selectedWordIds.size}
            </button>
          </div>
        </section>
      )}
      {undoWord && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-950 ring-1 ring-amber-100">
          <span><strong>{undoWord.word}</strong> 已斩，不再进入每日复习。</span>
          <button type="button" onClick={() => void undoKill()} disabled={mutationBusy !== null} className="inline-flex min-h-11 shrink-0 items-center font-semibold text-blue-700 underline underline-offset-4">{mutationBusy === "undo-kill" ? "撤销中…" : "撤销"}</button>
        </div>
      )}
      <p className="text-sm text-slate-500">显示 {filtered.length} 个结果</p>
      <div className="space-y-3">
        {filtered.map((item) => {
          const expanded = item.id === openId;
          const state = memoryState(item);
          const meaningVisible = allMeaningsVisible || revealedMeaningIds.has(item.id);
          const meaningRevealedIndividually = !allMeaningsVisible && revealedMeaningIds.has(item.id);
          const strength = Math.round((item.progress.reviewStage / 6) * 100);
          const progressBlocks = Math.min(5, Math.ceil((item.progress.reviewStage / 6) * 5));
          return (
            <article key={item.id} className="word-card overflow-hidden rounded-2xl border border-stone-200 bg-white">
              <div className={`word-list-row ${batchManaging ? "is-batch-managing" : ""}`}>
                {batchManaging && (
                  <label className="word-batch-select">
                    <input
                      type="checkbox"
                      checked={selectedWordIds.has(item.id)}
                      onChange={() => toggleWordSelection(item.id)}
                      aria-label={`选择 ${item.word}`}
                    />
                  </label>
                )}
                <div className="word-progress-meter" role="img" aria-label={`记忆进度 ${progressBlocks}/5 格`}>
                  {Array.from({ length: 5 }, (_, index) => (
                    <span key={index} className={`word-progress-block ${index < progressBlocks ? "is-filled" : ""}`} aria-hidden="true" />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setOpenId(expanded ? null : item.id)}
                  aria-expanded={expanded}
                  aria-controls={`word-details-${item.id}`}
                  aria-label={`${expanded ? "收起" : "展开"} ${item.word} 的学习详情`}
                  className="word-expand-button interactive-row"
                >
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-bold">{item.word}</h2>
                    {item.phonetic && <p className="mt-1 truncate font-mono text-xs text-blue-700">{item.phonetic}</p>}
                  </div>
                  <span className="word-expand-indicator" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
                </button>
                <div className="word-row-meaning">
                  <div className="word-meaning-wrap">
                    {meaningVisible ? (
                      meaningRevealedIndividually ? (
                        <button
                          type="button"
                          className="word-meaning-revealed"
                          onClick={() => hideMeaning(item.id)}
                          aria-label={`隐藏 ${item.word} 的中文释义`}
                        >
                          {item.meaning || "（未填写释义）"}
                        </button>
                      ) : (
                        <p className="word-meaning text-sm text-slate-600">{item.meaning || "（未填写释义）"}</p>
                      )
                    ) : (
                      <div className="word-meaning-placeholder" aria-hidden="true" />
                    )}
                    {!meaningVisible && (
                      <button
                        type="button"
                        className="word-meaning-mask"
                        onClick={() => revealMeaning(item.id)}
                        aria-label={`显示 ${item.word} 的中文释义`}
                      >
                        <span aria-hidden="true">点击查看中文释义</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {expanded && (
                <div id={`word-details-${item.id}`} className="word-details space-y-3 px-4 py-4 text-sm leading-6 text-slate-600">
                  {editing?.id === item.id ? (
                    <form className="space-y-3 rounded-xl bg-blue-50 p-3" onSubmit={async event => {
                      event.preventDefault();
                      if (mutationBusy) return;
                      setMutationBusy(`update:${item.id}`);
                      try { await wordRepository.updateWord(user.id, item.id, editing.phonetic, editing.meaning); setEditing(null); setDataMessage("音标和释义已更新，学习进度保持不变。"); onChanged(); }
                      catch (error) { setDataMessage(apiErrorMessage(error, "保存失败，请检查网络和服务器状态。")); if (error instanceof ApiError && error.status === 404) onChanged(); }
                      finally { setMutationBusy(null); }
                    }}>
                      <label className="block">IPA 音标<input required disabled={mutationBusy !== null} className="input" value={editing.phonetic} onChange={event => setEditing({ ...editing, phonetic: event.target.value })} /></label>
                      <label className="block">中文释义<input required disabled={mutationBusy !== null} className="input" value={editing.meaning} onChange={event => setEditing({ ...editing, meaning: event.target.value })} /></label>
                      <button className="button-primary" disabled={mutationBusy !== null} type="submit">{mutationBusy === `update:${item.id}` ? "保存中…" : "保存修改"}</button>
                      <button className="button-quiet" disabled={mutationBusy !== null} type="button" onClick={() => setEditing(null)}>取消</button>
                    </form>
                  ) : <button type="button" className="button-secondary" onClick={() => setEditing({ id: item.id, phonetic: item.phonetic, meaning: item.meaning })}>编辑音标与释义</button>}
                  <div>
                    <div className="mb-1.5 flex justify-between text-xs text-slate-400"><span>记忆阶段 {item.progress.reviewStage}/6</span><span>{strength}%</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-blue-50"><div className="h-full rounded-full bg-blue-600" style={{ width: `${strength}%` }} /></div>
                  </div>
                  <p className="text-xs text-slate-400">
                    {state === "killed" ? `已斩于 ${displayDate(item.progress.killedAt)}` : `下次复习：${displayDate(item.progress.nextReviewAt)}`}
                    <span className="mx-2 text-stone-300">·</span>
                    认词 {item.progress.recognitionScore}/5
                    <span className="mx-2 text-stone-300">·</span>
                    拼写 {item.progress.spellingScore}/5
                  </p>
                  {item.phrase && <p><span className="font-medium text-slate-800">搭配：</span>{item.phrase}</p>}
                  {item.sentence && <p><span className="font-medium text-slate-800">原句：</span>{item.sentence}</p>}
                  {item.sentenceCn && <p><span className="font-medium text-slate-800">翻译：</span>{item.sentenceCn}</p>}
                  {item.source && <p className="text-xs text-slate-400">来源：{item.source}</p>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button type="button" onClick={() => speakWord(item.word)} className="tap-feedback inline-flex min-h-11 items-center rounded-xl bg-blue-50 px-3 text-sm font-medium text-blue-700">🔊 播放发音</button>
                    {state === "killed" ? (
                      <button type="button" onClick={() => void restore(item)} disabled={mutationBusy !== null} className="tap-feedback inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-3 text-sm font-semibold text-white">{mutationBusy === `restore:${item.id}` ? "恢复中…" : "恢复复习"}</button>
                    ) : (
                      <button type="button" onClick={() => kill(item)} disabled={mutationBusy !== null} className="tap-feedback inline-flex min-h-11 items-center rounded-xl bg-amber-100 px-3 text-sm font-semibold text-amber-950">斩掉这个词</button>
                    )}
                  </div>
                  <button type="button" onClick={() => void remove(item)} disabled={mutationBusy !== null} className="inline-flex min-h-11 items-center text-sm font-medium text-rose-600 underline underline-offset-4">{mutationBusy === `delete:${item.id}` ? "删除中…" : "永久删除这个词"}</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {words.length === 0 && <SignInEmptyWords />}
      {words.length > 0 && filtered.length === 0 && <p className="py-10 text-center text-sm text-slate-500">没有匹配的词。</p>}
      {scopedWords.length > 0 && (
        <aside className="word-library-practice-dock" aria-label="词库范围拼写">
          <div className="word-library-practice-summary">
            <span aria-hidden="true" className="word-library-practice-icon">abc</span>
            <span className="min-w-0">
              <strong>拼写</strong>
              <small>{wordListFilterLabels[stateFilter]} · {scopedWords.length} 个词</small>
            </span>
          </div>
          <a
            href={`#/spell?scope=library&filter=${stateFilter}`}
            className="word-library-practice-action"
            aria-label={`拼写当前${wordListFilterLabels[stateFilter]}分组的 ${scopedWords.length} 个词`}
          >
            开始
            <span aria-hidden="true">→</span>
          </a>
        </aside>
      )}
      {pendingKill && <KillConfirmModal word={pendingKill.word} busy={mutationBusy !== null} onCancel={() => setPendingKill(null)} onConfirm={confirmKill} />}
      {batchDeleteOpen && (
        <BatchDeleteConfirmModal
          count={selectedWordIds.size}
          busy={mutationBusy === "batch-delete"}
          onCancel={() => setBatchDeleteOpen(false)}
          onConfirm={confirmBatchDelete}
        />
      )}
    </div>
  );
}

function SignInEmptyWords() {
  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-6 text-center">
      <p className="font-semibold">词库还是空的</p>
      <a href="#/import" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-blue-700 underline underline-offset-4">去粘贴 TSV</a>
    </div>
  );
}

function NewStudyPage({ user, newWords, allWords, groupWords, onFinished }: { user: LocalUser; newWords: WordWithProgress[]; allWords: WordWithProgress[]; groupWords: number; onFinished: () => void }) {
  const [initialSession] = useState(() => {
    const freshItems = newWords.slice(0, Math.min(groupWords, MAX_SESSION_WORDS));
    const storedDraft = wordRepository.getReviewDraft(user.id);
    if (!storedDraft || storedDraft.mode !== "new" || storedDraft.phase !== "learning") {
      if (storedDraft?.mode === "new") ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return { items: freshItems, draft: null as ReviewDraft | null, resumeIndex: 0 };
    }

    const byId = new Map(
      allWords
        .filter((item) => !item.progress.killedAt && memoryState(item) === "new")
        .map((item) => [item.id, item]),
    );
    const savedItems = storedDraft.itemIds
      .map((wordId) => byId.get(wordId))
      .filter((item): item is WordWithProgress => Boolean(item));
    if (savedItems.length === 0) {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return { items: freshItems, draft: null as ReviewDraft | null, resumeIndex: 0 };
    }
    const savedIndex = storedDraft.currentWordId
      ? savedItems.findIndex((item) => item.id === storedDraft.currentWordId)
      : storedDraft.index;
    return {
      items: savedItems,
      draft: storedDraft,
      resumeIndex: Math.max(0, Math.min(savedIndex < 0 ? storedDraft.index : savedIndex, savedItems.length - 1)),
    };
  });
  const [items, setItems] = useState(initialSession.items);
  const [phase, setPhase] = useState<NewStudyPhase>("ready");
  const [index, setIndex] = useState(0);
  const [completion, setCompletion] = useState<{ completed: number; earliestNextReviewAt: string | null } | null>(null);
  const [completionSaving, setCompletionSaving] = useState(false);
  const [draftWarning, setDraftWarning] = useState("");
  const finalizingStudy = useRef(false);
  const current = items[index] ?? items[0];

  useEffect(() => {
    if (phase === "complete") {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return;
    }
    if (phase !== "learning") return;
    const activeWord = items[index];
    if (!activeWord) {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return;
    }
    void wordRepository.saveReviewDraft(user.id, {
        itemIds: items.map((item) => item.id),
        recognitionQueueIds: [],
        mode: "new",
        phase: "learning",
        index,
        recognition: {},
        spelling: {},
        hadSpellingError: false,
        currentWordId: activeWord.id,
        firstChoice: null,
        answer: "",
        spellingChecked: null,
      }).then(() => setDraftWarning("")).catch((error) => setDraftWarning(apiErrorMessage(error, "本轮进度暂时无法自动保存，请不要刷新或关闭页面。")));
  }, [index, items, phase, user.id]);

  const backToToday = (
    <a href="#/" className="button-quiet w-fit px-2 text-sm" aria-label="返回今日页面">
      <span aria-hidden="true">←</span>
      <span>返回今日</span>
    </a>
  );
  const withBack = (content: React.ReactNode) => (
    <div className="space-y-5">
      <div>{backToToday}</div>
      {content}
    </div>
  );

  const beginStudy = () => {
    setIndex(initialSession.draft ? initialSession.resumeIndex : 0);
    setPhase("learning");
  };

  const completeStudy = async () => {
    if (finalizingStudy.current) return;
    finalizingStudy.current = true;
    setCompletionSaving(true);
    try {
      const save = () => wordRepository.completeNewStudy(user.id, items);
      const result = typeof navigator !== "undefined" && navigator.locks
        ? await navigator.locks.request("cet-word-database-write", save)
        : await save();
      if (result.completed !== items.length) {
        finalizingStudy.current = false;
        setDraftWarning("部分词条已在其他页面发生变化，本轮没有重复覆盖；请返回今日页面后重新开始剩余新词。");
        onFinished();
        return;
      }
      setCompletion(result);
      setPhase("complete");
      onFinished();
    } catch (error) {
      finalizingStudy.current = false;
      setDraftWarning(apiErrorMessage(error, "无法保存本轮新学结果，请稍后重试。"));
    } finally {
      setCompletionSaving(false);
    }
  };

  const goNext = () => {
    if (index === items.length - 1) {
      void completeStudy();
      return;
    }
    setIndex((previous) => previous + 1);
  };

  const startNextGroup = () => {
    const freshItems = newWords.slice(0, Math.min(groupWords, MAX_SESSION_WORDS));
    ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
    setItems(freshItems);
    setIndex(0);
    setCompletion(null);
    setDraftWarning("");
    finalizingStudy.current = false;
    setPhase("learning");
  };

  if (items.length === 0 && phase !== "complete") {
    return withBack(
      <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
        <p className="text-sm font-medium text-blue-700">新学任务已完成</p>
        <h1 className="mt-2 text-2xl font-bold">暂时没有待学新词</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">新导入的词会先进入这里，完成认识后才会在明天进入复习。</p>
        <a href="#/import" className="button-primary mt-6 inline-flex">导入 TSV</a>
      </section>,
    );
  }

  if (phase === "ready") {
    const remaining = Math.max(newWords.length - items.length, 0);
    return withBack(
      <>
        <section>
          <p className="text-sm font-medium text-blue-700">本轮新学</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">先认识新词，再安排复习</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">这里不会先让你回忆或拼写。看完本组后，单词才会进入明天的复习队列。</p>
        </section>
        <section className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-stone-100">
          <div className="grid grid-cols-3 gap-3">
            <Metric label="本组" value={items.length} />
            <Metric label="每组" value={groupWords} />
            <Metric label="待学" value={newWords.length} />
          </div>
          {initialSession.draft && (
            <p className="mt-5 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              检测到上次未完成的新学，将从第 {initialSession.resumeIndex + 1} 个词继续。
            </p>
          )}
          {remaining > 0 && <p className="mt-5 rounded-xl bg-blue-50 p-3 text-xs leading-5 text-blue-800">本组完成后，还有 {remaining} 个新词可继续学习。</p>}
          <button type="button" onClick={beginStudy} className="button-primary mt-6 w-full">{initialSession.draft ? "继续上次新学" : `开始学习本组 ${items.length} 个词`}</button>
        </section>
      </>,
    );
  }

  if (phase === "complete") {
    const remaining = newWords.length;
    return withBack(
      <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-blue-50 text-3xl text-blue-700">✓</div>
        <p className="mt-5 text-sm font-medium text-blue-700">本轮新学完成</p>
        <h1 className="mt-2 text-3xl font-bold">已认识 {completion?.completed ?? 0} 个新词</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">它们已安排在 {displayDate(completion?.earliestNextReviewAt ?? null)} 复习；新学不计入认词或拼写成绩。</p>
        {remaining > 0 && <button type="button" onClick={startNextGroup} className="button-primary mt-6 w-full">继续下一组 {Math.min(remaining, groupWords, MAX_SESSION_WORDS)} 个词</button>}
        <div className="mt-7 grid grid-cols-2 gap-3">
          <a href="#/" className="button-secondary">回到首页</a>
          <a href="#/words" className="button-primary">查看词库</a>
        </div>
      </section>,
    );
  }

  if (!current) return null;
  return withBack(
    <>
      {draftWarning && <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">{draftWarning}</p>}
      <ReviewProgress label="新学" index={index} total={items.length} detail="先理解词义" />
      <section className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-stone-100">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-blue-700">先完整认识这个词</p>
            <h1 className="mt-4 break-words text-4xl font-bold tracking-tight sm:text-5xl">{current.word}</h1>
            {current.phonetic && <p className="mt-3 font-mono text-base text-blue-700">{current.phonetic}</p>}
          </div>
          <button type="button" onClick={() => speakWord(current.word)} className="tap-feedback inline-flex min-h-11 shrink-0 items-center rounded-full bg-blue-50 px-3 text-xs font-medium text-blue-700">🔊 发音</button>
        </div>
        <div className="mt-7 space-y-3 rounded-2xl bg-blue-50/60 p-4 text-sm leading-6 text-slate-600">
          <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">释义：</strong>{current.meaning || "（未填写）"}</p>
          {current.phrase && <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">搭配：</strong>{current.phrase}</p>}
          {current.sentence && <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">真题句子：</strong>{current.sentence}</p>}
          {current.sentenceCn && <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">翻译：</strong>{current.sentenceCn}</p>}
          {current.source && <p className="break-words pt-1 text-xs text-slate-400 [overflow-wrap:anywhere]">来源：{current.source}</p>}
        </div>
        <button type="button" onClick={goNext} disabled={completionSaving} className="button-primary mt-7 w-full">{completionSaving ? "保存中…" : index === items.length - 1 ? "完成本组新学" : "已了解，下一个词"}</button>
      </section>
    </>,
  );
}

function SpellingPracticePage({
  user,
  words,
  groupWords,
  onFinished,
  source = "daily",
  libraryFilter = "all",
  libraryItems = [],
}: {
  user: LocalUser;
  words: WordWithProgress[];
  groupWords: number;
  onFinished: () => void;
  source?: SpellingScope;
  libraryFilter?: WordListFilter;
  libraryItems?: WordWithProgress[];
}) {
  const groupLimit = Math.max(1, Math.min(groupWords, MAX_SESSION_WORDS));
  const spellingCandidates = source === "library"
    ? libraryItems
    : wordRepository.getSpellingWords(user.id, groupLimit);
  const scopeLabel = source === "library" ? wordListFilterLabels[libraryFilter] : "今天新学";
  const [initialSession] = useState(() => {
    const freshItems = spellingCandidates.slice(0, groupLimit);
    const storedDraft = wordRepository.getReviewDraft(user.id);
    const draftMatchesScope = Boolean(
      storedDraft &&
      storedDraft.mode === "spell" &&
      storedDraft.phase === "spelling" &&
      (storedDraft.scope ?? "daily") === source,
    );
    if (!storedDraft || !draftMatchesScope) {
      return { items: freshItems, draft: null as ReviewDraft | null, resumeIndex: 0, groupStart: 0 };
    }

    const today = new Date().toDateString();
    const eligibleItems = source === "library"
      ? spellingCandidates
      : words.filter((item) => !item.progress.killedAt && Boolean(item.progress.firstLearnedAt) && new Date(item.progress.firstLearnedAt!).toDateString() === today);
    const byId = new Map(eligibleItems.map((item) => [item.id, item]));
    const savedItems = storedDraft.itemIds
      .map((wordId) => byId.get(wordId))
      .filter((item): item is WordWithProgress => Boolean(item));
    if (savedItems.length === 0) {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return { items: freshItems, draft: null as ReviewDraft | null, resumeIndex: 0, groupStart: 0 };
    }
    const savedIndex = storedDraft.currentWordId
      ? savedItems.findIndex((item) => item.id === storedDraft.currentWordId)
      : storedDraft.index;
    const firstItemIndex = source === "library"
      ? spellingCandidates.findIndex((item) => item.id === savedItems[0].id)
      : 0;
    return {
      items: savedItems,
      draft: storedDraft,
      resumeIndex: Math.max(0, Math.min(savedIndex < 0 ? storedDraft.index : savedIndex, savedItems.length - 1)),
      groupStart: firstItemIndex < 0 ? 0 : Math.floor(firstItemIndex / groupLimit) * groupLimit,
    };
  });
  const [items, setItems] = useState(initialSession.items);
  const [groupStart, setGroupStart] = useState(initialSession.groupStart);
  const [resumableDraft, setResumableDraft] = useState(initialSession.draft);
  const [phase, setPhase] = useState<SpellingPracticePhase>("ready");
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState(initialSession.draft?.answer ?? "");
  const [spelling, setSpelling] = useState<Record<string, SpellingResponse>>(initialSession.draft?.spelling ?? {});
  const [spellingChecked, setSpellingChecked] = useState<SpellingResponse | null>(initialSession.draft?.spellingChecked ?? null);
  const [hadSpellingError, setHadSpellingError] = useState(initialSession.draft?.hadSpellingError ?? false);
  const [completion, setCompletion] = useState<{ completed: number; corrected: number } | null>(null);
  const [completionSaving, setCompletionSaving] = useState(false);
  const [draftWarning, setDraftWarning] = useState("");
  const finalizingSpelling = useRef(false);
  const spellingResultActionRef = useRef<HTMLButtonElement>(null);
  const current = items[index] ?? items[0];
  const groupNumber = source === "library" ? Math.floor(groupStart / groupLimit) + 1 : 1;
  const groupTotal = source === "library" ? Math.max(1, Math.ceil(spellingCandidates.length / groupLimit)) : 1;
  const nextGroupStart = source === "library" ? Math.min(spellingCandidates.length, groupStart + groupLimit) : items.length;
  const hasNextLibraryGroup = source === "library" && nextGroupStart < spellingCandidates.length;
  const nextLibraryGroupSize = Math.min(groupLimit, spellingCandidates.length - nextGroupStart);
  const backHref = source === "library" ? "#/words" : "#/";
  const backText = source === "library" ? "返回词库" : "返回今日";

  useEffect(() => {
    if (phase === "complete") {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return;
    }
    if (phase !== "spelling") return;
    const activeWord = items[index];
    if (!activeWord) {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return;
    }
    void wordRepository.saveReviewDraft(user.id, {
        itemIds: items.map((item) => item.id),
        recognitionQueueIds: [],
        mode: "spell",
        scope: source,
        phase: "spelling",
        index,
        recognition: {},
        spelling,
        hadSpellingError,
        currentWordId: activeWord.id,
        firstChoice: null,
        answer,
        spellingChecked,
      })
      .then(() => setDraftWarning(""))
      .catch((error) => setDraftWarning(apiErrorMessage(error, "本轮进度暂时无法自动保存，请不要刷新或关闭页面。")));
  }, [answer, hadSpellingError, index, items, phase, source, spelling, spellingChecked, user.id]);

  useEffect(() => {
    if (phase === "spelling" && spellingChecked) {
      spellingResultActionRef.current?.focus({ preventScroll: true });
    }
  }, [phase, spellingChecked]);

  const backToSource = (
    <a href={backHref} className="button-quiet w-fit px-2 text-sm" aria-label={`${backText}页面`}>
      <span aria-hidden="true">←</span>
      <span>{backText}</span>
    </a>
  );
  const withBack = (content: React.ReactNode) => (
    <div className="space-y-5">
      <div>{backToSource}</div>
      {content}
    </div>
  );

  const startPractice = () => {
    setIndex(resumableDraft ? initialSession.resumeIndex : 0);
    setResumableDraft(null);
    setPhase("spelling");
  };

  const checkSpelling = () => {
    if (!current) return;
    const correct = answer.trim().toLowerCase() === current.word.trim().toLowerCase();
    const checked = { input: answer, correct, hadError: hadSpellingError || !correct };
    if (!correct) setHadSpellingError(true);
    setSpellingChecked(checked);
  };

  const retrySpelling = () => {
    setAnswer("");
    setSpellingChecked(null);
  };

  const startNextLibraryGroup = () => {
    const nextItems = spellingCandidates.slice(nextGroupStart, nextGroupStart + groupLimit);
    if (nextItems.length === 0) return;
    ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
    finalizingSpelling.current = false;
    setItems(nextItems);
    setGroupStart(nextGroupStart);
    setResumableDraft(null);
    setIndex(0);
    setAnswer("");
    setSpelling({});
    setSpellingChecked(null);
    setHadSpellingError(false);
    setCompletion(null);
    setDraftWarning("");
    setPhase("ready");
  };

  const continueSpelling = async () => {
    if (!current || !spellingChecked?.correct) return;
    const nextSpelling = { ...spelling, [current.id]: spellingChecked };
    setSpelling(nextSpelling);
    if (index !== items.length - 1) {
      setIndex((previous) => previous + 1);
      setAnswer("");
      setSpellingChecked(null);
      setHadSpellingError(false);
      return;
    }
    if (source === "library") {
      setCompletion({
        completed: items.length,
        corrected: Object.values(nextSpelling).filter((entry) => entry.hadError).length,
      });
      setPhase("complete");
      return;
    }
    if (finalizingSpelling.current) return;
    finalizingSpelling.current = true;
    setCompletionSaving(true);
    try {
      const save = () => wordRepository.finishSpellingPractice(user.id, items, nextSpelling);
      const result = typeof navigator !== "undefined" && navigator.locks
        ? await navigator.locks.request("cet-word-database-write", save)
        : await save();
      if (result.completed !== items.length) {
        finalizingSpelling.current = false;
        setDraftWarning("部分词条已在其他页面发生变化，本轮没有重复覆盖；请返回今日页面后重新开始练习。");
        onFinished();
        return;
      }
      setCompletion(result);
      setPhase("complete");
      onFinished();
    } catch (error) {
      finalizingSpelling.current = false;
      setDraftWarning(apiErrorMessage(error, "无法保存拼写结果，请稍后重试。"));
    } finally {
      setCompletionSaving(false);
    }
  };

  if (items.length === 0 && phase !== "complete") {
    if (source === "library") {
      return withBack(
        <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
          <p className="text-sm font-medium text-blue-700">词库范围拼写</p>
          <h1 className="mt-2 text-2xl font-bold">当前“{scopeLabel}”分组没有可拼写的词</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">切换词库筛选后，再从浮动拼写入口开始练习。</p>
          <a href="#/words" className="button-primary mt-6 inline-flex">回到词库</a>
        </section>,
      );
    }
    return withBack(
      <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
        <p className="text-sm font-medium text-blue-700">拼写练习</p>
        <h1 className="mt-2 text-2xl font-bold">先完成今天的新学，再来拼写</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">拼写只会抽取今天刚完成新学的单词；以前学过或今天复习的词不会混进来。</p>
        <a href="#/review/new" className="button-primary mt-6 inline-flex">去新学</a>
      </section>,
    );
  }

  if (phase === "ready") {
    const readyTitle = source === "library" ? `拼写${scopeLabel}单词` : "只拼今天新学的词";
    const readyDescription = source === "library"
      ? `当前为第 ${groupNumber} / ${groupTotal} 组，共 ${spellingCandidates.length} 个词。每组最多 ${groupLimit} 个。`
      : `每组最多 ${groupWords} 个；今天新学的词不足时，按实际数量练习。`;
    return withBack(
      <>
        <section>
          <p className="text-sm font-medium text-blue-700">{source === "library" ? "词库范围拼写" : "独立拼写练习"}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{readyTitle}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">{readyDescription}</p>
        </section>
        <section className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-stone-100">
          <div className={`grid gap-3 ${source === "library" ? "grid-cols-3" : "grid-cols-2"}`}>
            <Metric label="本组" value={items.length} />
            {source === "library" && <Metric label="当前分组" value={`${groupNumber}/${groupTotal}`} />}
            <Metric label="每组上限" value={groupLimit} />
          </div>
          {source === "library" && <p className="mt-5 rounded-xl bg-blue-50 p-3 text-xs leading-5 text-blue-900">本次为词库范围练习，不改变新学、复习和记忆层级。</p>}
          {resumableDraft && <p className="mt-5 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">检测到上次未完成的拼写，将从第 {initialSession.resumeIndex + 1} 个词继续。</p>}
          <button type="button" onClick={startPractice} className="button-primary mt-6 w-full">{resumableDraft ? "继续上次拼写" : `开始拼写 ${items.length} 个词`}</button>
        </section>
      </>,
    );
  }

  if (phase === "complete") {
    const completionDescription = source === "library"
      ? completion?.corrected
        ? `其中 ${completion.corrected} 个词已订正。本次为词库范围练习，不改变新学、复习和记忆层级。`
        : "本次为词库范围练习，不改变新学、复习和记忆层级。"
      : completion?.corrected
        ? `其中 ${completion.corrected} 个词已订正，系统会保留拼写薄弱信号。`
        : "本轮拼写表现已记录，不会改变认词或复习层级。";
    return withBack(
      <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-blue-50 text-3xl text-blue-700">✓</div>
        <p className="mt-5 text-sm font-medium text-blue-700">拼写练习完成</p>
        <h1 className="mt-2 text-3xl font-bold">已完成 {completion?.completed ?? 0} 个词</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">{completionDescription}</p>
        {source === "library" && hasNextLibraryGroup ? (
          <button type="button" onClick={startNextLibraryGroup} className="button-primary mt-7 w-full">继续第 {groupNumber + 1} 组 {nextLibraryGroupSize} 个词</button>
        ) : (
          <div className="mt-7 grid grid-cols-2 gap-3">
            <a href={backHref} className="button-secondary">{source === "library" ? "回到词库" : "回到首页"}</a>
            <a href="#/words" className="button-primary">查看词库</a>
          </div>
        )}
      </section>,
    );
  }

  if (!current) return null;
  return withBack(
    <>
      {draftWarning && <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">{draftWarning}</p>}
      <ReviewProgress label={source === "library" ? `${scopeLabel} · 拼写` : "拼写练习"} index={index} total={items.length} detail="必须拼对才能继续" />
      <section className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-stone-100">
        <p className="text-sm font-medium text-blue-700">请根据中文释义写出英文</p>
        <h1 className="mt-5 text-2xl font-bold leading-relaxed">{current.meaning || "请根据语境写出英文"}</h1>
        {current.sentenceCn && <p className="mt-3 text-sm leading-6 text-slate-500">语境：{current.sentenceCn}</p>}
        {current.source && <p className="mt-2 text-xs text-slate-400">来源：{current.source}</p>}
        {!spellingChecked ? (
          <div className="mt-7 space-y-3">
            <input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") checkSpelling(); }}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="输入英文单词"
              className="input font-mono text-lg"
            />
            <button type="button" onClick={checkSpelling} className="button-primary w-full">提交</button>
          </div>
        ) : !spellingChecked.correct ? (
          <div className="mt-7 rounded-2xl bg-amber-50 p-4 text-amber-950">
            <p className="font-bold">还差一点，再记一次</p>
            <p className="mt-2 text-sm">你的答案：{spellingChecked.input.trim() || "（空）"}<br />正确答案：<strong>{current.word}</strong></p>
            {current.phonetic && <p className="mt-2 font-mono text-sm">{current.phonetic}</p>}
            <button ref={spellingResultActionRef} type="button" onClick={retrySpelling} className="button-primary mt-4 w-full">隐藏答案，再拼一次</button>
          </div>
        ) : (
          <div className="mt-7 rounded-2xl bg-blue-50 p-4 text-blue-900">
            <p className="font-bold">拼写正确</p>
            {spellingChecked.hadError && <p className="mt-2 text-sm">{source === "library" ? "已订正成功；本次练习不写入学习记录。" : "已订正成功；本次拼错会保留为拼写练习信号。"}</p>}
            <button ref={spellingResultActionRef} type="button" onClick={() => { void continueSpelling(); }} disabled={completionSaving} className="button-primary mt-4 w-full">{completionSaving ? "保存中…" : index === items.length - 1 ? "完成本组拼写" : "下一个词"}</button>
          </div>
        )}
      </section>
    </>,
  );
}

function ReviewPage({ user, dueWords, allWords, groupWords, mode, onFinished }: { user: LocalUser; dueWords: WordWithProgress[]; allWords: WordWithProgress[]; groupWords: number; mode: ReviewMode; onFinished: () => void }) {
  const modeDueWords = dueWords.filter((item) => {
    if (mode === "new") return memoryState(item) === "new";
    if (mode === "review") return memoryState(item) !== "new" && memoryState(item) !== "killed";
    return true;
  });
  const modeLabel = mode === "new" ? "新学" : mode === "review" ? "复习" : "复习";
  const [initialSession] = useState(() => {
    const freshItems = modeDueWords.slice(0, Math.min(groupWords, MAX_SESSION_WORDS));
    const storedDraft = wordRepository.getReviewDraft(user.id);
    // 首页不再单列“继续学习”卡片。点击“复习”时也要能恢复没有 mode 的旧版混合草稿，
    // 这样旧进度不会因入口简化而丢失；恢复后下一次保存会写成当前 review 模式。
    const canResumeLegacyReviewDraft = mode === "review" && storedDraft?.mode === undefined;
    const draft = storedDraft && (mode === "all" || storedDraft.mode === mode || canResumeLegacyReviewDraft) ? storedDraft : null;
    if (!draft) return { items: freshItems, queue: freshItems, draft: null as ReviewDraft | null, resumeIndex: 0 };

    // A changed daily plan must not discard an existing in-progress draft.
    // Fresh sessions still use the capped queue for the selected mode below.
    const byId = new Map(allWords.filter((item) => !item.progress.killedAt).map((item) => [item.id, item]));
    const savedItems = draft.itemIds.map((wordId) => byId.get(wordId)).filter((item): item is WordWithProgress => Boolean(item));
    const savedQueue = draft.recognitionQueueIds.map((wordId) => byId.get(wordId)).filter((item): item is WordWithProgress => Boolean(item));
    const valid = savedItems.length > 0 && (draft.phase !== "recognition" || savedQueue.length > 0);
    if (!valid) {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return { items: freshItems, queue: freshItems, draft: null as ReviewDraft | null, resumeIndex: 0 };
    }
    const activeItems = draft.phase === "recognition" ? savedQueue : savedItems;
    const originalIds = draft.phase === "recognition" ? draft.recognitionQueueIds : draft.itemIds;
    const surviving = originalIds.map((id, position) => ({ id, position })).filter(({ id }) => byId.has(id));
    const nextPosition = surviving.findIndex(({ position }) => position >= draft.index);
    const resumeIndex = nextPosition >= 0 ? nextPosition : Math.max(0, activeItems.length - 1);
    const sameOccurrence = surviving[resumeIndex]?.position === draft.index;
    if (!sameOccurrence) {
      draft.firstChoice = null;
      draft.answer = "";
      draft.spellingChecked = null;
      draft.hadSpellingError = false;
    }
    draft.recognition = Object.fromEntries(Object.entries(draft.recognition).filter(([id]) => byId.has(id)));
    draft.spelling = Object.fromEntries(Object.entries(draft.spelling).filter(([id]) => byId.has(id)));
    return {
      items: savedItems,
      queue: savedQueue.length > 0 ? savedQueue : savedItems,
      draft,
      resumeIndex,
    };
  });
  const [items, setItems] = useState(initialSession.items);
  const [recognitionQueue, setRecognitionQueue] = useState(initialSession.queue);
  const [phase, setPhase] = useState<ReviewPhase>("ready");
  const [index, setIndex] = useState(0);
  const [firstChoice, setFirstChoice] = useState<"known" | "unknown" | null>(initialSession.draft?.firstChoice ?? null);
  const [recognition, setRecognition] = useState<Record<string, RecognitionResponse>>(initialSession.draft?.recognition ?? {});
  const [spelling, setSpelling] = useState<Record<string, SpellingResponse>>(initialSession.draft?.spelling ?? {});
  const [answer, setAnswer] = useState(initialSession.draft?.answer ?? "");
  const [spellingChecked, setSpellingChecked] = useState<SpellingResponse | null>(initialSession.draft?.spellingChecked ?? null);
  const [hadSpellingError, setHadSpellingError] = useState(initialSession.draft?.hadSpellingError ?? false);
  const [completion, setCompletion] = useState<ReviewCompletion | null>(null);
  const [killedInSession, setKilledInSession] = useState(0);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [completionSaving, setCompletionSaving] = useState(false);
  const [draftWarning, setDraftWarning] = useState("");
  const finalizingReview = useRef(false);
  const spellingResultActionRef = useRef<HTMLButtonElement>(null);
  const backToToday = (
    <a href="#/" className="button-quiet w-fit px-2 text-sm" aria-label="返回今日页面">
      <span aria-hidden="true">←</span>
      <span>返回今日</span>
    </a>
  );
  const withBack = (content: React.ReactNode) => (
    <div className="space-y-5">
      <div>{backToToday}</div>
      {content}
    </div>
  );

  useEffect(() => {
    if (phase === "complete") {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return;
    }
    if (phase === "ready") return;
    const activeItems = phase === "recognition" ? recognitionQueue : items;
    const currentWordId = activeItems[index]?.id ?? null;
    if (!currentWordId) {
      ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
      return;
    }
    void wordRepository.saveReviewDraft(user.id, {
        itemIds: items.map((item) => item.id),
        recognitionQueueIds: recognitionQueue.map((item) => item.id),
        mode,
        phase,
        index,
        recognition,
        spelling,
        hadSpellingError,
        currentWordId,
        firstChoice,
        answer,
        spellingChecked,
      })
      .then(() => setDraftWarning(""))
      .catch((error) => setDraftWarning(apiErrorMessage(error, "本轮进度暂时无法自动保存，请不要刷新或关闭页面。")));
  }, [answer, firstChoice, hadSpellingError, index, items, phase, recognition, recognitionQueue, spelling, spellingChecked, user.id]);

  useEffect(() => {
    if (phase === "spelling" && spellingChecked) {
      spellingResultActionRef.current?.focus({ preventScroll: true });
    }
  }, [phase, spellingChecked]);

  if (items.length === 0 && phase !== "complete") {
    return withBack(
      <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
        <p className="text-sm font-medium text-blue-700">{modeLabel}任务已完成</p>
        <h1 className="mt-2 text-2xl font-bold">暂时没有{mode === "new" ? "待学新词" : mode === "review" ? "到期复习词" : "到期单词"}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">新导入的词会进入新学队列，到期词会进入复习队列。</p>
        <a href="#/import" className="button-primary mt-6 inline-flex">导入 TSV</a>
      </section>
    );
  }

  const current = (phase === "recognition" ? recognitionQueue[index] : items[index]) ?? items[0]!;
  const isRelearning = phase === "recognition" && Boolean(current && recognition[current.id]);

  const killCurrent = async () => {
    if (!current || killBusy) return;
    setKillBusy(true);
    try {
      if (!await wordRepository.killWord(user.id, current.id)) return;
    } catch (error) {
      setDraftWarning(apiErrorMessage(error, "斩词失败，请检查网络和服务器状态。"));
      return;
    } finally {
      setKillBusy(false);
    }
    setKillConfirmOpen(false);

    const nextItems = items.filter((item) => item.id !== current.id);
    const nextQueue = [
      ...recognitionQueue.slice(0, index),
      ...recognitionQueue.slice(index + 1).filter((item) => item.id !== current.id),
    ];
    setItems(nextItems);
    setRecognitionQueue(nextQueue);
    setRecognition((previous) => {
      const next = { ...previous };
      delete next[current.id];
      return next;
    });
    setKilledInSession((count) => count + 1);
    setFirstChoice(null);
    onFinished();

    if (nextItems.length === 0) {
      setPhase("complete");
      setIndex(0);
    } else if (index >= nextQueue.length) {
      setPhase("summary");
      setIndex(0);
    }
  };

  const respondRecognition = (result: "correct" | "wrong") => {
    if (!firstChoice || !current) return;
    const missed = firstChoice === "unknown" || result === "wrong";
    const previousAnswer = recognition[current.id];
    const nextAnswer: RecognitionResponse = previousAnswer
      ? { ...previousAnswer, hadError: previousAnswer.hadError || missed, attempts: previousAnswer.attempts + 1 }
      : { firstChoice, result, hadError: missed, attempts: 1 };
    setRecognition((previous) => ({ ...previous, [current.id]: nextAnswer }));
    setFirstChoice(null);

    const nextQueue = missed ? [...recognitionQueue, current] : recognitionQueue;
    if (missed) setRecognitionQueue(nextQueue);
    if (index === nextQueue.length - 1) {
      setIndex(0);
      setPhase("summary");
    } else {
      setIndex((previous) => previous + 1);
    }
  };

  const startSpelling = () => {
    setPhase("spelling");
    setIndex(0);
    setAnswer("");
    setSpellingChecked(null);
    setHadSpellingError(false);
  };

  const enterReview = () => {
    if (initialSession.draft) {
      setIndex(initialSession.resumeIndex);
      setPhase(initialSession.draft.phase === "learning" ? "recognition" : initialSession.draft.phase);
      return;
    }
    setPhase("recognition");
  };

  const restartReview = () => {
    const freshItems = modeDueWords.slice(0, Math.min(groupWords, MAX_SESSION_WORDS));
    ignoreCleanupFailure(wordRepository.clearReviewDraft(user.id));
    setItems(freshItems);
    setRecognitionQueue(freshItems);
    setRecognition({});
    setSpelling({});
    setIndex(0);
    setFirstChoice(null);
    setAnswer("");
    setSpellingChecked(null);
    setHadSpellingError(false);
    setCompletion(null);
    setKilledInSession(0);
    finalizingReview.current = false;
    setPhase("recognition");
  };

  const checkSpelling = () => {
    if (!current) return;
    const correct = answer.trim().toLowerCase() === current.word.trim().toLowerCase();
    const checked = { input: answer, correct, hadError: hadSpellingError || !correct };
    if (!correct) setHadSpellingError(true);
    setSpellingChecked(checked);
  };

  const retrySpelling = () => {
    setAnswer("");
    setSpellingChecked(null);
  };

  const continueSpelling = async () => {
    if (!spellingChecked?.correct || !current) return;
    const nextSpelling = { ...spelling, [current.id]: spellingChecked };
    setSpelling(nextSpelling);
    if (index === items.length - 1) {
      if (finalizingReview.current) return;
      finalizingReview.current = true;
      setCompletionSaving(true);
      try {
        const save = () => wordRepository.finishReview(user.id, items, recognition, nextSpelling);
        const result = typeof navigator !== "undefined" && navigator.locks
          ? await navigator.locks.request("cet-word-database-write", save)
        : await save();
        setCompletion(result);
        setPhase("complete");
        onFinished();
      } catch (error) {
        finalizingReview.current = false;
        setDraftWarning(apiErrorMessage(error, "无法保存本轮结果，请稍后重试。"));
      } finally {
        setCompletionSaving(false);
      }
      return;
    }
    setIndex((previous) => previous + 1);
    setAnswer("");
    setSpellingChecked(null);
    setHadSpellingError(false);
  };

  if (phase === "ready") {
    const newCount = items.filter((item) => !item.progress.lastReviewAt).length;
    const remaining = Math.max(modeDueWords.length - items.length, 0);
    return withBack(
      <>
        <section>
          <p className="text-sm font-medium text-blue-700">本轮{modeLabel}计划</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">先回忆，再验证</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">每个词都要主动想一次；没想起的会排到队尾回炉，最后用拼写确认。</p>
        </section>
        <section className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-stone-100">
          <div className="grid grid-cols-3 gap-3">
            <Metric label="本轮" value={items.length} />
            <Metric label="到期" value={items.length - newCount} />
            <Metric label="新词" value={newCount} />
          </div>
          <ol className="mt-6 space-y-4 text-sm text-slate-600">
            <StudyStep number="1" title="主动回忆" detail="只看英文，先判断能否想起含义。" />
            <StudyStep number="2" title="错词回炉" detail="没想起或理解错误，会在本轮队尾再次出现。" />
            <StudyStep number="3" title="拼写验证" detail="只看中文写英文；拼对后才进入下一个词。" />
          </ol>
          {initialSession.draft && (
            <p className="mt-5 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              检测到上次未完成的复习，已保存到第 {initialSession.resumeIndex + 1} 个词。你可以继续，也可以重新开始本轮。
            </p>
          )}
          {remaining > 0 && <p className="mt-5 rounded-xl bg-blue-50 p-3 text-xs leading-5 text-blue-800">今日还有 {remaining} 个{mode === "new" ? "新词" : mode === "review" ? "复习词" : "到期词"}，本轮完成后可继续下一组，避免单次任务过长。</p>}
          <button type="button" onClick={enterReview} className="button-primary mt-6 w-full">{initialSession.draft ? "继续上次复习" : "开始主动回忆"}</button>
          {initialSession.draft && <button type="button" onClick={restartReview} className="button-quiet mt-2 w-full">重新开始本轮</button>}
        </section>
      </>
    );
  }

  if (phase === "summary") {
    const answers = Object.values(recognition);
    const retried = answers.filter((item) => item.hadError).length;
    const extraAttempts = answers.reduce((sum, item) => sum + item.attempts - 1, 0);
    return withBack(
      <section className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-stone-100">
        <p className="text-sm font-medium text-blue-700">理解回忆完成</p>
        <h1 className="mt-2 text-2xl font-bold">所有错词已回炉通过</h1>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Metric label="本轮词数" value={items.length} />
          <Metric label="首次想起" value={answers.filter((item) => !item.hadError).length} />
          <Metric label="回炉词" value={retried} />
          <Metric label="加练次数" value={extraAttempts} />
        </div>
        <p className="mt-5 text-sm leading-6 text-slate-500">下一轮用中文提示拼写英文。拼写错误会留在当前词，订正成功后才继续。</p>
        <button type="button" onClick={startSpelling} className="button-primary mt-6 w-full">开始拼写验证</button>
      </section>
    );
  }

  if (phase === "complete") {
    return withBack(
      <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-blue-50 text-3xl text-blue-700">✓</div>
        <p className="mt-5 text-sm font-medium text-blue-700">本轮复习完成</p>
        <h1 className="mt-2 text-3xl font-bold">已处理 {(completion?.completed ?? 0) + killedInSession} 个词</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">系统已综合理解回忆与拼写表现，安排下一次复习；最早到期日为 {displayDate(completion?.earliestNextReviewAt ?? null)}。</p>
        {completion && (
          <div className="mt-6 grid grid-cols-4 gap-2 text-left">
            <GradeMetric label="重学" value={completion.grades.again} tone="amber" />
            <GradeMetric label="困难" value={completion.grades.hard} tone="orange" />
            <GradeMetric label="稳固" value={completion.grades.good} tone="blue" />
            <GradeMetric label="轻松" value={completion.grades.easy} tone="green" />
          </div>
        )}
        {modeDueWords.length > 0 && (
          <button type="button" onClick={restartReview} className="button-primary mt-6 w-full">继续下一组 {Math.min(modeDueWords.length, groupWords, MAX_SESSION_WORDS)} 个词</button>
        )}
        <div className="mt-7 grid grid-cols-2 gap-3">
          <a href="#/" className="button-secondary">回到首页</a>
          <a href="#/words" className="button-primary">查看词库</a>
        </div>
      </section>
    );
  }

  if (phase === "spelling") {
    return withBack(
      <>
        {draftWarning && <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">{draftWarning}</p>}
        <ReviewProgress label={`${modeLabel} · 拼写验证`} index={index} total={items.length} detail="必须拼对才能继续" />
        <section className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-stone-100">
          <p className="text-sm font-medium text-blue-700">请根据中文释义写出英文</p>
          <h1 className="mt-5 break-words text-2xl font-bold leading-relaxed [overflow-wrap:anywhere]">{current.meaning || "请根据语境写出英文"}</h1>
          {current.sentenceCn && <p className="mt-3 break-words text-sm leading-6 text-slate-500 [overflow-wrap:anywhere]">语境：{current.sentenceCn}</p>}
          {current.source && <p className="mt-2 break-words text-xs text-slate-400 [overflow-wrap:anywhere]">来源：{current.source}</p>}
          {!spellingChecked ? (
            <div className="mt-7 space-y-3">
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") checkSpelling(); }}
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="输入英文单词"
                className="input font-mono text-lg"
              />
              <button type="button" onClick={checkSpelling} className="button-primary w-full">提交</button>
            </div>
          ) : !spellingChecked.correct ? (
            <div className="mt-7 rounded-2xl bg-amber-50 p-4 text-amber-950">
              <p className="font-bold">还差一点，再记一次</p>
              <p className="mt-2 text-sm">你的答案：{spellingChecked.input.trim() || "（空）"}<br />正确答案：<strong>{current.word}</strong></p>
              {current.phonetic && <p className="mt-2 font-mono text-sm">{current.phonetic}</p>}
              <button ref={spellingResultActionRef} type="button" onClick={retrySpelling} className="button-primary mt-4 w-full">隐藏答案，再拼一次</button>
            </div>
          ) : (
            <div className="mt-7 rounded-2xl bg-blue-50 p-4 text-blue-900">
              <p className="font-bold">拼写正确</p>
              {spellingChecked.hadError && <p className="mt-2 text-sm">已订正成功；本轮拼错记录会保留，下一次会更早复习。</p>}
              <button ref={spellingResultActionRef} type="button" onClick={continueSpelling} className="button-primary mt-4 w-full">{index === items.length - 1 ? "完成本轮复习" : "下一个词"}</button>
            </div>
          )}
        </section>
      </>
    );
  }

  const priorAttempts = recognition[current.id]?.attempts ?? 0;
  return withBack(
    <>
      {draftWarning && <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">{draftWarning}</p>}
      <ReviewProgress
        label={isRelearning ? "错词回炉" : `${modeLabel} · 主动回忆`}
        index={index}
        total={recognitionQueue.length}
        detail={isRelearning ? `第 ${priorAttempts + 1} 次尝试` : "先回忆，再看答案"}
      />
      <section className={`rounded-3xl bg-white p-6 shadow-card ring-1 ${isRelearning ? "ring-amber-200" : "ring-stone-100"}`}>
        {!firstChoice ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-blue-700">{isRelearning ? "再想一次，答案仍然隐藏" : "先做第一反应，不显示答案"}</p>
              {isRelearning && <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">回炉</span>}
            </div>
            <h1 className="mt-12 break-words text-center text-4xl font-bold tracking-tight sm:text-5xl">{current.word}</h1>
            <div className="mt-14 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setFirstChoice("known")} className="review-choice review-choice-primary min-h-14 rounded-2xl bg-blue-700 px-4 font-bold text-white">想起来了</button>
              <button type="button" onClick={() => setFirstChoice("unknown")} className="review-choice review-choice-secondary min-h-14 rounded-2xl border border-amber-200 bg-amber-50 px-4 font-bold text-amber-900">还没想起</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-blue-700">核对答案 · 你刚才{firstChoice === "known" ? "想起来了" : "还没想起"}</p>
            <h1 className="mt-4 text-3xl font-bold">{current.word}</h1>
            <div className="mt-2 flex items-center gap-3">
              {current.phonetic && <p className="font-mono text-base text-blue-700">{current.phonetic}</p>}
              <button type="button" onClick={() => speakWord(current.word)} className="tap-feedback inline-flex min-h-11 items-center rounded-full bg-blue-50 px-3 text-xs font-medium text-blue-700">🔊 发音</button>
            </div>
            <div className="mt-6 space-y-3 rounded-2xl bg-blue-50/60 p-4 text-sm leading-6 text-slate-600">
              <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">释义：</strong>{current.meaning || "（未填写）"}</p>
              {current.phrase && <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">搭配：</strong>{current.phrase}</p>}
              {current.sentence && <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">真题句子：</strong>{current.sentence}</p>}
              {current.sentenceCn && <p className="break-words [overflow-wrap:anywhere]"><strong className="text-slate-900">翻译：</strong>{current.sentenceCn}</p>}
            </div>
            <button type="button" onClick={() => setKillConfirmOpen(true)} className="tap-feedback mt-4 inline-flex min-h-11 items-center rounded-xl bg-amber-50 px-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200">⚔ 已经很熟，斩掉这个词</button>
            <p className="mt-7 text-sm font-medium text-slate-700">你刚才想到的意思和答案对上了吗？</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => respondRecognition("correct")} className="review-choice review-choice-primary min-h-14 rounded-2xl bg-blue-700 px-4 font-bold text-white">对上了</button>
              <button type="button" onClick={() => respondRecognition("wrong")} className="review-choice review-choice-secondary min-h-14 rounded-2xl bg-amber-50 px-4 font-bold text-amber-900 ring-1 ring-amber-200">没对上</button>
            </div>
            <p className="mt-3 text-center text-xs text-slate-400">没想起或没对上，会排到本轮队尾再次出现。</p>
          </>
        )}
      </section>
      {killConfirmOpen && <KillConfirmModal word={current.word} busy={killBusy} onCancel={() => setKillConfirmOpen(false)} onConfirm={killCurrent} />}
    </>
  );
}

function ReviewProgress({ label, index, total, detail }: { label: string; index: number; total: number; detail?: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span><strong className="text-blue-800">{label}</strong>{detail && <span className="ml-2 text-xs text-slate-400">{detail}</span>}</span>
        <span className="text-slate-500">{index + 1} / {total}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full rounded-full bg-blue-700" style={{ width: `${((index + 1) / total) * 100}%` }} />
      </div>
    </div>
  );
}

function KillConfirmModal({ word, busy = false, onCancel, onConfirm }: { word: string; busy?: boolean; onCancel: () => void; onConfirm: () => void | Promise<void> }) {
  const { dialogRef, onBackdropPointerDown } = useModalDialog(onCancel);
  return (
    <ModalPortal>
      <div className="modal-backdrop fixed inset-0 z-50 grid place-items-end bg-slate-950/35 p-4 backdrop-blur-[2px] sm:place-items-center" role="dialog" aria-modal="true" aria-labelledby="kill-title" aria-describedby="kill-description" onPointerDown={onBackdropPointerDown}>
      <section ref={dialogRef} tabIndex={-1} className="modal-panel w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-2xl">⚔</div>
        <h2 id="kill-title" className="mt-4 text-xl font-bold">确定斩掉 {word}？</h2>
        <p id="kill-description" className="mt-2 text-sm leading-6 text-slate-500">斩掉后不再进入每日复习，但单词、释义和学习记录都会保留，可随时在“已斩”中恢复。</p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className="button-secondary">再想想</button>
          <button type="button" onClick={() => void onConfirm()} disabled={busy} className="kill-confirm-button inline-flex min-h-12 items-center justify-center rounded-2xl bg-amber-300 px-5 font-bold text-amber-950">{busy ? "处理中…" : "确认斩掉"}</button>
        </div>
      </section>
      </div>
    </ModalPortal>
  );
}

function BatchDeleteConfirmModal({ count, busy = false, onCancel, onConfirm }: { count: number; busy?: boolean; onCancel: () => void; onConfirm: () => void | Promise<void> }) {
  const { dialogRef, onBackdropPointerDown } = useModalDialog(onCancel);
  return (
    <ModalPortal>
      <div className="modal-backdrop fixed inset-0 z-50 grid place-items-end bg-slate-950/35 p-4 backdrop-blur-[2px] sm:place-items-center" role="dialog" aria-modal="true" aria-labelledby="batch-delete-title" aria-describedby="batch-delete-description" onPointerDown={onBackdropPointerDown}>
      <section ref={dialogRef} tabIndex={-1} className="modal-panel w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-rose-100 text-2xl" aria-hidden="true">×</div>
        <h2 id="batch-delete-title" className="mt-4 text-xl font-bold">永久删除 {count} 个词？</h2>
        <p id="batch-delete-description" className="mt-2 text-sm leading-6 text-slate-500">这些词及其学习进度会一并删除，不能从“已斩”中恢复。若还没有备份，请先取消并导出 JSON 备份。</p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className="button-secondary">取消</button>
          <button type="button" onClick={() => void onConfirm()} disabled={busy} className="batch-delete-confirm-button">{busy ? "删除中…" : "确认删除"}</button>
        </div>
      </section>
      </div>
    </ModalPortal>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return <div className="rounded-2xl bg-stone-50 p-4"><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-3xl font-bold">{value}</p></div>;
}

function ProfileStat({ label, value, tone }: { label: string; value: string; tone: "blue" | "amber" | "sky" }) {
  const tones = {
    blue: "bg-blue-50 text-blue-800 ring-blue-100",
    amber: "bg-amber-50 text-amber-900 ring-amber-100",
    sky: "bg-sky-50 text-sky-800 ring-sky-100",
  };
  return <div className={`rounded-2xl p-4 ring-1 ${tones[tone]}`}><p className="text-xs opacity-75">{label}</p><p className="mt-1 text-2xl font-bold">{value}</p></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm font-medium text-slate-700">{label}{children}</label>;
}

function StudyStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-bold text-blue-700">{number}</span>
      <span><strong className="text-slate-900">{title}</strong><span className="mt-0.5 block text-xs leading-5 text-slate-500">{detail}</span></span>
    </li>
  );
}

function GradeMetric({ label, value, tone }: { label: string; value: number; tone: "amber" | "orange" | "blue" | "green" }) {
  const tones = {
    amber: "bg-amber-50 text-amber-900",
    orange: "bg-orange-50 text-orange-900",
    blue: "bg-blue-50 text-blue-900",
    green: "bg-emerald-50 text-emerald-900",
  };
  return <div className={`rounded-xl p-3 ${tones[tone]}`}><p className="text-[11px] opacity-70">{label}</p><p className="mt-1 text-xl font-bold">{value}</p></div>;
}

export default function App() {
  const route = useHashRoute();
  const contentKey = typeof window === "undefined" ? route : window.location.hash || "#/";
  // 登录态只来自服务器会话：本机不再保留“已登录档案”，启动时先探测 /api/auth/me。
  const [user, setUser] = useState<LocalUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  // 登录/退出会自增计数，用于作废进行中的会话探测，避免旧响应覆盖更新的登录结果。
  const authProbeRef = useRef(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => wordRepository.getThemeMode());
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  const [revision, setRevision] = useState(0);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [storageStatus, setStorageStatus] = useState(() => wordRepository.getStorageStatus());
  const darkTheme = themeMode === "dark" || (themeMode === "system" && systemDark);
  const words = useMemo(() => (user ? wordRepository.getWords(user.id) : []), [user, revision]);
  const dueWords = useMemo(() => (user ? wordRepository.getDueWords(user.id) : []), [user, revision]);
  const handleCloudError = (error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.status === 401) {
      authProbeRef.current += 1;
      setUser(null);
      setCloudLoading(false);
      setCloudError("");
      setAuthNotice("登录状态已过期，请重新登录。");
      window.location.hash = "/login";
      return;
    }
    setCloudError(apiErrorMessage(error, fallback));
  };
  const refresh = () => {
    if (!user) {
      setRevision((value) => value + 1);
      return;
    }
    setCloudLoading(true);
    setCloudError("");
    void wordRepository.hydrate(user.id)
      .then(() => setRevision((value) => value + 1))
      .catch((error) => handleCloudError(error, "云端数据加载失败，请重试。"))
      .finally(() => setCloudLoading(false));
  };

  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
    document.documentElement.style.colorScheme = darkTheme ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", darkTheme ? "#0f172a" : "#1d4ed8");
  }, [darkTheme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const sync = () => setSystemDark(media.matches);
    sync();
    if (media.addEventListener) media.addEventListener("change", sync);
    else media.addListener(sync);
    return () => {
      if (media.removeEventListener) media.removeEventListener("change", sync);
      else media.removeListener(sync);
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setCloudLoading(false);
      return;
    }
    let cancelled = false;
    setCloudLoading(true);
    setCloudError("");
    void wordRepository.hydrate(user.id)
      .then(() => {
        if (!cancelled) setRevision((value) => value + 1);
      })
      .catch((error) => {
        if (!cancelled) handleCloudError(error, "云端数据加载失败，请重试。" );
      })
      .finally(() => {
        if (!cancelled) setCloudLoading(false);
      });
    return () => { cancelled = true; };
  // A successful re-authentication returns a new user object; reload cloud data even for the same account.
  }, [user]);

  useEffect(() => {
    const onUnauthorized = () => {
      authProbeRef.current += 1;
      setUser(null);
      setCloudLoading(false);
      setCloudError("");
      setAuthNotice("登录状态已过期，请重新登录。");
      window.location.hash = "/login";
    };
    window.addEventListener("cet-word-api-unauthorized", onUnauthorized);
    return () => window.removeEventListener("cet-word-api-unauthorized", onUnauthorized);
  }, []);

  const changeTheme = (mode: ThemeMode) => {
    try {
      wordRepository.setThemeMode(mode);
      setThemeMode(mode);
    } catch {
      // Theme changes remain session-local if browser storage is unavailable.
      setThemeMode(mode);
    }
  };

  useEffect(() => {
    const probeId = authProbeRef.current + 1;
    authProbeRef.current = probeId;
    let cancelled = false;
    const checkSession = async () => {
      try {
        const sessionUser = await apiClient.session();
        if (cancelled || authProbeRef.current !== probeId) return;
        if (sessionUser) setUser(sessionUser);
      } catch {
        // 网络或服务端异常一律按未登录处理，不给登录页报错；用户仍可手动重试登录。
      } finally {
        if (!cancelled && authProbeRef.current === probeId) setAuthChecking(false);
      }
    };
    void checkSession();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!user) return;
    const syncFromServer = () => {
      if (document.visibilityState !== "visible") return;
      void wordRepository.hydrate(user.id)
        .then(() => setRevision((value) => value + 1))
        .catch((error) => handleCloudError(error, "云端数据同步失败，请重试。"));
    };
    const timer = window.setInterval(syncFromServer, 60_000);
    window.addEventListener("focus", syncFromServer);
    window.addEventListener("pageshow", syncFromServer);
    document.addEventListener("visibilitychange", syncFromServer);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", syncFromServer);
      window.removeEventListener("pageshow", syncFromServer);
      document.removeEventListener("visibilitychange", syncFromServer);
    };
  }, [user?.id]);

  const login = async (email: string, password: string) => {
    authProbeRef.current += 1;
    setAuthNotice("");
    setAuthChecking(false);
    setCloudLoading(true);
    try {
      const nextUser = await apiClient.login(email, password);
      setUser(nextUser);
      window.location.hash = "/";
    } catch (error) {
      setCloudLoading(false);
      throw error;
    }
  };
  const logout = async () => {
    authProbeRef.current += 1;
    setAuthChecking(false);
    await apiClient.logout();
    setUser(null);
    setCloudLoading(false);
    setCloudError("");
    window.location.hash = "/";
  };

  const downloadDamagedData = () => {
    const raw = wordRepository.getDamagedData();
    if (!raw) return;
    downloadTextFile(raw, `cet-word-damaged-data-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
  };

  const startFresh = () => {
    if (!window.confirm("开始新档案会清空当前损坏的本机数据。请先下载保护副本；此操作无法撤销。确定继续吗？")) return;
    try {
      wordRepository.discardDamagedData();
      setUser(null);
      refresh();
      window.location.hash = "/login";
    } catch {
      refresh();
    }
  };

  let content: React.ReactNode;
  if (authChecking) {
    content = <AuthChecking />;
  } else if (user && cloudLoading) {
    content = <AuthChecking />;
  } else if (user && cloudError) {
    content = (
      <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100" role="alert">
        <p className="text-sm font-medium text-rose-700">云端数据加载失败</p>
        <p className="mt-2 text-sm leading-6 text-slate-500">{cloudError}</p>
        <button type="button" className="button-primary mt-5" onClick={refresh}>重新加载</button>
      </section>
    );
  } else if (route === "/login") {
    content = <LoginPage user={user} onLogin={login} onLogout={logout} notice={authNotice} />;
  } else if (route === "/admin") {
    content = <section className="rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-stone-100"><p className="text-sm font-semibold text-blue-700">管理员后台已独立</p><h1 className="mt-2 text-2xl font-bold">请使用独立管理员页面</h1><p className="mt-3 text-sm text-slate-500">账号管理不再与学习页面共用界面。</p><a className="button-primary mt-6 inline-flex" href="/admin.html">打开管理员后台</a></section>;
  } else if (!user) {
    content = <SignInRequired />;
  } else if (route === "/import") {
    content = <ImportPage user={user} words={words} onImported={refresh} />;
  } else if (route === "/words") {
    content = <WordsPage user={user} words={words} todayWords={dueWords} onChanged={refresh} />;
  } else if (route === "/profile") {
    content = <ProfilePage user={user} words={words} dueWords={dueWords} onUserChanged={(nextUser) => { setUser(nextUser); refresh(); }} />;
  } else if (route === "/statistics") {
    content = <StatisticsPage words={words} events={wordRepository.getLearningEvents(user.id)} />;
  } else if (route === "/review/new") {
    const newWords = dueWords.filter((item) => memoryState(item) === "new");
    content = <NewStudyPage key={`${user.id}-${route}`} user={user} newWords={newWords} allWords={words} groupWords={wordRepository.getDailyGroupWords(user.id)} onFinished={refresh} />;
  } else if (route === "/spell") {
    const spellParams = getHashSearchParams();
    const spellingScope: SpellingScope = spellParams.get("scope") === "library" ? "library" : "daily";
    const requestedFilter = spellParams.get("filter");
    const libraryFilter = isWordListFilter(requestedFilter) ? requestedFilter : "all";
    const libraryItems = spellingScope === "library"
      ? filterWordGroup(words, libraryFilter, new Set(dueWords.map((item) => item.id)))
      : [];
    content = (
      <SpellingPracticePage
        key={`${user.id}-${route}-${spellingScope}-${libraryFilter}`}
        user={user}
        words={words}
        groupWords={wordRepository.getDailyGroupWords(user.id)}
        source={spellingScope}
        libraryFilter={libraryFilter}
        libraryItems={libraryItems}
        onFinished={refresh}
      />
    );
  } else if (route === "/review" || route === "/review/review") {
    const storedDraft = wordRepository.getReviewDraft(user.id);
    if (route === "/review" && storedDraft?.mode === "new" && storedDraft.phase === "learning") {
      const newWords = dueWords.filter((item) => memoryState(item) === "new");
      content = <NewStudyPage key={`${user.id}-${route}`} user={user} newWords={newWords} allWords={words} groupWords={wordRepository.getDailyGroupWords(user.id)} onFinished={refresh} />;
    } else {
      // 保留旧版“混合复习”草稿的恢复能力；新会话不会把新词混进复习。
      const hasLegacyMixedDraft = Boolean(storedDraft && (storedDraft.mode === "all" || storedDraft.mode === undefined));
      const reviewMode: ReviewMode = route === "/review/review" ? "review" : hasLegacyMixedDraft ? "all" : "review";
      content = <ReviewPage key={`${user.id}-${route}`} user={user} dueWords={dueWords} allWords={words} groupWords={wordRepository.getDailyGroupWords(user.id)} mode={reviewMode} onFinished={refresh} />;
    }
  } else {
    content = <HomePage user={user} words={words} dueWords={dueWords} onChanged={refresh} onLoadDemo={async () => { await wordRepository.loadDemoWords(user.id); refresh(); }} />;
  }

  return <PageShell route={route} user={user} themeMode={themeMode} onThemeChange={changeTheme} contentKey={contentKey} storageStatus={storageStatus} onDownloadDamagedData={downloadDamagedData} onStartFresh={startFresh}>{content}</PageShell>;
}
