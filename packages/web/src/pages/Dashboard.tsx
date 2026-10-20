import { Link, useParams } from "react-router-dom";
import { Activity, Boxes, Coffee, Copy, Gamepad2, Globe, Layers, ShieldCheck, Swords, Users, type LucideIcon } from "lucide-react";
import { useSendCommand, useServer } from "../api/hooks";
import { loaderLabel } from "../App";
import { useConsole } from "../lib/useConsole";
import { ProcessControls } from "../components/ProcessControls";
import { Avatar, Badge, Callout, Card, ConfirmButton, StatusBadge, cx, fmtAgo, useToast } from "../lib/ui";

export default function Dashboard() {
  const { id = "" } = useParams();
  const { data: s } = useServer(id);
  const sendCmd = useSendCommand(id);
  const toast = useToast();
  const { lines, status } = useConsole(id);
  if (!s) return null;

  const state = status?.state ?? s.process.state;
  const players = state === "external" ? s.process.onlinePlayers : (status?.onlinePlayers ?? s.process.onlinePlayers);
  const rcon = s.process.rcon;
  const canCommand = state === "running" || (state === "external" && rcon === "connected");
  const startedAt = status?.startedAt ?? s.process.startedAt;
  const cmd = (c: string, okMsg: string) => sendCmd.mutate(c, { onSuccess: () => toast("ok", okMsg), onError: (e) => toast("err", (e as Error).message) });
  const copyPath = () => navigator.clipboard?.writeText(s.path).then(() => toast("info", "경로를 복사했습니다."));

  return (
    <div className="space-y-5">
      {/* 히어로 */}
      <section className="surface relative overflow-hidden p-6">
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-white">{s.name}</h1>
              <StatusBadge state={state} />
              {state === "running" && startedAt && <span className="text-xs text-slate-500 tnum">{fmtAgo(startedAt)} 전 시작</span>}
            </div>
            <button onClick={copyPath} className="group mt-1.5 inline-flex max-w-full items-center gap-1.5 font-mono text-[12px] text-slate-500 hover:text-slate-300" title="경로 복사">
              <span className="truncate">{s.path}</span>
              <Copy className="h-3 w-3 shrink-0 opacity-0 transition group-hover:opacity-100" />
            </button>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="brand">{loaderLabel(s.loader)} {s.loaderVersion}</Badge>
              <Badge>Minecraft {s.mcVersion ?? "?"}</Badge>
              <Badge>
                <Coffee className="h-3 w-3" /> Java {s.javaVersion ?? "없음"}
              </Badge>
              <Badge>{s.hasStartScript ? "start.sh" : "java 직접 실행"}</Badge>
            </div>
          </div>
          <ProcessControls serverId={id} status={{ ...s.process, state, onlinePlayers: players }} size="lg" />
        </div>
      </section>

      {!s.eulaAccepted && (
        <Callout tone="warning" title="EULA 미동의">
          <code className="font-mono">eula.txt</code> 에 <code className="font-mono">eula=true</code> 가 없어 서버를 시작할 수 없습니다.
        </Callout>
      )}
      {state === "external" && rcon !== "connected" && (
        <Callout tone="info" title="BlockPilot 밖에서 실행 중인 서버예요">
          콘솔을 직접 볼 수 없지만,{" "}
          <Link to={`/s/${id}/settings`} className="underline underline-offset-2">
            서버 설정 → 네트워크
          </Link>
          에서 <b>RCON 사용</b>을 켜고 비밀번호를 정한 뒤 서버를 재시작하면 여기서 명령·중지·접속자 조회가 가능해요.
          {rcon === "failed" && <div className="mt-1 text-amber-300">RCON 설정은 있지만 연결에 실패했습니다. 비밀번호/포트를 확인해 주세요.</div>}
        </Callout>
      )}

      {/* 통계 */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={Users} label="접속자" value={`${players.length}`} sub={`/ ${s.properties.maxPlayers}명`} tone="brand" />
        <Stat icon={Boxes} label={s.loader === "paper" ? "플러그인" : "모드"} value={`${s.modCount}`} sub="개 설치됨" to={`/s/${id}/mods`} />
        <Stat icon={Swords} label="난이도" value={difficultyLabel(s.properties.difficulty)} to={`/s/${id}/settings`} />
        <Stat icon={Gamepad2} label="게임모드" value={gamemodeLabel(s.properties.gamemode)} to={`/s/${id}/settings`} />
        <Stat icon={ShieldCheck} label="화이트리스트" value={s.properties.whitelist ? "켜짐" : "꺼짐"} tone={s.properties.whitelist ? "ok" : "warn"} to={`/s/${id}/players`} />
        <Stat icon={Globe} label="포트" value={String(s.properties.port)} />
        <Stat icon={Layers} label="월드" value={s.levelName} to={`/s/${id}/backups`} />
        <Stat icon={Activity} label="MOTD" value={s.properties.motd || "(없음)"} small />
      </section>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* 접속자 */}
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">접속 중인 플레이어</h2>
            <Badge tone={players.length ? "success" : "neutral"}>{players.length}명</Badge>
          </div>
          {players.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">{canCommand ? "아무도 접속해 있지 않아요." : "서버가 실행 중일 때 표시됩니다."}</p>
          ) : (
            <ul className="space-y-1.5">
              {players.map((p) => (
                <li key={p} className="flex items-center gap-3 rounded-lg border border-line bg-ink-2/60 px-3 py-2">
                  <Avatar id={p} size={28} />
                  <span className="flex-1 truncate text-sm font-medium">{p}</span>
                  {canCommand && (
                    <div className="flex gap-1">
                      <ConfirmButton size="sm" variant="ghost" label="킥" confirmLabel="킥?" onConfirm={() => cmd(`kick ${p}`, `${p} 추방`)} />
                      <ConfirmButton size="sm" variant="ghost" label="밴" confirmLabel="밴?" className="text-rose-300" onConfirm={() => cmd(`ban ${p}`, `${p} 밴`)} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 콘솔 미리보기 */}
        <Card padded={false} className="overflow-hidden lg:col-span-3">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-semibold text-white">최근 콘솔</h2>
            <Link to={`/s/${id}/console`} className="text-xs text-brand-400 hover:underline">
              콘솔 열기 →
            </Link>
          </div>
          <pre className="terminal max-h-64 overflow-auto bg-ink-0/70 px-4 py-3 text-slate-300">
            {lines.length ? lines.slice(-14).map((l) => l.text).join("\n") : <span className="text-slate-600">아직 출력이 없습니다. 서버를 시작하면 여기에 로그가 흘러요.</span>}
          </pre>
        </Card>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub, to, tone, small }: { icon: LucideIcon; label: string; value: string; sub?: string; to?: string; tone?: "brand" | "ok" | "warn"; small?: boolean }) {
  const iconTone = tone === "brand" ? "text-brand-400 bg-brand-500/10" : tone === "ok" ? "text-emerald-400 bg-emerald-500/10" : tone === "warn" ? "text-amber-400 bg-amber-500/10" : "text-slate-400 bg-ink-3";
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{label}</span>
        <span className={cx("grid h-7 w-7 place-items-center rounded-lg", iconTone)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className={cx("mt-2 truncate font-semibold text-white tnum", small ? "text-sm" : "text-xl")}>
        {value}
        {sub && <span className="ml-1 text-xs font-normal text-slate-500">{sub}</span>}
      </div>
    </>
  );
  const cls = "surface block p-4 transition";
  return to ? (
    <Link to={to} className={cx(cls, "hover:border-line-strong hover:bg-ink-2/80")}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export const difficultyLabel = (d: string) => ({ peaceful: "평화로움", easy: "쉬움", normal: "보통", hard: "어려움" })[d] ?? d;
export const gamemodeLabel = (g: string) => ({ survival: "서바이벌", creative: "크리에이티브", adventure: "어드벤처", spectator: "관전" })[g] ?? g;
