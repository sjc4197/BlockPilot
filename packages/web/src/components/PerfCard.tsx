import type { PerfSample } from "@blockpilot/shared";
import { usePerf } from "../api/hooks";
import { Callout, Card, SectionTitle, cx } from "../lib/ui";

const WINDOW = 30 * 60_000;

/** 최근 30분 꺾은선. ref 가 있으면 기준선(틱 50ms 등)을 점선으로 */
function Spark({ points, max, refLine, tone }: { points: { t: number; v: number }[]; max: number; refLine?: number; tone: string }) {
  const W = 300;
  const H = 52;
  const now = Date.now();
  // 막 재기 시작했을 때 점이 오른쪽 끝에 몰리지 않게, 첫 측정부터 최소 5분 ~ 최대 30분으로 넓힌다
  const span = Math.min(WINDOW, Math.max(5 * 60_000, now - (points[0]?.t ?? now)));
  const x = (t: number) => W - ((now - t) / span) * W;
  const y = (v: number) => H - 3 - (Math.min(v, max) / max) * (H - 8);
  const pts = points.filter((p) => now - p.t <= span);
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[52px] w-full" preserveAspectRatio="none" aria-hidden>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#2c2c33" strokeWidth={1} />
      ))}
      {refLine !== undefined && <line x1={0} x2={W} y1={y(refLine)} y2={y(refLine)} stroke="#ff3b2f" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />}
      {pts.length > 1 && <polygon points={`${x(pts[0].t)},${H} ${line} ${x(last.t)},${H}`} fill={tone} opacity={0.15} />}
      {pts.length > 1 && <polyline points={line} fill="none" stroke={tone} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      {last && <rect x={x(last.t) - 3} y={y(last.v) - 3} width={6} height={6} fill={tone} />}
    </svg>
  );
}

const fmtGb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);

export function PerfCard({ serverId }: { serverId: string }) {
  const { data: p } = usePerf(serverId);
  if (!p) return null;
  const mem = p.samples.filter((s): s is PerfSample & { memMb: number } => s.memMb !== undefined).map((s) => ({ t: s.t, v: s.memMb }));
  const tick = p.samples.filter((s): s is PerfSample & { mspt: number } => s.mspt !== undefined).map((s) => ({ t: s.t, v: s.mspt }));
  const curMem = mem[mem.length - 1]?.v;
  const curTick = tick[tick.length - 1]?.v;
  const tickTone = curTick === undefined ? "#80ff20" : curTick >= 50 ? "#ff3b2f" : curTick >= 30 ? "#ffb347" : "#80ff20";

  return (
    <Card className="space-y-4">
      <SectionTitle right={<span className="font-block text-[11px] text-slate-500">최근 최대 30분</span>}>성능</SectionTitle>
      {!p.measuring ? (
        <p className="py-6 text-center text-sm text-slate-500">서버가 켜져 있을 때 측정해요. 대시보드를 보고 있는 동안만 재요.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-block text-[12px] text-slate-400">메모리</span>
              <span className="tnum text-sm text-white">
                {curMem !== undefined ? fmtGb(curMem) : "재는 중…"}
                {p.maxMemMb && <span className="text-xs text-slate-500"> / 설정 {fmtGb(p.maxMemMb)}</span>}
              </span>
            </div>
            <Spark points={mem} max={Math.max(p.maxMemMb ? p.maxMemMb * 1.4 : 0, ...mem.map((m) => m.v * 1.15), 256)} refLine={p.maxMemMb} tone="#ffb347" />
            <p className="text-[11px] text-slate-500">자바는 설정(-Xmx)보다 몇백 MB 더 쓰는 게 정상이에요.</p>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-block text-[12px] text-slate-400">틱 시간</span>
              <span className={cx("tnum text-sm", curTick !== undefined && curTick >= 50 ? "text-red-300" : "text-white")}>
                {p.tick === "unsupported" ? "이 버전은 측정 안 됨" : curTick !== undefined ? `${curTick.toFixed(1)}ms` : "재는 중…"}
                <span className="text-xs text-slate-500"> / 한계 50ms</span>
              </span>
            </div>
            {p.tick === "unsupported" ? (
              <p className="py-3 text-[12px] text-slate-500">1.20.2 이하는 틱 시간을 잴 수 없어서, 렉 경고 횟수만 보여 줘요.</p>
            ) : (
              <Spark points={tick} max={Math.max(60, ...tick.map((t) => t.v * 1.15))} refLine={50} tone={tickTone} />
            )}
            <p className="text-[11px] text-slate-500">50ms 를 넘으면 서버가 느려져요(렉). 30초마다 재요.</p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-block text-[12px] text-slate-400">렉 경고</span>
        <span className={cx("tnum", p.lag.lastHour ? "text-amber-300" : "text-slate-300")}>최근 1시간 {p.lag.lastHour}번</span>
        {p.lag.worstMs && <span className="text-[12px] text-slate-500">· 가장 심할 때 {(p.lag.worstMs / 1000).toFixed(1)}초 밀림</span>}
      </div>
      {p.advice && <Callout tone="warning">{p.advice}</Callout>}
    </Card>
  );
}
