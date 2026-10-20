import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useLogFile, useLogs } from "../api/hooks";
import { card, cx, input, EmptyState, Spinner } from "../lib/ui";

type Level = "all" | "warn" | "error";

export default function Logs() {
  const { id = "" } = useParams();
  const { data: files, isLoading } = useLogs(id);
  const [sel, setSel] = useState<{ kind: string; name: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [tail, setTail] = useState(2000);
  const { data: log, isFetching } = useLogFile(id, sel?.kind ?? null, sel?.name ?? null, tail);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sel && files?.length) setSel({ kind: files[0].kind, name: files[0].name });
  }, [files, sel]);

  const lines = useMemo(() => {
    let l = log?.lines ?? [];
    if (level === "warn") l = l.filter((x) => /\/(WARN|ERROR|FATAL)\]/.test(x));
    if (level === "error") l = l.filter((x) => /\/(ERROR|FATAL)\]|Exception|\tat /.test(x));
    if (filter) {
      const f = filter.toLowerCase();
      l = l.filter((x) => x.toLowerCase().includes(f));
    }
    return l;
  }, [log, level, filter]);

  useEffect(() => {
    if (boxRef.current && sel?.name === "latest.log") boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, sel]);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4">
      <header>
        <h1 className="text-2xl font-bold">로그</h1>
        <p className="mt-1 text-sm text-slate-400">logs/ 와 crash-reports/ 의 파일을 봅니다. 압축(.gz)된 로그도 바로 열려요. latest.log 는 5초마다 갱신됩니다.</p>
      </header>
      <div className="flex min-h-0 flex-1 gap-4">
        <aside className={cx(card, "w-64 shrink-0 overflow-y-auto p-2 text-sm")}>
          {isLoading ? (
            <Spinner />
          ) : !files?.length ? (
            <EmptyState>로그 파일이 없습니다.</EmptyState>
          ) : (
            files.map((f) => (
              <button
                key={f.kind + f.name}
                onClick={() => setSel({ kind: f.kind, name: f.name })}
                className={cx("block w-full rounded px-2 py-1.5 text-left", sel?.name === f.name && sel.kind === f.kind ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-900")}
              >
                <div className="flex items-center gap-1.5 truncate console-font text-xs">
                  {f.kind === "crash" && <span className="rounded bg-red-900/60 px-1 text-[10px] text-red-300">crash</span>}
                  {f.name}
                </div>
                <div className="text-[10px] text-slate-500">
                  {(f.sizeBytes / 1024).toFixed(0)} KB · {new Date(f.mtime).toLocaleString()}
                </div>
              </button>
            ))
          )}
        </aside>
        <section className={cx(card, "flex min-w-0 flex-1 flex-col p-0 overflow-hidden")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
            <input className={cx(input, "!w-64")} placeholder="검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select className={cx(input, "!w-36")} value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              <option value="all">전체</option>
              <option value="warn">WARN 이상</option>
              <option value="error">ERROR / 예외</option>
            </select>
            <select className={cx(input, "!w-32")} value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              {[500, 2000, 5000].map((n) => (
                <option key={n} value={n}>
                  마지막 {n}줄
                </option>
              ))}
            </select>
            <span className="ml-auto text-xs text-slate-500">
              {log ? `${lines.length} / ${log.totalLines}줄${log.truncated ? " (앞부분 생략)" : ""}` : ""} {isFetching && "· 갱신 중"}
            </span>
          </div>
          <div ref={boxRef} className="console-font min-h-0 flex-1 overflow-auto bg-slate-950 p-3 text-xs leading-5">
            {!sel ? null : !log ? <Spinner /> : lines.length === 0 ? <div className="text-slate-600">표시할 줄이 없습니다.</div> : lines.map((l, i) => <LogLine key={i} text={l} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function LogLine({ text }: { text: string }) {
  const cls = /\/(ERROR|FATAL)\]/.test(text) || /^\s*at |Exception/.test(text) ? "text-red-300" : /\/WARN\]/.test(text) ? "text-amber-300" : "text-slate-300";
  return <div className={cx("whitespace-pre-wrap break-all", cls)}>{text}</div>;
}
