import { Link, useParams } from "react-router-dom";
import { useProcessAction, useServer } from "../api/hooks";
import { loaderLabel } from "../App";
import { useConsole } from "../lib/useConsole";
import { btn, card, cx, StatusBadge, useToast, ConfirmButton } from "../lib/ui";

export default function Dashboard() {
  const { id = "" } = useParams();
  const { data: s } = useServer(id);
  const action = useProcessAction(id);
  const toast = useToast();
  const { lines, status } = useConsole(id);
  if (!s) return null;

  const state = status?.state ?? s.process.state;
  const players = status?.onlinePlayers ?? s.process.onlinePlayers;
  const busy = action.isPending || state === "starting" || state === "stopping";

  const run = (a: "start" | "stop" | "restart") =>
    action.mutate(a, {
      onSuccess: () => toast("ok", a === "start" ? "서버를 시작했습니다." : a === "stop" ? "서버를 중지했습니다." : "서버를 재시작했습니다."),
      onError: (err) => toast("err", (err as Error).message),
    });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{s.name}</h1>
          <p className="mt-1 text-sm text-slate-400">{s.path}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge state={state} />
          {state === "stopped" && (
            <button className={cx(btn.base, btn.primary)} disabled={busy} onClick={() => run("start")}>
              ▶ 시작
            </button>
          )}
          {(state === "running" || state === "starting") && (
            <>
              <ConfirmButton label="■ 중지" confirmLabel="정말 중지?" disabled={busy} onConfirm={() => run("stop")} />
              <ConfirmButton label="↻ 재시작" confirmLabel="정말 재시작?" disabled={busy} onConfirm={() => run("restart")} />
            </>
          )}
          {state === "external" && <span className="text-xs text-slate-400">다른 곳에서 실행 중 — 여기서는 제어할 수 없습니다</span>}
        </div>
      </header>

      {!s.eulaAccepted && (
        <div className="rounded-lg border border-amber-600/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          eula.txt에 동의(eula=true)가 되어 있지 않아 서버를 시작할 수 없습니다.
        </div>
      )}

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="로더" value={`${loaderLabel(s.loader)} ${s.loaderVersion ?? ""}`} />
        <Stat label="마인크래프트" value={s.mcVersion ?? "알 수 없음"} />
        <Stat label="접속자" value={`${players.length} / ${s.properties.maxPlayers}`} />
        <Stat label="모드" value={`${s.modCount}개`} to={`/s/${id}/mods`} />
        <Stat label="난이도" value={difficultyLabel(s.properties.difficulty)} to={`/s/${id}/settings`} />
        <Stat label="게임모드" value={gamemodeLabel(s.properties.gamemode)} to={`/s/${id}/settings`} />
        <Stat label="화이트리스트" value={s.properties.whitelist ? "켜짐" : "꺼짐"} to={`/s/${id}/players`} />
        <Stat label="포트" value={String(s.properties.port)} />
      </section>

      <section className={card}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">접속 중인 플레이어</h2>
        </div>
        {players.length === 0 ? (
          <p className="text-sm text-slate-500">{state === "running" ? "아무도 접속해 있지 않습니다." : "서버가 실행 중일 때 표시됩니다."}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {players.map((p) => (
              <li key={p} className="flex items-center gap-2 rounded-md bg-slate-800 px-2.5 py-1 text-sm">
                <img src={`https://mc-heads.net/avatar/${p}/20`} alt="" className="h-5 w-5 rounded-sm" />
                {p}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">최근 콘솔</h2>
          <Link to={`/s/${id}/console`} className="text-xs text-emerald-400 hover:underline">
            콘솔 열기 →
          </Link>
        </div>
        <pre className="console-font max-h-56 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-300">
          {lines.length ? lines.slice(-12).map((l) => l.text).join("\n") : "아직 출력이 없습니다."}
        </pre>
      </section>

      <section className={cx(card, "text-xs text-slate-400 grid grid-cols-2 md:grid-cols-3 gap-y-1")}>
        <div>Java: {s.javaVersion ?? "찾을 수 없음"}</div>
        <div>월드: {s.levelName}</div>
        <div>시작 스크립트: {s.hasStartScript ? "start.sh 사용" : "java 직접 실행"}</div>
        <div>MOTD: {s.properties.motd}</div>
      </section>
    </div>
  );
}

function Stat({ label, value, to }: { label: string; value: string; to?: string }) {
  const inner = (
    <>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 truncate font-semibold">{value}</div>
    </>
  );
  return to ? (
    <Link to={to} className={cx(card, "block py-4 hover:border-slate-600")}>
      {inner}
    </Link>
  ) : (
    <div className={cx(card, "py-4")}>{inner}</div>
  );
}

export const difficultyLabel = (d: string) => ({ peaceful: "평화로움", easy: "쉬움", normal: "보통", hard: "어려움" })[d] ?? d;
export const gamemodeLabel = (g: string) => ({ survival: "서바이벌", creative: "크리에이티브", adventure: "어드벤처", spectator: "관전" })[g] ?? g;
