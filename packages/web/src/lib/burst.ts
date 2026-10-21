/**
 * 화면 좌표 (x, y) 에서 픽셀 조각이 튀어 나간다 (블록 부서짐, TNT 폭발).
 * 문서에 잠깐 붙였다가 스스로 지운다. 동작 줄이기 설정이면 아무것도 하지 않는다.
 */
export function burst(x: number, y: number, { count = 18, colors = ["#8f8f8f", "#5e5e5e", "#737373"], spread = 90, size = [4, 8], ring = false }: { count?: number; colors?: string[]; spread?: number; size?: [number, number]; ring?: boolean } = {}) {
  if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("i");
    const s = size[0] + Math.floor(Math.random() * ((size[1] - size[0]) / 2 + 1)) * 2;
    const a = ring ? (i / count) * Math.PI * 2 : Math.random() * Math.PI * 2;
    const d = spread * (ring ? 0.55 + Math.random() * 0.6 : 0.3 + Math.random() * 0.7);
    el.className = "shard";
    el.style.cssText = `left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;background:${colors[i % colors.length]}`;
    el.style.setProperty("--dx", `${Math.cos(a) * d}px`);
    // 위로 튄 조각도 결국 아래로 떨어지게
    el.style.setProperty("--dy", `${Math.sin(a) * d + (ring ? 0 : 30)}px`);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 800);
  }
}

/** 화면 전체가 잠깐 하얗게 (TNT) */
export function flash() {
  if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = document.createElement("div");
  el.className = "boom-flash";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 500);
}

/** 블록 금 무늬: 48x14 칸에 가운데서 퍼져 나가는 점들. 순서대로 열 단계에 나눠 그린다 */
export const CRACK: [number, number][] = (() => {
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const seen = new Set<string>();
  const out: [number, number][] = [];
  const walkers: [number, number][] = [[24, 7], [24, 7], [23, 6], [25, 8]];
  for (let step = 0; step < 70; step++) {
    walkers.forEach((w, k) => {
      w[0] += rnd() < 0.7 ? (k % 2 ? 1 : -1) : 0;
      w[1] = Math.max(0, Math.min(13, w[1] + (rnd() < 0.5 ? (rnd() < 0.5 ? -1 : 1) : 0)));
      const key = `${w[0]},${w[1]}`;
      if (w[0] >= 0 && w[0] < 48 && !seen.has(key)) {
        seen.add(key);
        out.push([w[0], w[1]]);
      }
    });
  }
  return out;
})();
