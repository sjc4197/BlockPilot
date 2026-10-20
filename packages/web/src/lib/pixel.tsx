import type { CSSProperties } from "react";

/** 레드스톤 부품 픽셀 아트. ui.tsx 와 Lever.tsx 양쪽에서 쓰므로 다른 모듈에 의존하지 않는다. */

const join = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const STONE_A = "#8f8f8f";
export const STONE_B = "#5e5e5e";
const STONE_C = "#737373";
const STICK = "#7a5230";
const STICK_HI = "#9c6b3c";

// 조약돌 받침 무늬 (12 x 3)
const COBBLE = ["abaabbabaaba", "babbaabbabab", "aabbabaabbaa"];

/**
 * 조약돌 받침 위의 레버. 기울기와 손잡이 색은 CSS 가 조상 요소의 data-on 을 보고 정한다.
 * (.lever-handle / .lever-knob — index.css)
 */
export function LeverGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 14" className={className} shapeRendering="crispEdges" aria-hidden>
      <g className="lever-handle">
        <rect x={7} y={2} width={2} height={9} fill={STICK} />
        <rect x={7} y={2} width={1} height={9} fill={STICK_HI} />
        <rect className="lever-knob" x={6.5} y={0.5} width={3} height={2.5} />
      </g>
      <rect x={5} y={9} width={6} height={2} fill={STONE_C} />
      <rect x={5} y={9} width={6} height={0.6} fill={STONE_A} />
      {COBBLE.flatMap((row, y) => [...row].map((ch, x) => <rect key={`${x}-${y}`} x={2 + x} y={11 + y} width={1} height={1} fill={ch === "a" ? STONE_A : STONE_B} />))}
    </svg>
  );
}

export type LampState = "on" | "off" | "blink";

/** 레드스톤 램프: 꺼짐(어두운 호박) / 켜짐(주황 빛) / 깜빡임 */
export function Lamp({ state, size = 12, className }: { state: LampState; size?: number; className?: string }) {
  return <span className={join("lamp", className)} data-lamp={state} style={{ "--s": `${size}px` } as CSSProperties} aria-hidden />;
}

/** TNT 블록. primed 면 점화된 것처럼 하얗게 깜빡인다 */
export function TntIcon({ className, primed }: { className?: string; primed?: boolean }) {
  return (
    <svg viewBox="0 0 8 8" className={join(className, primed && "tnt-primed")} shapeRendering="crispEdges" aria-hidden>
      <rect width={8} height={8} fill="#d93a2b" />
      <rect width={8} height={1} fill="#8d1e14" />
      <rect x={1} y={1} width={1} height={2} fill="#b52a1e" />
      <rect x={4} y={1} width={1} height={2} fill="#b52a1e" />
      <rect x={6} y={5} width={1} height={3} fill="#b52a1e" />
      <rect x={2} y={5} width={1} height={3} fill="#b52a1e" />
      <rect y={3} width={8} height={2} fill="#f2efe6" />
      <rect x={1} y={3.5} width={1.5} height={1} fill="#2a2a2a" />
      <rect x={3.25} y={3.5} width={1.5} height={1} fill="#2a2a2a" />
      <rect x={5.5} y={3.5} width={1.5} height={1} fill="#2a2a2a" />
    </svg>
  );
}

/** 로딩 표시: 스피너 대신 레드스톤 신호가 왼쪽에서 오른쪽으로 흐른다 */
export function DustLoader({ count = 5, size = 5, className, label = "불러오는 중" }: { count?: number; size?: number; className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={join("dust-loader inline-flex items-end", className)} style={{ gap: Math.max(2, size - 2) }}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="dust" style={{ width: size, height: size, "--i": i, transform: i % 3 === 1 ? "translateY(-1px)" : undefined } as CSSProperties} />
      ))}
    </span>
  );
}

/** 비교기 신호 세기 0~15 */
export function SignalBar({ value, className }: { value: number; className?: string }) {
  const n = Math.max(0, Math.min(15, Math.round(value)));
  return (
    <span className={join("grid h-2 gap-[2px]", className)} style={{ gridTemplateColumns: "repeat(15, 1fr)" }} aria-label={`신호 세기 ${n}/15`} role="img">
      {Array.from({ length: 15 }, (_, i) => (
        <span key={i} className={i < n ? "bg-redstone shadow-[0_0_4px_rgba(255,59,47,.5)]" : "bg-redstone-off"} />
      ))}
    </span>
  );
}
