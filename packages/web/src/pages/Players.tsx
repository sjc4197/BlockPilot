import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import type { PlayerListKind, WhitelistEntry, OpEntry, BannedPlayerEntry, BannedIpEntry } from "@blockpilot/shared";
import { useAddPlayer, usePlayerList, useRemovePlayer, useServer, useUpdateProperties } from "../api/hooks";
import { btn, card, cx, input, ConfirmButton, EmptyState, Toggle, useToast, Spinner } from "../lib/ui";

const TABS: { id: PlayerListKind; label: string }[] = [
  { id: "whitelist", label: "화이트리스트" },
  { id: "ops", label: "OP" },
  { id: "banned-players", label: "밴 (플레이어)" },
  { id: "banned-ips", label: "밴 (IP)" },
];

export default function Players() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<PlayerListKind>("whitelist");
  const { data: server } = useServer(id);
  const updateProps = useUpdateProperties(id);
  const toast = useToast();
  const running = server?.process.state === "running";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">플레이어</h1>
          <p className="mt-1 text-sm text-slate-400">
            {running ? "서버 실행 중: 변경 사항은 콘솔 명령으로 즉시 반영됩니다." : "서버 중지 상태: 파일을 직접 수정합니다. 다음 시작 때 반영돼요."}
          </p>
        </div>
        {server && (
          <label className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 text-sm">
            화이트리스트 사용
            <Toggle
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
        )}
      </header>

      <nav className="flex gap-1 border-b border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx("px-3 py-2 text-sm border-b-2 -mb-px", tab === t.id ? "border-emerald-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200")}
          >
            {t.label}
          </button>
        ))}
      </nav>

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
    remove.mutate(key, {
      onSuccess: () => toast("info", `${label} 제거`),
      onError: (err) => toast("err", (err as Error).message),
    });

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className={cx(card, "flex flex-wrap items-end gap-3")}>
        {isIp ? (
          <div className="flex-1 min-w-48">
            <label className="mb-1 block text-xs text-slate-400">IP 주소</label>
            <input className={input} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="1.2.3.4" required />
          </div>
        ) : (
          <div className="flex-1 min-w-48">
            <label className="mb-1 block text-xs text-slate-400">닉네임 (UUID는 Mojang에서 자동 조회)</label>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Steve" pattern="[A-Za-z0-9_]{1,16}" required />
          </div>
        )}
        {kind === "ops" && (
          <div className="w-32 shrink-0">
            <label className="mb-1 block text-xs text-slate-400">권한 레벨</label>
            <select className={input} value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              {[1, 2, 3, 4].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind.startsWith("banned") && (
          <div className="flex-1 min-w-48">
            <label className="mb-1 block text-xs text-slate-400">사유 (선택)</label>
            <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        <button className={cx(btn.base, btn.primary)} disabled={add.isPending}>
          {add.isPending ? "조회 중..." : "추가"}
        </button>
      </form>

      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState>목록이 비어 있습니다.</EmptyState>
      ) : (
        <ul className={cx(card, "divide-y divide-slate-800 p-0")}>
          {data.map((e: WhitelistEntry | OpEntry | BannedPlayerEntry | BannedIpEntry) => {
            const key = "ip" in e ? e.ip : e.uuid;
            const label = "ip" in e ? e.ip : e.name;
            return (
              <li key={key} className="flex items-center gap-4 px-5 py-3">
                {"name" in e && <img src={`https://mc-heads.net/avatar/${e.uuid}/32`} alt="" className="h-8 w-8 rounded" />}
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{label}</div>
                  <div className="truncate text-xs text-slate-500">
                    {"uuid" in e && e.uuid}
                    {"level" in e && ` · 레벨 ${e.level}`}
                    {"reason" in e && ` · ${e.reason}`}
                    {"expires" in e && e.expires !== "forever" && ` · 만료 ${e.expires}`}
                  </div>
                </div>
                <ConfirmButton label="제거" confirmLabel="제거할까요?" className={btn.ghost} onConfirm={() => removeEntry(key, label)} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
