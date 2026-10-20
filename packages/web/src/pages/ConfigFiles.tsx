import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { FileCode2, FileJson, FileText, FolderOpen, RotateCcw, Save, Search } from "lucide-react";
import type { ConfigFileEntry, ConfigValidationResult } from "@blockpilot/shared";
import { useConfigFile, useConfigFiles, useSaveConfigFile, validateConfig } from "../api/hooks";
import { Badge, Button, Card, EmptyState, Input, Kbd, PageHeader, Spinner, cx, fmtBytes, fmtDate, useToast } from "../lib/ui";

const FORMAT_TONE: Record<ConfigFileEntry["format"], string> = { toml: "text-violet-400", json: "text-amber-400", json5: "text-amber-400", yaml: "text-sky-400", properties: "text-emerald-400", text: "text-slate-400" };

export default function ConfigFiles() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const selected = params.get("path");
  const { data: files, isLoading } = useConfigFiles(id);
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const list = (files ?? []).filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));
    const byDir = new Map<string, ConfigFileEntry[]>();
    for (const f of list) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "서버 루트";
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files, filter]);

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col gap-5">
      <PageHeader icon={FileCode2} title="설정 파일" description="모드·플러그인 설정 파일을 직접 편집해요. 저장 전에 문법을 검사하고 원본은 .blockpilot-backup/ 에 보관돼요." />
      <div className="flex min-h-0 flex-1 gap-4">
        <Card padded={false} className="flex w-72 shrink-0 flex-col">
          <div className="border-b border-line p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input className="h-8 pl-8 text-xs" placeholder="파일 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
            {isLoading ? (
              <Spinner className="m-3" />
            ) : !groups.length ? (
              <div className="p-4 text-center text-xs text-slate-500">편집할 수 있는 설정 파일이 없어요.</div>
            ) : (
              groups.map(([dir, list]) => (
                <div key={dir} className="mb-2">
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500" title={dir}>
                    <FolderOpen className="h-3 w-3" /> <span className="truncate">{dir}</span>
                  </div>
                  {list.map((f) => {
                    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
                    const Icon = f.format === "json" || f.format === "json5" ? FileJson : f.format === "text" ? FileText : FileCode2;
                    return (
                      <button
                        key={f.path}
                        onClick={() => setParams({ path: f.path })}
                        className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12px] transition focus-ring", selected === f.path ? "bg-ink-3 text-white" : "text-slate-300 hover:bg-ink-2")}
                        title={f.path}
                      >
                        <Icon className={cx("h-3.5 w-3.5 shrink-0", FORMAT_TONE[f.format])} />
                        <span className="truncate">{name}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </Card>
        <section className="min-w-0 flex-1">
          {selected ? (
            <Editor key={selected} serverId={id} path={selected} />
          ) : (
            <EmptyState icon={FileCode2} title="파일을 선택하세요">
              왼쪽 목록에서 편집할 설정 파일을 고르면 여기에 열려요.
            </EmptyState>
          )}
        </section>
      </div>
    </div>
  );
}

function Editor({ serverId, path }: { serverId: string; path: string }) {
  const { data, isLoading, error } = useConfigFile(serverId, path);
  const save = useSaveConfigFile(serverId);
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [validation, setValidation] = useState<ConfigValidationResult | null>(null);

  useEffect(() => {
    if (data && text === null) setText(data.content);
  }, [data, text]);

  const dirty = data !== undefined && text !== null && text !== data.content;

  useEffect(() => {
    if (!dirty || text === null) return setValidation(null);
    const t = setTimeout(() => validateConfig(serverId, { path, content: text }).then(setValidation).catch(() => {}), 500);
    return () => clearTimeout(t);
  }, [text, dirty, serverId, path]);

  if (isLoading) return <Spinner />;
  if (error) return <EmptyState title={(error as Error).message} />;
  if (!data || text === null) return null;

  const onSave = () =>
    save.mutate({ path, content: text }, { onSuccess: () => toast("ok", "저장했습니다. 모드 설정은 보통 서버를 재시작해야 반영돼요."), onError: (e) => toast("err", (e as Error).message) });

  const lineCount = text.split("\n").length;

  return (
    <Card padded={false} className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13px] text-white">{path}</span>
            <Badge mono className={FORMAT_TONE[data.format]}>{data.format}</Badge>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500 tnum">
            {fmtBytes(data.sizeBytes)} · {lineCount}줄 · 수정 {fmtDate(data.mtime)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {validation && !validation.ok && (
            <Badge tone="danger">
              문법 오류{validation.line ? ` ${validation.line}행` : ""}
            </Badge>
          )}
          {validation?.ok && dirty && <Badge tone="success">문법 OK</Badge>}
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!dirty} onClick={() => setText(data.content)}>
            되돌리기
          </Button>
          <Button size="sm" variant="primary" icon={Save} disabled={!dirty || validation?.ok === false} loading={save.isPending} onClick={onSave}>
            저장
          </Button>
        </div>
      </div>
      {validation && !validation.ok && <div className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-1.5 font-mono text-[12px] text-rose-200">{validation.message}</div>}
      <textarea
        className="terminal min-h-0 flex-1 resize-none bg-ink-0/70 p-4 text-slate-200 focus:outline-none"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            if (dirty && validation?.ok !== false) onSave();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart;
            setText(text.slice(0, s) + "  " + text.slice(el.selectionEnd));
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
      />
      <div className="flex items-center justify-between border-t border-line px-4 py-1.5 text-[11px] text-slate-500">
        <span>
          <Kbd>⌘</Kbd> + <Kbd>S</Kbd> 저장 · <Kbd>Tab</Kbd> 들여쓰기
        </span>
        {dirty && <span className="text-brand-300">저장되지 않은 변경</span>}
      </div>
    </Card>
  );
}
