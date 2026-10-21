import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import type { AutomationView, ProcessState } from "@blockpilot/shared";
import { TntIcon } from "../lib/pixel";
import { Badge, Button, fmtDate } from "../lib/ui";

const KEY = "blockpilot.crash.dismissed";
const readDismissed = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** 대시보드 위쪽: 마지막 크래시의 원인 추정과 자동 재시작 상태 */
export function CrashBanner({ serverId, view, state }: { serverId: string; view: AutomationView; state: ProcessState }) {
  const crash = view.lastCrash;
  const [dismissed, setDismissed] = useState(readDismissed);
  const [now, setNow] = useState(Date.now());
  const pending = view.autoRestart.pendingAt ? new Date(view.autoRestart.pendingAt).getTime() : 0;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending]);

  if (!crash || dismissed === `${serverId}:${crash.at}`) return null;
  // 다시 켜져서 30분이 지나면 숨긴다
  if (state === "running" && Date.now() - new Date(crash.at).getTime() > 30 * 60_000) return null;
  const left = Math.max(0, Math.ceil((pending - now) / 1000));

  return (
    <section className="flex gap-4 bg-[#1f0a08] px-5 py-4 shadow-[inset_0_0_0_2px_rgba(255,59,47,.45)]" role="alert">
      <TntIcon className="mt-0.5 h-7 w-7 shrink-0" primed={!!pending} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 font-block text-[12px]">
          <span className="text-red-300">서버가 갑자기 꺼졌어요</span>
          <span className="text-slate-500 tnum">{fmtDate(crash.at)}</span>
          {pending > 0 && <Badge tone="warning">{left > 0 ? `${left}초 뒤 다시 켜요` : "다시 켜는 중…"}</Badge>}
          {view.autoRestart.gaveUp && <Badge tone="danger">반복해서 꺼져 자동 재시작을 멈췄어요</Badge>}
        </div>
        <p className="text-sm text-white">{crash.title}</p>
        <p className="text-sm text-slate-400">{crash.hint}</p>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {crash.suspects.map((s) => (
            <Link key={s.file ?? s.name} to={`/s/${serverId}/mods`} className="focus-ring">
              <Badge tone="danger">{s.name}</Badge>
            </Link>
          ))}
          {crash.reportFile && (
            <Link to={`/s/${serverId}/logs`} className="font-mono text-[11px] text-red-300 underline underline-offset-2">
              crash-reports/{crash.reportFile}
            </Link>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={X}
        aria-label="닫기"
        onClick={() => {
          const v = `${serverId}:${crash.at}`;
          try {
            sessionStorage.setItem(KEY, v);
          } catch {
            /* 저장 못 해도 이번 화면에서만 닫힘 */
          }
          setDismissed(v);
        }}
      />
    </section>
  );
}
