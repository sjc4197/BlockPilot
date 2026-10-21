import { useEffect, useState } from "react";
import { Download, Package, Search } from "lucide-react";
import type { ModrinthHit } from "@blockpilot/shared";
import { useModrinthInstall, useModrinthSearch } from "../api/hooks";
import { Badge, Button, Callout, EmptyState, Input, Spinner, useToast } from "../lib/ui";

const fmtDownloads = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** 모드 화면 → "Modrinth 에서 찾기" 탭 */
export function ModrinthSearch({ serverId, locked, plugin }: { serverId: string; locked: boolean; plugin: boolean }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 400);
    return () => clearTimeout(t);
  }, [text]);
  const { data, isFetching, error } = useModrinthSearch(serverId, q, true);
  const word = plugin ? "플러그인" : "모드";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input id="modrinth-q" className="pl-9" placeholder={`Modrinth 에서 ${word} 검색 (비우면 인기순)`} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {data?.supported && (
          <span className="text-[12px] text-slate-500">
            {data.loader} · Minecraft {data.mcVersion} 에 맞는 것만 · 받은 파일은 sha512 로 검증해요
          </span>
        )}
      </div>
      {locked && <Callout tone="warning">서버를 끈 뒤에 설치할 수 있어요. 검색은 지금도 할 수 있어요.</Callout>}
      {error ? (
        <Callout tone="danger">{(error as Error).message}</Callout>
      ) : !data ? (
        <Spinner />
      ) : !data.supported ? (
        <EmptyState icon={Package} title="이 서버에서는 쓸 수 없어요">
          {data.reason}
        </EmptyState>
      ) : !data.hits.length ? (
        <EmptyState icon={Search} title="찾는 결과가 없어요">
          다른 이름으로 검색해 보세요.
        </EmptyState>
      ) : (
        <ul className={`grid gap-3 md:grid-cols-2 ${isFetching ? "opacity-60" : ""}`}>
          {data.hits.map((h) => (
            <HitCard key={h.projectId} serverId={serverId} hit={h} locked={locked} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HitCard({ serverId, hit: h, locked }: { serverId: string; hit: ModrinthHit; locked: boolean }) {
  const install = useModrinthInstall(serverId);
  const toast = useToast();
  const [confirmClient, setConfirmClient] = useState(false);
  const clientOnly = h.serverSide === "unsupported";

  const go = () => {
    if (clientOnly && !confirmClient) {
      setConfirmClient(true);
      setTimeout(() => setConfirmClient(false), 4000);
      return;
    }
    install.mutate(
      { projectId: h.projectId, allowClientOnly: clientOnly },
      {
        onSuccess: (r) => {
          const deps = r.installed.filter((i) => i.dependency).map((i) => i.title);
          const main = r.installed.find((i) => !i.dependency);
          if (main) toast("ok", `${main.title} ${main.version} 설치${deps.length ? ` (+ 필요한 ${deps.join(", ")})` : ""}`, { icon: "chest", first: "modrinth" });
          if (r.skipped.length) toast("info", r.skipped.map((s) => `${s.title}: ${s.reason}`).join(" · "));
        },
        onError: (e) => toast("err", (e as Error).message),
      },
    );
  };

  return (
    <li className="slab flex gap-4 p-4">
      <div className="h-14 w-14 shrink-0 overflow-hidden well">
        {h.iconUrl ? <img src={h.iconUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="grid h-full place-items-center text-slate-500"><Package className="h-6 w-6" /></div>}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-block text-[12px] text-white">{h.title}</span>
          {h.installed && <Badge tone="lamp">설치됨</Badge>}
          {clientOnly && <Badge tone="warning">클라이언트 전용</Badge>}
        </div>
        <div className="text-[11px] text-slate-500">
          {h.author} · <Download className="inline h-3 w-3" /> {fmtDownloads(h.downloads)}
        </div>
        <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">{h.description}</p>
        <div className="flex justify-end pt-1">
          <Button size="sm" variant={confirmClient ? "danger" : "primary"} disabled={locked || h.installed} loading={install.isPending} onClick={go}>
            {h.installed ? "설치됨" : confirmClient ? "서버엔 필요 없어요. 그래도 설치?" : "설치"}
          </Button>
        </div>
      </div>
    </li>
  );
}
