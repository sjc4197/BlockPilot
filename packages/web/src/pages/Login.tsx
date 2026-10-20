import { useState, type FormEvent } from "react";
import { btn, card, cx, input } from "../lib/ui";

export default function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", { headers: { authorization: `Bearer ${token.trim()}` } });
      const data = (await res.json()) as { authenticated: boolean };
      if (data.authenticated) onLogin(token.trim());
      else setError("토큰이 올바르지 않습니다.");
    } catch {
      setError("서버에 연결할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-6 py-24">
      <h1 className="text-2xl font-bold tracking-tight">
        Block<span className="text-emerald-400">Pilot</span>
      </h1>
      <p className="mt-2 text-sm text-slate-400">이 대시보드는 접속 토큰으로 보호되어 있습니다. BlockPilot을 실행한 터미널 로그나 BLOCKPILOT_TOKEN 환경 변수에서 토큰을 확인하세요.</p>
      <form onSubmit={submit} className={cx(card, "mt-6 space-y-3")}>
        <input className={cx(input, "console-font")} type="password" placeholder="접속 토큰" value={token} onChange={(e) => setTokenInput(e.target.value)} autoFocus required />
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button className={cx(btn.base, btn.primary, "w-full justify-center")} disabled={busy}>
          {busy ? "확인 중..." : "입장"}
        </button>
      </form>
    </div>
  );
}
