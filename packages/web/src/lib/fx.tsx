import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";
import { Heart } from "./pixel";

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

/**
 * 레드스톤 입자: 서버가 켜져 있는 동안 아주 천천히 떠오르는 빨간 점.
 * 화면이 숨겨지거나(탭 전환) 동작 줄이기 설정이면 그리지 않는다.
 */
export function RedstoneParticles({ active, className }: { active: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const g = cv.getContext("2d");
    if (!g) return;
    const SCALE = 3;
    type P = { x: number; y: number; v: number; life: number; max: number; s: number; drift: number };
    let parts: P[] = [];
    let raf = 0;
    let on = active;
    const fit = () => {
      cv.width = Math.max(1, Math.floor(cv.clientWidth / SCALE));
      cv.height = Math.max(1, Math.floor(cv.clientHeight / SCALE));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    fit();
    const spawn = (): P => ({ x: Math.random() * cv.width, y: cv.height + Math.random() * 6, v: 0.06 + Math.random() * 0.14, life: 0, max: 240 + Math.random() * 220, s: Math.random() < 0.3 ? 2 : 1, drift: (Math.random() - 0.5) * 0.05 });
    const frame = () => {
      g.clearRect(0, 0, cv.width, cv.height);
      if (on && parts.length < 40 && Math.random() < 0.25) parts.push(spawn());
      parts = parts.filter((p) => p.life < p.max && p.y > -4);
      for (const p of parts) {
        p.life++;
        p.y -= p.v;
        p.x += p.drift + Math.sin((p.life + p.x) / 30) * 0.05;
        const a = Math.sin((p.life / p.max) * Math.PI) * 0.7;
        g.fillStyle = `rgba(255, ${50 + (p.s - 1) * 40}, 40, ${a.toFixed(2)})`;
        g.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
      }
      raf = !document.hidden && (on || parts.length) ? requestAnimationFrame(frame) : 0;
    };
    const kick = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };
    (cv as HTMLCanvasElement & { __setOn?: (v: boolean) => void }).__setOn = (v) => {
      on = v;
      kick();
    };
    document.addEventListener("visibilitychange", kick);
    kick();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", kick);
    };
    // 켜고 끌 때는 아래 effect 가 __setOn 으로 알려서, 떠 있던 입자는 자연스럽게 사라지게 한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    (ref.current as (HTMLCanvasElement & { __setOn?: (v: boolean) => void }) | null)?.__setOn?.(active);
  }, [active]);
  return <canvas ref={ref} aria-hidden className={cx("pointer-events-none absolute inset-0 h-full w-full [image-rendering:pixelated]", className)} />;
}

/** 접속자 하트: 한 칸이 두 명. 바뀐 칸은 톡 튄다 */
export function PlayerHearts({ count, max }: { count: number; max: number }) {
  const hearts = Math.ceil(max / 2);
  const fills = Array.from({ length: hearts }, (_, h) => (count >= h * 2 + 2 ? 2 : count === h * 2 + 1 ? 1 : 0) as 0 | 1 | 2);
  const prev = useRef(fills);
  const changed = fills.map((f, i) => f !== prev.current[i]);
  useEffect(() => {
    prev.current = fills;
  });
  return (
    <span className="flex flex-wrap items-center gap-[3px]" role="img" aria-label={`접속자 ${count}명 / ${max}명`}>
      {fills.map((f, i) => (
        <span key={`${i}-${f}`} className={cx("inline-block", changed[i] && "heart-pop")}>
          <Heart fill={f} className="h-[18px] w-5" />
        </span>
      ))}
    </span>
  );
}

type ChatLine = { id: number; text: string; left: boolean };
/** 누가 들어오고 나가면 노란 채팅 줄로 잠깐 알린다 (처음 불러온 목록은 알리지 않음) */
export function JoinFeed({ players }: { players: string[] }) {
  const prev = useRef<string[] | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const key = players.join("\n");
  useEffect(() => {
    const before = prev.current;
    prev.current = players;
    if (!before) return;
    const joined = players.filter((p) => !before.includes(p));
    const left = before.filter((p) => !players.includes(p));
    const add = [...joined.map((p) => ({ text: `${p} 님이 게임에 참여했어요`, left: false })), ...left.map((p) => ({ text: `${p} 님이 게임을 떠났어요`, left: true }))];
    if (!add.length) return;
    const stamped = add.map((l) => ({ ...l, id: Date.now() + Math.random() }));
    setLines((all) => [...all, ...stamped].slice(-4));
    const ids = stamped.map((l) => l.id);
    setTimeout(() => setLines((all) => all.filter((l) => !ids.includes(l.id))), 12000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!lines.length) return null;
  return (
    <div className="mt-3 space-y-0.5 font-block text-[12px]" aria-live="polite">
      {lines.map((l) => (
        <div key={l.id} className={cx("chat-line", l.left ? "text-[#e6e66a]/80" : "text-[#ffff55]")}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
