import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { PROPERTY_GROUPS, PROPERTY_META, PROPERTY_META_BY_KEY, type PropertyMeta, type PropertyGroup } from "@blockpilot/shared";
import { useProperties, useServer, useUpdateProperties } from "../api/hooks";
import { btn, card, cx, input, Toggle, useToast, Spinner } from "../lib/ui";

type Tab = PropertyGroup | "advanced";

export default function Settings() {
  const { id = "" } = useParams();
  const { data, isLoading } = useProperties(id);
  const { data: server } = useServer(id);
  const update = useUpdateProperties(id);
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("gameplay");
  const [draft, setDraft] = useState<Record<string, string>>({});

  const current = useMemo(() => Object.fromEntries((data?.entries ?? []).map((e) => [e.key, e.value])), [data]);
  useEffect(() => setDraft({}), [data?.mtime]);

  const value = (key: string) => draft[key] ?? current[key] ?? "";
  const set = (key: string, v: string) =>
    setDraft((d) => {
      const next = { ...d };
      if (v === (current[key] ?? "")) delete next[key];
      else next[key] = v;
      return next;
    });
  const dirtyCount = Object.keys(draft).length;
  const running = server?.process.state === "running";

  const save = () =>
    update.mutate(draft, {
      onSuccess: (r) => {
        if (r.appliedLive.length) toast("ok", `${r.appliedLive.length}개 즉시 적용, 파일에 저장했습니다.`);
        else toast("ok", "저장했습니다.");
        if (r.needsRestart.length)
          toast("info", `재시작 후 반영: ${r.needsRestart.map((k) => PROPERTY_META_BY_KEY[k]?.label ?? k).join(", ")}`);
        setDraft({});
      },
      onError: (err) => toast("err", (err as Error).message),
    });

  if (isLoading) return <Spinner />;

  const knownKeys = new Set(PROPERTY_META.map((m) => m.key));
  const advancedEntries = (data?.entries ?? []).filter((e) => !knownKeys.has(e.key));

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">서버 설정</h1>
          <p className="mt-1 text-sm text-slate-400">
            server.properties
            {running && <span className="ml-2 text-amber-300">· 실행 중: 즉시 반영 가능한 항목은 바로 적용되고, 나머지는 재시작 후 반영됩니다.</span>}
          </p>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-slate-800">
        {[...PROPERTY_GROUPS, { id: "advanced" as const, label: `고급 (${advancedEntries.length})` }].map((g) => (
          <button
            key={g.id}
            onClick={() => setTab(g.id)}
            className={cx(
              "px-3 py-2 text-sm border-b-2 -mb-px",
              tab === g.id ? "border-emerald-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200",
            )}
          >
            {g.label}
          </button>
        ))}
      </nav>

      {tab !== "advanced" ? (
        <div className={cx(card, "divide-y divide-slate-800 p-0")}>
          {PROPERTY_META.filter((m) => m.group === tab).map((m) => (
            <Field key={m.key} meta={m} value={value(m.key)} dirty={m.key in draft} running={running} onChange={(v) => set(m.key, v)} />
          ))}
        </div>
      ) : (
        <div className={cx(card, "p-0 overflow-hidden")}>
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-xs text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">키</th>
                <th className="px-4 py-2 text-left font-medium">값</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {advancedEntries.map((e) => (
                <tr key={e.key} className={cx(e.key in draft && "bg-emerald-950/30")}>
                  <td className="px-4 py-2 console-font text-xs text-slate-300">{e.key}</td>
                  <td className="px-4 py-1.5">
                    <input className={cx(input, "console-font text-xs")} value={value(e.key)} onChange={(ev) => set(e.key, ev.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dirtyCount > 0 && (
        <div className="sticky bottom-4 flex items-center justify-between rounded-xl border border-emerald-700/60 bg-slate-900/95 px-5 py-3 shadow-xl backdrop-blur">
          <span className="text-sm">
            <b>{dirtyCount}</b>개 항목 변경됨
          </span>
          <div className="flex gap-2">
            <button className={cx(btn.base, btn.secondary)} onClick={() => setDraft({})}>
              취소
            </button>
            <button className={cx(btn.base, btn.primary)} disabled={update.isPending} onClick={save}>
              {update.isPending ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  meta,
  value,
  dirty,
  running,
  onChange,
}: {
  meta: PropertyMeta;
  value: string;
  dirty: boolean;
  running: boolean;
  onChange: (v: string) => void;
}) {
  const live = !!meta.liveCommand;
  return (
    <div className={cx("flex items-center gap-6 px-5 py-3.5", dirty && "bg-emerald-950/20")}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{meta.label}</span>
          <code className="text-[11px] text-slate-500">{meta.key}</code>
          {running && (
            <span className={cx("rounded px-1.5 py-px text-[10px]", live ? "bg-emerald-900/60 text-emerald-300" : "bg-slate-800 text-slate-400")}>
              {live ? "즉시 적용" : "재시작 필요"}
            </span>
          )}
        </div>
        {meta.description && <p className="mt-0.5 text-xs text-slate-500">{meta.description}</p>}
      </div>
      <div className="w-64 shrink-0">
        {meta.type === "boolean" ? (
          <div className="flex justify-end">
            <Toggle checked={value === "true"} onChange={(v) => onChange(v ? "true" : "false")} />
          </div>
        ) : meta.type === "enum" ? (
          <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
            {!meta.options.some((o) => o.value === value) && <option value={value}>{value || "(비어 있음)"}</option>}
            {meta.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : meta.type === "int" ? (
          <input type="number" className={input} value={value} min={meta.min} max={meta.max} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input className={input} value={value} placeholder={meta.placeholder} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    </div>
  );
}
