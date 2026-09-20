import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiClient, type AdminUser } from "../data/apiClient";

const PAGE_SIZE = 20;
function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "此账号没有管理员权限。";
    if (error.status === 401) return "登录状态已过期，请重新登录。";
    if (error.status === 0) return "网络连接失败，操作结果尚未确认，请刷新账号列表核对后重试。";
    if (error.status >= 500) return "服务器暂时异常，操作结果尚未确认，请稍后核对。";
    return error.message;
  }
  return "操作未完成，请稍后重试。";
}

/** Hidden for learners; this is convenience only, not the authorization boundary. */
export function AdminEntry({ userId }: { userId: string }) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let active = true;
    setAllowed(false);
    void apiClient.adminStatus().then((value) => { if (active) setAllowed(value); })
      .catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, [userId]);
  return allowed ? <a href="#/admin" className="button-secondary">账号管理</a> : null;
}

export default function AdminUsersPage({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [action, setAction] = useState<"status" | "password">("status");
  const [resetPassword, setResetPassword] = useState("");
  const alive = useRef(true);
  const requestVersion = useRef(0);
  const busy = useRef(false);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (target) confirmHeading.current?.focus();
  }, [target, action]);

  function choose(user: AdminUser, nextAction: "status" | "password") {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTarget(user);
    setAction(nextAction);
    setResetPassword("");
  }

  function cancel() {
    setTarget(null);
    setResetPassword("");
    opener.current?.focus();
  }

  async function load(page: number) {
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const result = await apiClient.adminUsers({ limit: PAGE_SIZE, offset: page });
      if (!alive.current || version !== requestVersion.current) return;
      setUsers(result.users);
      setTotal(result.total);
      setAuthorized(true);
    } catch (cause) {
      if (alive.current && version === requestVersion.current) {
        setError(`账号列表未能刷新：${message(cause)}`);
        setUsers([]);
        setAuthorized(false);
        setTarget(null);
        setPassword("");
        setResetPassword("");
      }
    } finally {
      if (alive.current && version === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load(offset);
    return () => { alive.current = false; requestVersion.current++; };
  }, [offset, currentUserId]);

  async function mutate(operation: () => Promise<void>, success: string) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await operation();
      if (!alive.current) return;
      setPassword("");
      setResetPassword("");
      setNotice(success);
      setTarget(null);
      await load(offset);
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      busy.current = false;
      if (alive.current) {
        setSaving(false);
        setPassword("");
        setResetPassword("");
      }
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    const input = { email: email.trim(), username: username.trim(), password };
    void mutate(() => apiClient.adminCreateUser(input), "账号已创建，可使用邮箱和初始密码登录。");
  }

  function confirm(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    const selected = target;
    void mutate(() => action === "status"
      ? apiClient.adminSetDisabled(selected.id, !selected.disabledAt)
      : apiClient.adminResetPassword(selected.id, resetPassword),
    action === "password" ? "密码已重置，原有会话已撤销。"
      : selected.disabledAt ? "账号已启用。" : "账号已禁用，原有会话已撤销，学习数据保留。");
  }

  return <section className="space-y-6" aria-labelledby="admin-title">
    <header>
      <a className="text-sm text-blue-700" href="#/profile">← 返回个人页</a>
      <h1 id="admin-title" className="mt-3 text-2xl font-bold">账号管理</h1>
      <p className="mt-2 text-sm text-slate-600">仅管理账号，不查看或修改其他人的词库与学习记录。禁用账号不会删除数据。</p>
    </header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{error}</p>}
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-emerald-800">{notice}</p>}
    {authorized && <form onSubmit={create} className="rounded-3xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold">创建账号</h2>
      <fieldset disabled={saving || loading} className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">邮箱<input className="min-w-0 rounded-xl border p-3" type="email" autoComplete="off" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="grid gap-2 text-sm">显示名称<input className="min-w-0 rounded-xl border p-3" required maxLength={40} value={username} onChange={e => setUsername(e.target.value)} /></label>
        <label className="grid gap-2 text-sm sm:col-span-2">初始密码<input className="min-w-0 rounded-xl border p-3" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /><span className="text-slate-500">使用至少 12 位的独立密码，通过私下安全渠道交给账号本人。</span></label>
        <button className="button-primary" type="submit">{saving ? "正在保存…" : "创建账号"}</button>
      </fieldset>
    </form>}
    <section className="rounded-3xl border border-slate-200 bg-white p-5" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">账号列表（{total}）</h2><button type="button" className="button-secondary" disabled={saving || loading} onClick={() => void load(offset)}>刷新列表</button></div>
      {loading ? <p role="status" className="py-6">正在加载账号…</p> : <ul className="mt-4 divide-y divide-slate-100">
        {users.map(user => <li key={user.id} className="flex min-w-0 flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1 break-words"><p className="font-semibold">{user.username || "未设置名称"}{user.id === currentUserId ? "（你）" : ""}</p><p className="break-all text-sm text-slate-600">{user.email}</p><p className="text-xs text-slate-500">{user.role === "admin" ? "管理员" : "普通账号"} · {user.disabledAt ? "已禁用" : "已启用"}</p></div>
          {user.role !== "admin" && <div className="flex flex-wrap gap-2">
            <button type="button" className="button-secondary" disabled={saving} onClick={() => choose(user, "status")}>{user.disabledAt ? "启用" : "禁用"}</button>
            <button type="button" className="button-secondary" disabled={saving} onClick={() => choose(user, "password")}>重置密码</button>
          </div>}
        </li>)}
      </ul>}
      <div className="mt-4 flex flex-wrap gap-3"><button className="button-secondary" disabled={loading || saving || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button><button className="button-secondary" disabled={loading || saving || offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</button></div>
    </section>
    {target && <form onSubmit={confirm} aria-labelledby="admin-confirm-title" className="rounded-3xl border border-amber-200 bg-amber-50 p-5">
      <h2 id="admin-confirm-title" ref={confirmHeading} tabIndex={-1} className="break-all font-semibold">确认{action === "password" ? "重置密码" : target.disabledAt ? "启用账号" : "禁用账号"}：{target.email}</h2>
      <p className="my-3 text-sm">{action === "password" ? "旧密码将失效，所有已登录设备将需要重新登录。" : target.disabledAt ? "此账号将可以再次登录。" : "此账号将无法登录，已登录设备的会话也会失效；学习数据不会删除。"}</p>
      <fieldset disabled={saving} className="space-y-3">
        {action === "password" && <label className="grid gap-2 text-sm">新密码<input className="min-w-0 rounded-xl border p-3" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={resetPassword} onChange={e => setResetPassword(e.target.value)} /></label>}
        <div className="flex flex-wrap gap-3"><button className="button-primary" type="submit">{saving ? "正在保存…" : "确认操作"}</button><button className="button-secondary" type="button" onClick={cancel}>取消</button></div>
      </fieldset>
    </form>}
  </section>;
}
