import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { FileArchive, Flame, ScrollText, Search } from "lucide-react";
import { useLogFile, useLogs } from "../api/hooks";
import { Badge, Card, EmptyState, Input, PageHeader, Select, Spinner, cx, fmtBytes, fmtDate } from "../lib/ui";

type Level = "all" | "warn" | "error";

/** 성능 모니터가 30초마다 보내는 /tick query 의 응답 줄 (서버 로그 파일에도 남는다) */
// 한 응답이 여러 줄로 찍혀서 둘째 줄부터는 시각 머리말이 없다
const TICK_PROBE = /(^|\]: )(The game is running normally|Target tick rate: |Average time per tick: |Percentiles: P50)/;

export default function Logs() {
  const { id = "" } = useParams();
  const { data: files, isLoading } = useLogs(id);
  const [sel, setSel] = useState<{ kind: string; name: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [tail, setTail] = useState(2000);
  const [hideProbe, setHideProbe] = useState(true);
  const { data: log, isFetching } = useLogFile(id, sel?.kind ?? null, sel?.name ?? null, tail);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sel && files?.length) setSel({ kind: files[0].kind, name: files[0].name });
  }, [files, sel]);

  const lines = useMemo(() => {
    let l = log?.lines ?? [];
    if (hideProbe) l = l.filter((x) => !TICK_PROBE.test(x));
    if (level === "warn") l = l.filter((x) => /\/(WARN|ERROR|FATAL)\]/.test(x));
    if (level === "error") l = l.filter((x) => /\/(ERROR|FATAL)\]|Exception|\tat /.test(x));
    if (filter) {
      const f = filter.toLowerCase();
      l = l.filter((x) => x.toLowerCase().includes(f));
    }
    return l;
  }, [log, level, filter, hideProbe]);

  useEffect(() => {
    if (boxRef.current && sel?.name === "latest.log") boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, sel]);

  const counts = useMemo(() => {
    const all = log?.lines ?? [];
    return { warn: all.filter((x) => /\/WARN\]/.test(x)).length, error: all.filter((x) => /\/(ERROR|FATAL)\]/.test(x)).length };
  }, [log]);

  return (
    <div className="flex flex-col gap-5 md:h-[calc(100vh-7.5rem)]">
      <PageHeader icon={ScrollText} title="로그" description="logs/ 와 crash-reports/ 의 파일을 봐요. 압축(.gz)된 로그도 바로 열리고 latest.log 는 5초마다 갱신돼요." />
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <Card padded={false} className="max-h-48 w-full shrink-0 overflow-y-auto p-2 md:max-h-none md:w-64">
          {isLoading ? (
            <Spinner className="m-3" />
          ) : !files?.length ? (
            <div className="p-4 text-center text-xs text-slate-500">로그 파일이 없어요.</div>
          ) : (
            files.map((f) => {
              const active = sel?.name === f.name && sel.kind === f.kind;
              return (
                <button
                  key={f.kind + f.name}
                  onClick={() => setSel({ kind: f.kind, name: f.name })}
                  className={cx("flex w-full items-start gap-2.5 px-2.5 py-2 text-left transition-colors focus-ring", active ? "slab text-white" : "text-slate-300 hover:bg-ink-2")}
                >
                  {f.kind === "crash" ? <Flame className="mt-0.5 h-4 w-4 shrink-0 text-red-400" /> : f.compressed ? <FileArchive className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /> : <ScrollText className={cx("mt-0.5 h-4 w-4 shrink-0", f.name === "latest.log" ? "text-redstone" : "text-slate-500")} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px]">{f.name}</span>
                    <span className="block text-[10px] text-slate-500 tnum">
                      {fmtBytes(f.sizeBytes)} · {fmtDate(f.mtime)}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </Card>
        <Card padded={false} className="flex min-h-[60vh] min-w-0 flex-1 flex-col overflow-hidden md:min-h-0">
          <div className="flex flex-wrap items-center gap-2 shadow-[inset_0_-2px_0_#08080a] px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input className="h-8 !w-60 pl-8 text-xs" placeholder="검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Select className="h-8 !w-36 text-xs" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              <option value="all">전체</option>
              <option value="warn">WARN 이상</option>
              <option value="error">ERROR / 예외</option>
            </Select>
            <Select className="h-8 !w-32 text-xs" value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              {[500, 2000, 5000].map((n) => (
                <option key={n} value={n}>
                  마지막 {n}줄
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400" title="BlockPilot 성능 모니터가 30초마다 보내는 /tick query 응답">
              <input type="checkbox" className="accent-[#ff3b2f]" checked={hideProbe} onChange={(e) => setHideProbe(e.target.checked)} />
              성능 측정 줄 숨기기
            </label>
            <div className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-500 tnum">
              {counts.warn > 0 && <Badge tone="warning">WARN {counts.warn}</Badge>}
              {counts.error > 0 && <Badge tone="danger">ERROR {counts.error}</Badge>}
              <span>
                {log ? `${lines.length} / ${log.totalLines}줄${log.truncated ? " (앞부분 생략)" : ""}` : ""} {isFetching && "· 갱신 중"}
              </span>
            </div>
          </div>
          <div ref={boxRef} className="well terminal m-3 mt-0 min-h-0 flex-1 overflow-auto px-4 py-3">
            {!sel ? null : !log ? <Spinner /> : lines.length === 0 ? <EmptyState title="표시할 줄이 없어요" /> : lines.map((l, i) => <LogLine key={i} text={l} />)}
          </div>
        </Card>
      </div>
    </div>
  );
}

function LogLine({ text }: { text: string }) {
  const cls = /\/(ERROR|FATAL)\]/.test(text) || /^\s*at |Exception/.test(text) ? "text-rose-300" : /\/WARN\]/.test(text) ? "text-amber-300" : "text-slate-300";
  return <div className={cx("whitespace-pre-wrap break-all hover:bg-white/[.025]", cls)}>{text}</div>;
}
