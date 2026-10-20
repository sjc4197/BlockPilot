import type { CSSProperties } from "react";
import { cx } from "../lib/ui";
import { LeverGlyph, STONE_A, STONE_B } from "../lib/pixel";

/** 로고용 정적 레버 마크 (8x8 픽셀) */
export function PixelLeverMark({ className }: { className?: string }) {
  const map = [".....kk.", "....hs..", "...ss...", "..ss....", ".ss.....", "cCcCcCcC", "CcCcCcCc"];
  const pal: Record<string, string> = { k: "#3a3a3a", h: "#9c6b3c", s: "#7a5230", c: STONE_A, C: STONE_B };
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
        "lever inline-flex items-center text-left transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-40",
        busy && "cursor-progress",
        lg ? "gap-3 py-2 pl-2 pr-4" : "h-10 gap-2 pl-1 pr-3",
        armed ? "bg-[#2a1d10] shadow-[inset_2px_2px_0_#7a5a22,inset_-2px_-2px_0_#08080a]" : "bg-ink-2 shadow-slab hover:bg-ink-3 active:shadow-pressed",
      )}
    >
      <LeverGlyph className={lg ? "h-12 w-12" : "h-8 w-8"} />
      <span className="flex flex-col gap-1.5">
        <span className={cx("font-block leading-none", "text-[12px]", armed ? "text-lamp" : on ? "text-red-300" : "text-slate-300")}>{label}</span>
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
