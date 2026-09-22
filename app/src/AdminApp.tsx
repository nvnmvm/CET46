import { useEffect, useState, type FormEvent } from "react";
import { ApiError, apiClient } from "./data/apiClient";
import type { LocalUser } from "./types";
import AdminUsersPage from "./pages/AdminUsersPage";

type AdminState = "checking" | "anonymous" | "forbidden" | "ready";

function authMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "操作未完成，请稍后重试。";
  if (error.code === "invalid_credentials") return "邮箱或密码不正确。";
  if (error.code === "account_disabled") return "账号已被管理员禁用。";
  if (error.status === 0) return "无法连接服务器，请检查网络后重试。";
  return error.message || "操作未完成，请稍后重试。";
}

function AdminLogin({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onLogin(email.trim(), password);
      setPassword("");
    } catch (cause) {
      setError(authMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10">
    <section className="w-full rounded-3xl bg-white p-7 shadow-card ring-1 ring-slate-200">
      <p className="text-sm font-semibold text-blue-700">CET 真题背词</p>
      <h1 className="mt-2 text-3xl font-bold">管理员后台</h1>
      <p className="mt-3 text-sm leading-6 text-slate-500">仅限管理员账号。学习请返回前台。</p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <label className="grid gap-2 text-sm font-medium">邮箱<input className="rounded-xl border p-3" type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className="grid gap-2 text-sm font-medium">密码<input className="rounded-xl border p-3" type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        <button className="button-primary w-full" type="submit" disabled={busy}>{busy ? "正在登录…" : "登录后台"}</button>
      </form>
      <a className="mt-5 inline-flex text-sm text-blue-700" href="/">返回学习前台</a>
    </section>
  </main>;
}

export default function AdminApp() {
  const [state, setState] = useState<AdminState>("checking");
  const [user, setUser] = useState<LocalUser | null>(null);
  const [error, setError] = useState("");

  async function resolveAccess(nextUser: LocalUser | null) {
    setUser(nextUser);
    if (!nextUser) {
      setState("anonymous");
      return;
    }
    try {
      setState(await apiClient.adminStatus() ? "ready" : "forbidden");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setUser(null);
        setState("anonymous");
        return;
      }
      setError(authMessage(cause));
      setState("forbidden");
    }
  }

  useEffect(() => {
    let active = true;
    void apiClient.session().then((sessionUser) => { if (active) void resolveAccess(sessionUser); })
      .catch((cause) => { if (active) { setError(authMessage(cause)); setState("anonymous"); } });
    return () => { active = false; };
  }, []);

  async function login(email: string, password: string) {
    const nextUser = await apiClient.login(email, password);
    await resolveAccess(nextUser);
  }

  async function logout() {
    await apiClient.logout();
    setUser(null);
    setError("");
    setState("anonymous");
  }

  let surface: React.ReactNode;
  if (state === "checking") surface = <main className="grid min-h-screen place-items-center"><p role="status">正在检查管理员权限…</p></main>;
  else if (state === "anonymous") surface = <AdminLogin onLogin={login} />;
  else if (state === "forbidden") surface = <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10"><section className="w-full rounded-3xl bg-white p-7 text-center shadow-card ring-1 ring-slate-200"><p className="text-sm font-semibold text-amber-700">无管理员权限</p><h1 className="mt-2 text-2xl font-bold">此账号不能进入管理员后台</h1><p className="mt-3 text-sm leading-6 text-slate-500">请退出后使用管理员账号登录。{error ? ` ${error}` : ""}</p><div className="mt-6 flex flex-wrap justify-center gap-3"><button className="button-primary" type="button" onClick={() => void logout()}>退出并重新登录</button><a className="button-secondary" href="/">返回学习前台</a></div></section></main>;
  else surface = <div className="min-h-screen bg-slate-50 text-slate-900"><header className="border-b border-slate-200 bg-slate-950 text-white"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4"><div><p className="text-xs text-slate-400">CET 真题背词</p><h1 className="text-xl font-bold">管理员后台</h1></div><div className="flex items-center gap-3"><span className="max-w-56 truncate text-sm text-slate-300">{user?.email}</span><a className="rounded-xl border border-slate-600 px-3 py-2 text-sm" href="/">学习前台</a><button className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-900" type="button" onClick={() => void logout()}>退出</button></div></div></header><main className="mx-auto max-w-6xl px-4 py-8">{user && <AdminUsersPage currentUserId={user.id} />}</main></div>;
  return <div key={state} className="admin-state-surface">{surface}</div>;
}
