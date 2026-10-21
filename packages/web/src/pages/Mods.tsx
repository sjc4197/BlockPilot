import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ArrowUpCircle, Boxes, ClipboardList, Compass, Download, Package, Plus, Search, Trash2 } from "lucide-react";
import type { ModInfo, ModUpdate } from "@blockpilot/shared";
import { useApplyModUpdates, useDeleteMod, useModUpdates, useMods, useServer, useToggleMod, useUploadMods } from "../api/hooks";
import { ModrinthSearch } from "../components/ModrinthSearch";
import { withToken } from "../api/client";
import { Badge, Button, Callout, EmptyState, HoldButton, Input, LinkButton, PageHeader, Spinner, Tabs, Toggle, cx, fmtBytes, useToast } from "../lib/ui";

export default function Mods() {
  const { id = "" } = useParams();
  const { data: mods, isLoading } = useMods(id);
  const { data: server } = useServer(id);
  const toggle = useToggleMod(id);
  const del = useDeleteMod(id);
  const upload = useUploadMods(id);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"installed" | "modrinth">("installed");
  const { data: updates } = useModUpdates(id);
  const applyUpdates = useApplyModUpdates(id);
  const updateOf = useMemo(() => new Map((updates ?? []).map((u) => [u.file, u])), [updates]);
  const runUpdates = (files: string[]) =>
    applyUpdates.mutate(files, {
      onSuccess: (r) => toast("ok", `${r.updated.length}개 업데이트했어요. 이전 파일은 ${r.backupDir} 에 있어요.`, { icon: "chest" }),
      onError: (e) => toast("err", (e as Error).message),
    });
  const locked = server ? server.process.state !== "stopped" : true;
  const onErr = (err: unknown) => toast("err", (err as Error).message);

  const enabled = mods?.filter((m) => m.enabled) ?? [];
  const problems = enabled.filter((m) => m.missingDeps.length);
  const isPaper = server?.loader === "paper";
  const clientMods = enabled.filter((m) => m.environment !== "server");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (mods ?? []).filter((m) => !s || [m.name, m.id, m.file, m.description, ...m.authors].some((x) => x?.toLowerCase().includes(s)));
  }, [mods, q]);

  const copyList = async () => {
    const text = [`${server?.name ?? "서버"} 모드 목록 (${server?.mcVersion ?? ""} ${server?.loader ?? ""})`, ...clientMods.map((m) => `- ${m.name ?? m.file}${m.version ? ` ${m.version}` : ""}  (${m.file})`)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("ok", "모드 목록을 클립보드에 복사했습니다.");
    } catch {
      toast("err", "클립보드에 복사하지 못했습니다.");
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Boxes}
        title={isPaper ? "플러그인" : "모드"}
        description={
          <span>
            <code className="font-mono text-slate-300">{isPaper ? "plugins/" : "mods/"}</code> · 활성 <b className="text-slate-200">{enabled.length}</b> / 전체 {mods?.length ?? 0}
            {locked && <span className="ml-2 text-amber-300">· 서버를 중지해야 변경할 수 있어요</span>}
          </span>
        }
        actions={
          <>
            {!isPaper && clientMods.length > 0 && (
              <>
                <Button icon={ClipboardList} onClick={copyList}>
                  목록 복사
                </Button>
                <LinkButton icon={Download} href={withToken(`/api/servers/${id}/mods/export`)} title="친구들에게 나눠줄 클라이언트용 모드 zip">
                  친구용 zip
                </LinkButton>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".jar"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (!files.length) return;
                upload.mutate(files, { onSuccess: (r) => toast("ok", `${r.saved.length}개 추가했습니다.`), onError: onErr });
              }}
            />
            <Button variant="primary" icon={Plus} disabled={locked} loading={upload.isPending} onClick={() => fileRef.current?.click()}>
              jar 추가
            </Button>
          </>
        }
      />

      <Tabs
        tabs={[
          { id: "installed" as const, label: "설치된 " + (isPaper ? "플러그인" : "모드"), count: mods?.length ?? 0 },
          { id: "modrinth" as const, label: "Modrinth 에서 찾기", icon: Compass },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "modrinth" ? (
        <ModrinthSearch serverId={id} locked={locked} plugin={isPaper} />
      ) : (
      <>
      {(updates?.length ?? 0) > 0 && (
        <Callout tone="lamp" icon={ArrowUpCircle} title={`업데이트 ${updates!.length}개`}>
          Modrinth 에 새 버전이 있어요. 이전 jar 는 .blockpilot-backup/ 에 보관돼서 되돌릴 수 있어요.
          <div className="mt-2">
            <Button size="sm" variant="primary" disabled={locked} loading={applyUpdates.isPending} onClick={() => runUpdates(updates!.map((u) => u.file))}>
              모두 업데이트
            </Button>
            {locked && <span className="ml-2 text-[12px] text-amber-300">서버를 끈 뒤에 할 수 있어요</span>}
          </div>
        </Callout>
      )}

      {problems.length > 0 && (
        <Callout tone="danger" title="의존성 문제 — 이대로는 서버가 시작되지 않을 수 있어요">
          {problems.map((m) => (
            <div key={m.file}>
              <b>{m.name ?? m.file}</b> → 필요: {m.missingDeps.join(", ")}
            </div>
          ))}
        </Callout>
      )}

      {(mods?.length ?? 0) > 4 && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input className="pl-9" placeholder="이름, 파일명, 제작자 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : !mods?.length ? (
        <EmptyState icon={Package} title={`${isPaper ? "plugins" : "mods"} 폴더가 비어 있어요`}>
          바닐라 서버이거나 아직 모드를 넣지 않은 상태예요. 오른쪽 위 "jar 추가"로 올릴 수 있어요.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {filtered.map((m, i) => (
            <ModCard
              key={m.file}
              mod={m}
              locked={locked}
              delay={i * 30}
              onToggle={(v) => toggle.mutate({ file: m.file, enabled: v }, { onError: onErr })}
              onDelete={() => del.mutate(m.file, { onSuccess: () => toast("info", `${m.file} 삭제`), onError: onErr })}
              update={updateOf.get(m.file)}
              onUpdate={() => runUpdates([m.file])}
            />
          ))}
        </ul>
      )}
      </>
      )}
    </div>
  );
}

const ENV_DEPS = new Set(["minecraft", "java", "fabricloader", "fabric-loader"]);

function ModCard({ mod: m, locked, delay, onToggle, onDelete, update, onUpdate }: { mod: ModInfo; locked: boolean; delay: number; onToggle: (v: boolean) => void; onDelete: () => void; update?: ModUpdate; onUpdate: () => void }) {
  return (
    <li className={cx("slab flex animate-slide-up gap-4 p-4", !m.enabled && "opacity-60 saturate-50")} style={{ animationDelay: `${delay}ms` }}>
      <div className="h-14 w-14 shrink-0 overflow-hidden well">
        {m.iconDataUrl ? <img src={m.iconDataUrl} alt="" className="h-full w-full object-cover" style={{ imageRendering: "pixelated" }} /> : <div className="grid h-full place-items-center text-slate-500"><Package className="h-6 w-6" /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-block text-[12px] text-white">{m.name ?? m.file}</span>
              {m.version && <Badge mono>{m.version}</Badge>}
              {!m.enabled && <Badge tone="warning">비활성</Badge>}
              {update && (
                <button type="button" className="focus-ring disabled:cursor-not-allowed" disabled={locked} onClick={onUpdate} title={locked ? "서버를 끈 뒤에 업데이트할 수 있어요" : `${update.latest} 로 업데이트`}>
                  <Badge tone="lamp">
                    <ArrowUpCircle className="h-3 w-3" /> {update.latest}
                  </Badge>
                </button>
              )}
            </div>
            {m.authors.length > 0 && <div className="mt-0.5 truncate text-xs text-slate-500">{m.authors.join(", ")}</div>}
          </div>
          <Toggle size="sm" checked={m.enabled} disabled={locked} onChange={onToggle} />
        </div>
        {m.description && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-400">{m.description}</p>}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {m.environment === "client" && <Badge tone="info">클라이언트 전용</Badge>}
          {m.environment === "server" && <Badge tone="info">서버 전용</Badge>}
          {m.loader === "unknown" && <Badge>메타데이터 없음</Badge>}
          {m.depends
            .filter((d) => !ENV_DEPS.has(d.id))
            .map((d) => (
              <Badge key={d.id} mono tone={d.satisfied === false ? "danger" : d.satisfied === null ? "warning" : "neutral"} className="!font-normal" >
                <span title={`${d.id} ${d.version}`}>{d.id}</span>
              </Badge>
            ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 shadow-[inset_0_2px_0_#08080a] pt-2.5">
          <span className="truncate font-mono text-[11px] text-slate-500" title={m.file}>
            {m.file} · {fmtBytes(m.sizeBytes)}
          </span>
          <HoldButton icon={Trash2} label="삭제" disabled={locked} onConfirm={onDelete} />
        </div>
      </div>
    </li>
  );
}
