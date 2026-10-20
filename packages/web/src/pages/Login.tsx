import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Logo } from "../App";
import { Button, Card, Input } from "../lib/ui";

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
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16 animate-slide-up">
      <Logo className="text-2xl" />
      <p className="mt-3 text-sm text-slate-400">이 대시보드는 접속 토큰으로 보호되어 있어요. BlockPilot을 실행한 터미널 로그나 <code className="font-mono text-slate-300">BLOCKPILOT_TOKEN</code> 환경 변수에서 확인하세요.</p>
      <Card className="mt-6">
        <form onSubmit={submit} className="space-y-3">
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input className="pl-9" mono type="password" placeholder="접속 토큰" value={token} onChange={(e) => setTokenInput(e.target.value)} autoFocus required />
          </div>
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <Button variant="primary" type="submit" loading={busy} className="w-full">
            입장
          </Button>
        </form>
      </Card>
    </div>
  );
}
