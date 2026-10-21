import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { BellRing, Gauge, Globe, Layers, ListTree, Settings2, Swords, Users, Zap, type LucideIcon } from "lucide-react";
import { PROPERTY_GROUPS, PROPERTY_META, PROPERTY_META_BY_KEY, type PropertyMeta, type PropertyGroup } from "@blockpilot/shared";
import { useAutomation, useProperties, useServer, useUpdateProperties } from "../api/hooks";
import { AutomationPanel } from "../components/AutomationPanel";
import { ServerDanger } from "../components/ServerDanger";
import { Badge, Button, Card, Input, PageHeader, Select, Spinner, Toggle, cx, useToast } from "../lib/ui";

type Tab = PropertyGroup | "advanced" | "automation";
const GROUP_ICON: Record<Tab, LucideIcon> = { gameplay: Swords, world: Layers, players: Users, network: Globe, performance: Gauge, advanced: ListTree, automation: BellRing };

export default function Settings() {
  const { id = "" } = useParams();
  const { data, isLoading } = useProperties(id);
  const { data: server } = useServer(id);
  const update = useUpdateProperties(id);
  const { data: automation } = useAutomation(id);
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
  const live = server?.process.state === "running" || (server?.process.state === "external" && server.process.rcon === "connected");

  const save = () =>
    update.mutate(draft, {
      onSuccess: (r) => {
        toast("ok", r.appliedLive.length ? `${r.appliedLive.length}개 즉시 적용, 파일에 저장했습니다.` : "저장했습니다.", { icon: "book" });
        if (r.needsRestart.length) toast("info", `재시작 후 반영: ${r.needsRestart.map((k) => PROPERTY_META_BY_KEY[k]?.label ?? k).join(", ")}`);
        setDraft({});
      },
      onError: (err) => toast("err", (err as Error).message),
    });

  if (isLoading) return <Spinner />;

  const knownKeys = new Set(PROPERTY_META.map((m) => m.key));
  const advancedEntries = (data?.entries ?? []).filter((e) => !knownKeys.has(e.key));
  const groups: { id: Tab; label: string; count: number }[] = [
    ...PROPERTY_GROUPS.map((g) => ({ id: g.id as Tab, label: g.label, count: PROPERTY_META.filter((m) => m.group === g.id).length })),
    { id: "advanced", label: "고급", count: advancedEntries.length },
    { id: "automation", label: "알림·자동화", count: 0 },
  ];
  const dirtyInGroup = (g: Tab) => (g === "automation" ? 0 : Object.keys(draft).filter((k) => (g === "advanced" ? !knownKeys.has(k) : PROPERTY_META_BY_KEY[k]?.group === g)).length);

  return (
    <div className="space-y-5 pb-24">
      <PageHeader
        icon={Settings2}
        title="서버 설정"
        description={
          <span>
            <code className="font-mono text-slate-300">server.properties</code>
            {live ? " · 실행 중: 즉시 적용 가능한 항목은 바로 반영되고, 나머지는 재시작 후 반영돼요." : " · 중지 상태: 파일에 저장되고 다음 시작 때 반영돼요."}
          </span>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[200px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {groups.map((g) => {
            const Icon = GROUP_ICON[g.id];
            const active = tab === g.id;
            const dirty = dirtyInGroup(g.id);
            return (
              <button
                key={g.id}
                onClick={() => setTab(g.id)}
                className={cx("flex shrink-0 items-center gap-2.5 px-3 py-2 text-left font-block text-[12px] transition-colors focus-ring", active ? "slab text-white" : "text-slate-400 hover:bg-ink-2 hover:text-slate-200")}
              >
                <Icon className={cx("h-4 w-4", active ? "text-redstone" : "text-slate-500")} />
                <span className="flex-1">{g.label}</span>
                {dirty > 0 ? <span className="h-1.5 w-1.5 bg-redstone shadow-[0_0_6px_rgba(255,59,47,.7)]" /> : g.id !== "automation" && <span className="text-[11px] text-slate-600 tnum">{g.count}</span>}
              </button>
            );
          })}
        </nav>

        {tab === "automation" ? (
          automation ? <AutomationPanel serverId={id} view={automation} /> : <Spinner />
        ) : tab !== "advanced" ? (
          <Card padded={false} className="divide-y-2 divide-bevel-lo">
            {PROPERTY_META.filter((m) => m.group === tab).map((m) => (
              <FieldRow key={m.key} meta={m} value={value(m.key)} dirty={m.key in draft} live={live} onChange={(v) => set(m.key, v)} />
            ))}
          </Card>
        ) : (
          <Card padded={false} className="overflow-hidden">
            <div className="shadow-[inset_0_-2px_0_#08080a] px-5 py-3 text-xs text-slate-500">위 그룹에 정리되지 않은 나머지 키. 값은 그대로 문자열로 저장돼요.</div>
            <table className="w-full text-sm">
              <tbody className="divide-y-2 divide-bevel-lo">
                {advancedEntries.map((e) => (
                  <tr key={e.key} className={cx(e.key in draft && "bg-redstone/[.06]")}>
                    <td className="w-[40%] px-5 py-2 font-mono text-[12px] text-slate-300">{e.key}</td>
                    <td className="px-4 py-1.5">
                      <Input mono value={value(e.key)} onChange={(ev) => set(e.key, ev.target.value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {server && <ServerDanger server={server} />}

      {dirtyCount > 0 && (
        <div className="glass fixed inset-x-0 bottom-5 z-30 mx-auto flex w-[min(720px,calc(100%-3rem))] animate-slide-up items-center justify-between px-5 py-3">
          <span className="text-sm">
            <b className="font-block text-[12px] text-white">{dirtyCount}개</b> <span className="font-block text-[12px]">항목 변경됨</span>
            {live && <span className="ml-2 text-xs text-slate-400">· 즉시 적용 가능한 항목은 바로 반영돼요</span>}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDraft({})}>
              취소
            </Button>
            <Button variant="primary" icon={Zap} loading={update.isPending} onClick={save}>
              저장
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({ meta, value, dirty, live, onChange }: { meta: PropertyMeta; value: string; dirty: boolean; live: boolean; onChange: (v: string) => void }) {
  const canLive = !!meta.liveCommand;
  return (
    <div className={cx("flex gap-3 px-4 py-3.5 transition sm:flex-row sm:items-center sm:gap-6 sm:px-5", meta.type === "boolean" ? "flex-row items-center" : "flex-col", dirty && "bg-redstone/[.06]")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-100">{meta.label}</span>
          <code className="font-mono text-[11px] text-slate-500">{meta.key}</code>
          {live && <Badge tone={canLive ? "lamp" : "neutral"}>{canLive ? "즉시 적용" : "재시작 필요"}</Badge>}
          {dirty && <span className="h-1.5 w-1.5 bg-redstone shadow-[0_0_6px_rgba(255,59,47,.7)]" />}
        </div>
        {meta.description && <p className="mt-0.5 text-xs text-slate-500">{meta.description}</p>}
      </div>
      <div className={cx("shrink-0 sm:w-60", meta.type === "boolean" ? "w-auto" : "w-full")}>
        {meta.type === "boolean" ? (
          <div className="flex justify-end">
            <Toggle checked={value === "true"} onChange={(v) => onChange(v ? "true" : "false")} />
          </div>
        ) : meta.type === "enum" ? (
          <Select value={value} onChange={(e) => onChange(e.target.value)}>
            {!meta.options.some((o) => o.value === value) && <option value={value}>{value || "(비어 있음)"}</option>}
            {meta.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : meta.type === "int" ? (
          <Input type="number" value={value} min={meta.min} max={meta.max} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input value={value} placeholder={meta.placeholder} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    </div>
  );
}
