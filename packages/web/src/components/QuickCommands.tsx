import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../lib/ui";

/**
 * 콘솔 빠른 명령 칩. 누르면 입력칸에 명령을 "넣기만" 하고 보내지는 않는다 (Enter 가 보내기).
 * 슬래시 없이 적는다 — Console 이 보내기 전에 앞의 / 를 떼므로 사용자가 /를 붙여도 상관없다.
 */
export const QUICK_COMMANDS: { label: string; command: string }[] = [
  { label: "낮으로", command: "time set day" },
  { label: "밤으로", command: "time set night" },
  { label: "비 그치게", command: "weather clear" },
  { label: "전체 공지", command: "say " },
  { label: "월드 저장", command: "save-all" },
  { label: "접속자 보기", command: "list" },
  { label: "인벤토리 유지", command: "gamerule keepInventory true" },
  { label: "평화로움", command: "difficulty peaceful" },
];

export function QuickCommands({ onPick, disabled, className }: { onPick: (command: string) => void; disabled?: boolean; className?: string }) {
  const row = useRef<HTMLDivElement>(null);
  // 오른쪽에 더 있으면 끝을 흐리게 해서 "옆으로 넘길 수 있다" 는 걸 알린다. 끝까지 밀면 흐림을 없앤다
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = row.current;
    if (el) setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 2);
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  return (
    <div
      ref={row}
      role="toolbar"
      aria-label="빠른 명령"
      onScroll={measure}
      className={cx("flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", more && "[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]", className)}
    >
      {QUICK_COMMANDS.map((q) => (
        <button
          key={q.command}
          type="button"
          disabled={disabled}
          title={q.command.trim()}
          aria-label={`${q.label} — ${q.command.trim()} 입력`}
          onClick={() => onPick(q.command)}
          className="inline-flex h-7 shrink-0 items-center gap-1 bg-ink-3 px-2 font-block text-[11px] text-slate-300 shadow-[inset_1px_1px_0_#4a4a55,inset_-1px_-1px_0_#08080a] transition-colors hover:bg-ink-4 hover:text-white focus-ring disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span aria-hidden className="font-mono text-[11px] text-redstone">
            ›
          </span>
          {q.label}
        </button>
      ))}
    </div>
  );
}

// ---------- 접속자 이름 자동완성 ----------

/** 플레이어 이름을 인자로 받는 명령 (첫 단어 기준) */
const PLAYER_COMMANDS = new Set(["tp", "teleport", "gamemode", "op", "deop", "kick", "ban", "pardon", "whitelist", "tell", "msg", "w", "give", "kill", "clear", "effect", "xp", "experience", "spectate", "title", "enchant", "advancement", "attribute", "tag", "team"]);

/**
 * 입력 끝 단어가 접속자 이름의 앞부분이면 후보를 돌려준다.
 * 첫 단어(명령 자체)에서는 끼어들지 않고, 명령이 플레이어를 받는 것일 때만 보여 준다.
 */
export function suggestPlayers(input: string, players: string[], limit = 8): { prefix: string; matches: string[] } {
  const m = /^(\S+)\s(?:.*\s)?(\S*)$/.exec(input);
  if (!m) return { prefix: "", matches: [] };
  const head = m[1].replace(/^\//, "").toLowerCase();
  if (!PLAYER_COMMANDS.has(head)) return { prefix: "", matches: [] };
  const prefix = m[2];
  const p = prefix.toLowerCase();
  const matches = players.filter((n) => n.toLowerCase().startsWith(p) && n !== prefix).slice(0, limit);
  return { prefix, matches };
}

/** 마지막 단어를 이름으로 바꾸고 한 칸 띄운다 (다음 인자를 바로 적을 수 있게) */
export function completePlayer(input: string, prefix: string, name: string) {
  return input.slice(0, input.length - prefix.length) + name + " ";
}

export function PlayerSuggestions({ matches, active, onPick, onHover, id }: { matches: string[]; active: number; onPick: (name: string) => void; onHover: (i: number) => void; id: string }) {
  if (!matches.length) return null;
  return (
    <div id={id} role="listbox" aria-label="접속자 이름" className="flex h-7 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="shrink-0 font-block text-[11px] text-slate-500">접속자</span>
      {matches.map((n, i) => (
        <button
          key={n}
          type="button"
          role="option"
          aria-selected={i === active}
          tabIndex={-1}
          // mousedown 에서 포커스가 입력칸을 떠나지 않게
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(n)}
          className={cx("h-7 shrink-0 px-2 font-mono text-[12px] transition-colors", i === active ? "bg-redstone/20 text-white shadow-[inset_0_0_0_1px_rgba(255,59,47,.4)]" : "bg-ink-3 text-slate-300 hover:bg-ink-4 hover:text-white")}
        >
          {n}
        </button>
      ))}
      <span className="hidden shrink-0 items-center px-1.5 font-block text-[11px] text-slate-500 sm:inline-flex">Tab 완성 · Esc 닫기</span>
    </div>
  );
}
