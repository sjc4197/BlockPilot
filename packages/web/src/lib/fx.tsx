import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

/** 이 탭에서 이미 한 번 보여 준 연출 (화면을 옮길 때마다 다시 보이지 않게) */
const played = new Set<string>();
/** 처음 볼 때만 true. 같은 key 로 두 번째부터는 false */
export function usePlayOnce(key: string) {
  const [first] = useState(() => !played.has(key));
  useEffect(() => {
    played.add(key);
  }, [key]);
  return first;
}

/**
 * 경험치 바: 끝낸 단계 수가 레벨, 전체 진행률이 바. 칸 단위(5%)로 차오른다.
 * tone=failed 면 빛을 끈다.
 */
export function XpBar({ level, value, caption, right, tone = "active", className }: { level: number; value: number; caption?: React.ReactNode; right?: React.ReactNode; tone?: "active" | "done" | "failed"; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.floor((value * 100) / 5) * 5));
  const prev = useRef(level);
  const [pop, setPop] = useState(0);
  useEffect(() => {
    if (level > prev.current) setPop((n) => n + 1);
    prev.current = level;
  }, [level]);
  return (
    <div className={cx("xp", tone === "failed" && "xp-failed", className)}>
      <div key={pop} className={cx("xp-level tnum", pop > 0 && "xp-pop")} aria-label={`레벨 ${level}`}>
        {level}
      </div>
      <div className="xp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {(caption || right) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-block text-[12px] text-slate-400">
          <span className="text-slate-200">{caption}</span>
          <span className="tnum">{right}</span>
        </div>
      )}
    </div>
  );
}
