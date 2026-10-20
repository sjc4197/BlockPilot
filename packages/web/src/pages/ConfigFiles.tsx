import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { ConfigFileEntry, ConfigValidationResult } from "@blockpilot/shared";
import { useConfigFile, useConfigFiles, useSaveConfigFile, validateConfig } from "../api/hooks";
import { btn, card, cx, input, EmptyState, Spinner, useToast } from "../lib/ui";

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
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "(서버 루트)";
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files, filter]);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4">
      <header>
        <h1 className="text-2xl font-bold">설정 파일</h1>
        <p className="mt-1 text-sm text-slate-400">config/, plugins/ 등의 모드·플러그인 설정 파일을 직접 편집합니다. 저장 전에 문법을 검사하고, 원본은 .blockpilot-backup/ 에 보관돼요.</p>
      </header>
      <div className="flex min-h-0 flex-1 gap-4">
        <aside className={cx(card, "w-72 shrink-0 flex flex-col p-3")}>
          <input className={cx(input, "mb-2")} placeholder="파일 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="min-h-0 flex-1 overflow-y-auto text-sm">
            {isLoading ? (
              <Spinner />
            ) : !groups.length ? (
              <EmptyState>편집할 수 있는 설정 파일이 없습니다.</EmptyState>
            ) : (
              groups.map(([dir, list]) => (
                <div key={dir} className="mb-3">
                  <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-slate-500 truncate" title={dir}>
                    {dir}
                  </div>
                  {list.map((f) => {
                    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
                    return (
                      <button
                        key={f.path}
                        onClick={() => setParams({ path: f.path })}
                        className={cx("block w-full truncate rounded px-2 py-1 text-left console-font text-xs", selected === f.path ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-900")}
                        title={f.path}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          {selected ? <Editor key={selected} serverId={id} path={selected} /> : <EmptyState>왼쪽에서 파일을 선택하세요.</EmptyState>}
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

  // 입력 멈추면 문법 검사
  useEffect(() => {
    if (!dirty || text === null) return setValidation(null);
    const t = setTimeout(() => validateConfig(serverId, { path, content: text }).then(setValidation).catch(() => {}), 500);
    return () => clearTimeout(t);
  }, [text, dirty, serverId, path]);

  if (isLoading) return <Spinner />;
  if (error) return <EmptyState>{(error as Error).message}</EmptyState>;
  if (!data || text === null) return null;

  const onSave = () =>
    save.mutate(
      { path, content: text },
      {
        onSuccess: () => toast("ok", "저장했습니다. 모드 설정은 보통 서버를 재시작해야 반영돼요."),
        onError: (e) => toast("err", (e as Error).message),
      },
    );

  return (
    <div className={cx(card, "flex h-full flex-col p-0 overflow-hidden")}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate console-font text-sm">{path}</div>
          <div className="text-[11px] text-slate-500">
            {data.format} · {(data.sizeBytes / 1024).toFixed(1)} KB · 수정 {new Date(data.mtime).toLocaleString()}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {validation && !validation.ok && (
            <span className="text-xs text-red-300">
              문법 오류{validation.line ? ` (${validation.line}행)` : ""}: {validation.message}
            </span>
          )}
          {validation?.ok && dirty && <span className="text-xs text-emerald-300">문법 OK</span>}
          <button className={cx(btn.base, btn.secondary)} disabled={!dirty} onClick={() => setText(data.content)}>
            되돌리기
          </button>
          <button className={cx(btn.base, btn.primary)} disabled={!dirty || save.isPending || validation?.ok === false} onClick={onSave}>
            {save.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
      <textarea
        className="console-font min-h-0 flex-1 resize-none bg-slate-950 p-4 text-xs leading-5 text-slate-200 focus:outline-none"
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
    </div>
  );
}
