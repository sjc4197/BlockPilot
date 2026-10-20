import { useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Ban, Crown, Globe, ShieldCheck, UserMinus, UserPlus, Users } from "lucide-react";
import type { PlayerListKind, WhitelistEntry, OpEntry, BannedPlayerEntry, BannedIpEntry } from "@blockpilot/shared";
import { useAddPlayer, usePlayerList, useRemovePlayer, useServer, useUpdateProperties } from "../api/hooks";
import { Avatar, Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, PageHeader, Select, Spinner, Tabs, Toggle, useToast } from "../lib/ui";

const TABS = [
  { id: "whitelist", label: "화이트리스트", icon: ShieldCheck },
  { id: "ops", label: "OP", icon: Crown },
  { id: "banned-players", label: "밴 (플레이어)", icon: Ban },
  { id: "banned-ips", label: "밴 (IP)", icon: Globe },
] as const;

export default function Players() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: PlayerListKind = TABS.some((t) => t.id === tabParam) ? (tabParam as PlayerListKind) : "whitelist";
  const { data: server } = useServer(id);
  const updateProps = useUpdateProperties(id);
  const toast = useToast();
  const live = server?.process.state === "running" || (server?.process.state === "external" && server.process.rcon === "connected");

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Users}
        title="플레이어"
        description={live ? "서버 실행 중 · 변경 사항은 콘솔 명령으로 즉시 반영돼요." : "서버 중지 상태 · 파일을 직접 수정하고 다음 시작 때 반영돼요."}
        actions={
          server && (
            <label className="flex h-9 items-center gap-3 well px-3 text-sm">
              <span className="text-slate-300">화이트리스트 사용</span>
              <Toggle
                size="sm"
                checked={server.properties.whitelist}
                disabled={updateProps.isPending}
                onChange={(v) =>
                  updateProps.mutate(
                    { "white-list": v ? "true" : "false" },
                    { onSuccess: () => toast("ok", v ? "화이트리스트를 켰습니다." : "화이트리스트를 껐습니다."), onError: (e) => toast("err", (e as Error).message) },
                  )
                }
              />
            </label>
          )
        }
      />

      <Tabs tabs={[...TABS]} value={tab} onChange={(t) => setParams({ tab: t })} />

      <ListPanel key={tab} serverId={id} kind={tab} />
    </div>
  );
}

function ListPanel({ serverId, kind }: { serverId: string; kind: PlayerListKind }) {
  const { data, isLoading } = usePlayerList<any>(serverId, kind);
  const add = useAddPlayer(serverId, kind);
  const remove = useRemovePlayer(serverId, kind);
  const toast = useToast();
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [level, setLevel] = useState(4);
  const isIp = kind === "banned-ips";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = isIp ? { ip: ip.trim(), reason: reason || undefined } : { name: name.trim(), reason: reason || undefined, level: kind === "ops" ? level : undefined };
    add.mutate(input, {
      onSuccess: (r) => {
        toast("ok", r.profile ? `${r.profile.name} 추가 (${r.applied === "live" ? "즉시 반영" : "파일 저장"})` : "추가했습니다.");
        setName("");
        setIp("");
        setReason("");
      },
      onError: (err) => toast("err", (err as Error).message),
    });
  };

  const removeEntry = (key: string, label: string) =>
    remove.mutate(key, { onSuccess: () => toast("info", `${label} 제거`), onError: (err) => toast("err", (err as Error).message) });

  return (
    <div className="space-y-4">
      <Card>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          {isIp ? (
            <Field label="IP 주소" className="min-w-56 flex-1">
              <Input mono value={ip} onChange={(e) => setIp(e.target.value)} placeholder="1.2.3.4" required />
            </Field>
          ) : (
            <Field label="닉네임 · UUID는 Mojang에서 자동 조회" className="min-w-56 flex-1">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Steve" pattern="[A-Za-z0-9_]{1,16}" required />
            </Field>
          )}
          {kind === "ops" && (
            <Field label="권한 레벨" className="w-28 shrink-0">
              <Select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                {[1, 2, 3, 4].map((l) => (
                  <option key={l} value={l}>
                    레벨 {l}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind.startsWith("banned") && (
            <Field label="사유 (선택)" className="min-w-56 flex-1">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Banned by an operator." />
            </Field>
          )}
          <Button variant="primary" type="submit" icon={UserPlus} loading={add.isPending} className={!isIp ? "mb-[18px]" : ""}>
            추가
          </Button>
        </form>
      </Card>

      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState icon={Users} title="목록이 비어 있어요">
          위 폼에서 추가하면 여기에 표시됩니다.
        </EmptyState>
      ) : (
        <Card padded={false} className="divide-y-2 divide-bevel-lo">
          {data.map((e: WhitelistEntry | OpEntry | BannedPlayerEntry | BannedIpEntry) => {
            const key = "ip" in e ? e.ip : e.uuid;
            const label = "ip" in e ? e.ip : e.name;
            return (
              <div key={key} className="flex items-center gap-4 px-5 py-3">
                {"name" in e ? <Avatar id={e.uuid} size={36} /> : <div className="well grid h-9 w-9 place-items-center text-slate-400"><Globe className="h-4 w-4" /></div>}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-block text-[12px] text-white">{label}</span>
                    {"level" in e && <Badge tone="brand">레벨 {e.level}</Badge>}
                    {"bypassesPlayerLimit" in e && e.bypassesPlayerLimit && <Badge>인원 제한 무시</Badge>}
                    {"expires" in e && <Badge tone={e.expires === "forever" ? "danger" : "warning"}>{e.expires === "forever" ? "영구" : `만료 ${e.expires}`}</Badge>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                    {"uuid" in e && e.uuid}
                    {"reason" in e && <span className="ml-2 font-sans text-slate-500">· {e.reason}</span>}
                  </div>
                </div>
                <ConfirmButton size="sm" variant="ghost" icon={UserMinus} label="제거" confirmLabel="제거할까요?" onConfirm={() => removeEntry(key, label)} />
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
