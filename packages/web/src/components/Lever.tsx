import type { CSSProperties } from "react";
import { cx } from "../lib/ui";

const STONE_A = "#8f8f8f";
const STONE_B = "#5e5e5e";
const STONE_C = "#737373";
const STICK = "#7a5230";
const STICK_HI = "#9c6b3c";
const KNOB_OFF = "#3a3a3a";
const KNOB_ON = "#ff3b2f";

/** 로고용 정적 레버 마크 (8x8 픽셀) */
export function PixelLeverMark({ className }: { className?: string }) {
  const map = [".....kk.", "....hs..", "...ss...", "..ss....", ".ss.....", "cCcCcCcC", "CcCcCcCc"];
  const pal: Record<string, string> = { k: KNOB_OFF, h: STICK_HI, s: STICK, c: STONE_A, C: STONE_B };
  return (
    <svg viewBox="0 -0.5 8 8" className={className} shapeRendering="crispEdges" aria-hidden>
      {map.flatMap((row, y) =>
        [...row].map((ch, x) => (pal[ch] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={pal[ch]} /> : null)),
      )}
    </svg>
  );
}

/** 레드스톤 가루 한 줄. lit 개수만큼 왼쪽부터 켜져 있음 (로고 장식용) */
export function DustRow({ count, lit, size, className }: { count: number; lit: number; size: number; className?: string }) {
  return (
    <span className={cx("flex justify-between", className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="dust" data-lit={i < lit} style={{ width: size, height: size, transform: i % 3 === 1 ? `translateY(${Math.max(1, size / 3)}px)` : undefined }} />
      ))}
    </span>
  );
}

// 조약돌 받침 무늬 (12 x 3)
const COBBLE = ["abaabbabaaba", "babbaabbabab", "aabbabaabbaa"];

export type LeverVisual = "off" | "starting" | "on" | "stopping";

/**
 * 서버 전원 레버. 당기면 손잡이가 넘어가고 레드스톤 가루가 레버 쪽부터 차례로 켜진다.
 * starting/stopping 동안은 신호가 흘러가는 애니메이션.
 */
export function Lever({
  visual,
  armed,
  disabled,
  busy,
  size = "sm",
  label,
  hint,
  title,
  onClick,
}: {
  visual: LeverVisual;
  armed?: boolean;
  disabled?: boolean;
  /** 신호가 흐르는 중(시작/중지 진행 중). 흐리게 만들지 않고 클릭만 무시 */
  busy?: boolean;
  size?: "sm" | "lg";
  label: string;
  hint?: string;
  title?: string;
  onClick: () => void;
}) {
  const on = visual === "on" || visual === "starting";
  const state = visual === "on" ? "running" : visual === "off" ? "stopped" : visual;
  const lg = size === "lg";
  const dustCount = lg ? 8 : 5;
  const dustSize = lg ? 6 : 4;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title ?? label}
      title={title}
      disabled={disabled}
      aria-busy={busy}
      onClick={busy ? undefined : onClick}
      data-on={on}
      data-state={state}
      data-armed={!!armed}
      className={cx(
        "lever inline-flex items-center rounded-xl border text-left transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        busy && "cursor-progress",
        lg ? "gap-3 py-2 pl-2 pr-4" : "h-9 gap-2 pl-1 pr-3",
        armed ? "border-rose-500/60 bg-rose-500/10" : "border-line-strong bg-ink-2/70 hover:border-slate-500/50 hover:bg-ink-3",
      )}
    >
      <svg viewBox="0 0 16 14" className={lg ? "h-12 w-12" : "h-8 w-8"} shapeRendering="crispEdges" aria-hidden>
        <g className="lever-handle">
          <rect x={7} y={2} width={2} height={9} fill={STICK} />
          <rect x={7} y={2} width={1} height={9} fill={STICK_HI} />
          <rect className="lever-knob" x={6.5} y={0.5} width={3} height={2.5} fill={on ? KNOB_ON : KNOB_OFF} />
        </g>
        <rect x={5} y={9} width={6} height={2} fill={STONE_C} />
        <rect x={5} y={9} width={6} height={0.6} fill={STONE_A} />
        {COBBLE.flatMap((row, y) => [...row].map((ch, x) => <rect key={`${x}-${y}`} x={2 + x} y={11 + y} width={1} height={1} fill={ch === "a" ? STONE_A : STONE_B} />))}
      </svg>
      <span className="flex flex-col gap-1.5">
        <span className={cx("font-medium leading-none", lg ? "text-sm" : "text-xs", armed ? "text-rose-300" : on ? "text-red-300" : "text-slate-300")}>{label}</span>
        <span className="flex items-end" style={{ gap: lg ? 4 : 3 }}>
          {Array.from({ length: dustCount }, (_, i) => (
            <span key={i} className="dust" style={{ width: dustSize, height: dustSize, "--i": i, transform: i % 3 === 1 ? "translateY(-1px)" : undefined } as CSSProperties} />
          ))}
          {lg && hint && <span className="ml-2 text-[11px] leading-none text-slate-500">{hint}</span>}
        </span>
      </span>
    </button>
  );
}
