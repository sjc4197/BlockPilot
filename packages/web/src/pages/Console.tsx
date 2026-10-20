import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import type { ConsoleLine } from "@blockpilot/shared";
import { useConsole } from "../lib/useConsole";
import { btn, cx, input, StatusBadge, useToast } from "../lib/ui";

export default function Console() {
  const { id = "" } = useParams();
  const { lines, status, connected, send } = useConsole(id);
  const toast = useToast();
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [autoScroll, setAutoScroll] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const canSend = status?.state === "running" || status?.state === "starting" || status?.state === "stopping";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = cmd.trim();
    if (!c) return;
    if (!canSend) return toast("err", "서버가 실행 중일 때만 명령을 보낼 수 있습니다.");
    send(c.replace(/^\//, ""));
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHistIdx(-1);
    setCmd("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.min(histIdx + 1, history.length - 1);
      if (history[i] !== undefined) {
        setHistIdx(i);
        setCmd(history[i]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = histIdx - 1;
      setHistIdx(i);
      setCmd(i < 0 ? "" : history[i]);
    }
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">콘솔</h1>
          {status && <StatusBadge state={status.state} />}
          <span className={cx("text-xs", connected ? "text-emerald-400" : "text-red-400")}>{connected ? "● 연결됨" : "● 연결 끊김"}</span>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          자동 스크롤
        </label>
      </header>

      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && autoScroll) setAutoScroll(false);
          if (atBottom && !autoScroll) setAutoScroll(true);
        }}
        className="console-font flex-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs leading-5"
      >
        {lines.length === 0 ? (
          <div className="text-slate-600">서버를 시작하면 출력이 여기에 표시됩니다.</div>
        ) : (
          lines.map((l, i) => <Line key={i} line={l} />)
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <span className="console-font flex items-center text-slate-500">&gt;</span>
        <input
          className={cx(input, "console-font")}
          placeholder={canSend ? "명령어 입력 (예: list, say 안녕, whitelist add Steve)" : "서버가 실행 중이 아닙니다"}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKey}
          disabled={!canSend}
          autoFocus
        />
        <button className={cx(btn.base, btn.primary, "shrink-0 whitespace-nowrap")} disabled={!canSend}>
          전송
        </button>
      </form>
    </div>
  );
}

function Line({ line }: { line: ConsoleLine }) {
  const t = line.text;
  const cls =
    line.source === "input" ? "text-emerald-300"
    : line.source === "system" ? "text-sky-300"
    : line.source === "stderr" || /\/(ERROR|FATAL)\]/.test(t) ? "text-red-300"
    : /\/WARN\]/.test(t) ? "text-amber-300"
    : "text-slate-300";
  return <div className={cx("whitespace-pre-wrap break-all", cls)}>{t}</div>;
}
