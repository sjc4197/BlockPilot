import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowDownToLine, Eraser, SendHorizonal, SquareTerminal } from "lucide-react";
import type { ConsoleLine } from "@blockpilot/shared";
import { useConsole } from "../lib/useConsole";
import { Lamp } from "../lib/pixel";
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
          <div className="slab grid h-11 w-11 place-items-center text-redstone">
            <SquareTerminal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-block text-[24px] leading-tight text-white [text-shadow:2px_2px_0_#08080a]">콘솔</h1>
            <div className="mt-1 flex items-center gap-2 font-block text-[12px]">
              {status && <StatusBadge state={status.state} size="sm" />}
              <span className={cx("inline-flex items-center gap-1.5", connected ? "text-slate-300" : "text-red-300")}>
                <Lamp state={connected ? "on" : "blink"} size={8} />
                {connected ? "연결됨" : "연결 끊김 · 재접속 중"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 font-block text-[12px] text-slate-400">
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
        <div className="flex items-center gap-2 px-4 py-2.5">
          <Lamp state={status?.state === "running" ? "on" : status?.state === "starting" || status?.state === "stopping" ? "blink" : "off"} size={10} />
          <span className="font-block text-[12px] text-slate-400">서버 콘솔</span>
          <span className="font-block text-[12px] text-slate-600 tnum">· {visible.length}줄</span>
        </div>
        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && autoScroll) setAutoScroll(false);
            if (atBottom && !autoScroll) setAutoScroll(true);
          }}
          className="well terminal mx-3 min-h-0 flex-1 overflow-auto px-4 py-3"
          onClick={() => inputRef.current?.focus()}
        >
          {visible.length === 0 ? (
            <div className="text-slate-600">서버를 시작하면 출력이 여기에 표시돼요.</div>
          ) : (
            visible.map((l, i) => <Line key={i} line={l} showTime={showTime} />)
          )}
        </div>
        {!autoScroll && (
          <button onClick={() => setAutoScroll(true)} className="glass absolute bottom-20 right-7 inline-flex items-center gap-1.5 px-3 py-1.5 font-block text-[12px] text-slate-200 hover:bg-ink-3">
            <ArrowDownToLine className="h-3.5 w-3.5" /> 최신으로
          </button>
        )}
        <form onSubmit={submit} className="well m-3 flex items-center gap-2 px-3 py-1.5">
          <span className="font-mono text-sm text-redstone">›</span>
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
    line.source === "input" ? "text-white font-medium"
    : line.source === "system" ? "text-sky-300"
    : line.source === "stderr" || /\/(ERROR|FATAL)\]/.test(t) ? "text-red-300"
    : /\/WARN\]/.test(t) ? "text-amber-300"
    : "text-slate-300";
  return (
    <div className={cx("whitespace-pre-wrap break-all hover:bg-white/[.025]", cls)}>
      {showTime && <span className="mr-2 select-none text-slate-600">{new Date(line.ts).toLocaleTimeString("ko-KR", { hour12: false })}</span>}
      {t}
    </div>
  );
}
