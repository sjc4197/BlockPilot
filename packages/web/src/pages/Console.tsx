import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowDownToLine, Eraser, SendHorizonal, SquareTerminal } from "lucide-react";
import type { ConsoleLine } from "@blockpilot/shared";
import { useConsole } from "../lib/useConsole";
import { Button, Card, Kbd, StatusBadge, Toggle, cx, useToast } from "../lib/ui";

export default function Console() {
  const { id = "" } = useParams();
  const { lines, status, connected, send } = useConsole(id);
  const toast = useToast();
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showTime, setShowTime] = useState(false);
  const [clearedAt, setClearedAt] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = lines.filter((l) => l.ts >= clearedAt);

  useEffect(() => {
    if (autoScroll && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [visible.length, autoScroll]);

  const canSend = status?.state === "running" || status?.state === "starting" || status?.state === "stopping" || (status?.state === "external" && status.rcon === "connected");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = cmd.trim();
    if (!c) return;
    if (!canSend) return toast("err", "서버가 실행 중일 때만 명령을 보낼 수 있어요.");
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
    <div className="flex h-[calc(100vh-7.5rem)] flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-ink-2 text-brand-400">
            <SquareTerminal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white">콘솔</h1>
            <div className="mt-0.5 flex items-center gap-2 text-xs">
              {status && <StatusBadge state={status.state} size="sm" />}
              <span className={cx("inline-flex items-center gap-1", connected ? "text-emerald-400" : "text-rose-400")}>
                <span className={cx("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-rose-400")} />
                {connected ? "연결됨" : "연결 끊김 — 재접속 중"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <label className="flex items-center gap-2">
            시간 표시 <Toggle size="sm" checked={showTime} onChange={setShowTime} />
          </label>
          <label className="flex items-center gap-2">
            자동 스크롤 <Toggle size="sm" checked={autoScroll} onChange={setAutoScroll} />
          </label>
          <Button size="sm" variant="ghost" icon={Eraser} onClick={() => setClearedAt(Date.now())}>
            화면 지우기
          </Button>
        </div>
      </header>

      <Card padded={false} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line bg-ink-1 px-4 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          <span className="ml-3 font-mono text-[11px] text-slate-500">server console · {visible.length}줄</span>
        </div>
        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && autoScroll) setAutoScroll(false);
            if (atBottom && !autoScroll) setAutoScroll(true);
          }}
          className="terminal min-h-0 flex-1 overflow-auto bg-ink-0/80 px-4 py-3"
          onClick={() => inputRef.current?.focus()}
        >
          {visible.length === 0 ? (
            <div className="text-slate-600">서버를 시작하면 출력이 여기에 표시돼요.</div>
          ) : (
            visible.map((l, i) => <Line key={i} line={l} showTime={showTime} />)
          )}
        </div>
        {!autoScroll && (
          <button onClick={() => setAutoScroll(true)} className="absolute bottom-16 right-5 inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-xs text-slate-200 shadow-pop hover:bg-ink-3">
            <ArrowDownToLine className="h-3.5 w-3.5" /> 최신으로
          </button>
        )}
        <form onSubmit={submit} className="flex items-center gap-2 border-t border-line bg-ink-1 px-3 py-2">
          <span className="font-mono text-sm text-brand-400">›</span>
          <input
            ref={inputRef}
            className="terminal min-w-0 flex-1 bg-transparent text-slate-100 placeholder-slate-600 focus:outline-none"
            placeholder={canSend ? "명령어 입력 — 예: list, say 안녕, whitelist add Steve" : "서버가 실행 중이 아니에요"}
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={onKey}
            disabled={!canSend}
            autoFocus
          />
          <span className="hidden items-center gap-1 text-[11px] text-slate-600 md:flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 히스토리
          </span>
          <Button size="sm" variant="primary" type="submit" icon={SendHorizonal} disabled={!canSend}>
            전송
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Line({ line, showTime }: { line: ConsoleLine; showTime: boolean }) {
  const t = line.text;
  const cls =
    line.source === "input" ? "text-brand-300"
    : line.source === "system" ? "text-sky-300"
    : line.source === "stderr" || /\/(ERROR|FATAL)\]/.test(t) ? "text-rose-300"
    : /\/WARN\]/.test(t) ? "text-amber-300"
    : "text-slate-300";
  return (
    <div className={cx("whitespace-pre-wrap break-all hover:bg-white/[.025]", cls)}>
      {showTime && <span className="mr-2 select-none text-slate-600">{new Date(line.ts).toLocaleTimeString("ko-KR", { hour12: false })}</span>}
      {t}
    </div>
  );
}
