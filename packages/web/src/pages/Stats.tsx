import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Trophy, X } from "lucide-react";
import type { PlayerStats, StatCount } from "@blockpilot/shared";
import { useStats } from "../api/hooks";
import { Avatar, Button, Card, EmptyState, PageHeader, SectionTitle, Spinner, Tabs, cx, fmtDate } from "../lib/ui";

type Metric = "playMinutes" | "deaths" | "mined" | "walkedKm" | "mobKills";
const METRICS: { id: Metric; label: string; fmt: (p: PlayerStats) => string }[] = [
  { id: "playMinutes", label: "플레이 시간", fmt: (p) => fmtMinutes(p.playMinutes) },
  { id: "mined", label: "캔 블록", fmt: (p) => p.mined.toLocaleString() },
  { id: "walkedKm", label: "이동 거리", fmt: (p) => `${p.walkedKm.toLocaleString()}km` },
  { id: "mobKills", label: "잡은 몹", fmt: (p) => p.mobKills.toLocaleString() },
  { id: "deaths", label: "죽은 횟수", fmt: (p) => p.deaths.toLocaleString() },
];

function fmtMinutes(m: number) {
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간` : `${h}시간 ${m % 60}분`;
}
/** "minecraft:diamond_ore" → "Diamond Ore" */
const pretty = (id: string) => id.replace(/^minecraft:/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function Stats() {
  const { id = "" } = useParams();
  const { data, isLoading } = useStats(id);
  const [metric, setMetric] = useState<Metric>("playMinutes");
  const [open, setOpen] = useState<PlayerStats | null>(null);
  if (isLoading || !data) return <Spinner />;

  const m = METRICS.find((x) => x.id === metric)!;
  const ranked = [...data.players].sort((a, b) => b[metric] - a[metric]);
  const best = ranked[0]?.[metric] ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Trophy}
        title="통계"
        description={
          <span>
            월드 <code className="font-mono text-slate-300">{data.world}/stats</code> 를 읽어요.
            {data.savedAt && ` 마지막 저장 ${fmtDate(data.savedAt)}. 마인크래프트는 자동 저장(보통 5분) 때만 통계를 파일에 써요.`}
          </span>
        }
      />

      {!data.players.length ? (
        <EmptyState icon={Trophy} title="아직 통계가 없어요">
          플레이어가 접속해서 놀다가 서버가 자동 저장을 하면 여기에 점수판이 생겨요.
        </EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
          <Card className="space-y-4">
            <Tabs tabs={METRICS.map((x) => ({ id: x.id, label: x.label }))} value={metric} onChange={setMetric} />
            {/* 게임 속 사이드바 점수판처럼: 이름 왼쪽, 빨간 숫자 오른쪽 */}
            <ol className="scoreboard">
              <li className="scoreboard-title">{m.label}</li>
              {ranked.map((p, i) => (
                <li key={p.uuid}>
                  <button type="button" className="scoreboard-row focus-ring" onClick={() => setOpen(p)}>
                    <span className={cx("w-5 text-right font-pixel text-[11px] tnum", i === 0 ? "text-lamp" : "text-slate-500")}>{i + 1}</span>
                    <Avatar id={p.uuid} size={20} />
                    <span className="min-w-0 flex-1 truncate text-left">{p.name ?? p.uuid.slice(0, 8)}</span>
                    <span className="hidden h-1.5 w-24 bg-ink-1 sm:block">
                      <span className="block h-full bg-redstone/70" style={{ width: `${best ? Math.max(4, (p[metric] / best) * 100) : 0}%` }} />
                    </span>
                    <span className="w-24 text-right text-[#ff5555] tnum">{m.fmt(p)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Card>

          <Card className="space-y-3">
            <SectionTitle>이번 주 가장 오래 한 사람</SectionTitle>
            {data.week.length ? (
              <ol className="space-y-1.5">
                {data.week.slice(0, 8).map((w, i) => (
                  <li key={w.name} className="well flex items-center gap-3 px-3 py-1.5 text-sm">
                    <span className={cx("w-4 font-pixel text-[11px]", i === 0 ? "text-lamp" : "text-slate-500")}>{i + 1}</span>
                    <Avatar id={w.name} size={20} />
                    <span className="flex-1 truncate">{w.name}</span>
                    <span className="text-slate-300 tnum">{fmtMinutes(w.minutes)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-slate-500">BlockPilot 으로 켠 서버에 누가 들어오면 그날부터 쌓여요.</p>
            )}
          </Card>
        </div>
      )}

      {open && <PlayerDetail p={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PlayerDetail({ p, onClose }: { p: PlayerStats; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const row = (label: string, list: StatCount[]) => (
    <div>
      <div className="mb-1.5 font-block text-[12px] text-slate-400">{label}</div>
      {list.length ? (
        <ul className="space-y-1">
          {list.map((x) => (
            <li key={x.id} className="flex justify-between text-sm">
              <span className="text-slate-300">{pretty(x.id)}</span>
              <span className="text-white tnum">{x.n.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">기록 없음</p>
      )}
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal aria-label={`${p.name ?? "플레이어"} 기록`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass w-[min(520px,96vw)] space-y-4 p-5">
        <div className="flex items-center gap-3">
          <Avatar id={p.uuid} size={40} />
          <div className="min-w-0 flex-1">
            <div className="font-block text-[14px] text-white">{p.name ?? p.uuid}</div>
            <div className="text-[12px] text-slate-500">
              {fmtMinutes(p.playMinutes)} 플레이 · 죽음 {p.deaths} · 점프 {p.jumps.toLocaleString()} · 플레이어 처치 {p.playerKills}
            </div>
          </div>
          <Button size="sm" variant="ghost" icon={X} aria-label="닫기" onClick={onClose} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {row("많이 캔 블록", p.topMined)}
          {row("많이 잡은 몹", p.topKilled)}
          {row("나를 죽인 것", p.killedBy)}
        </div>
      </div>
    </div>
  );
}
