import { useRef } from "react";
import { useParams } from "react-router-dom";
import type { ModInfo } from "@blockpilot/shared";
import { useDeleteMod, useMods, useServer, useToggleMod, useUploadMods } from "../api/hooks";
import { withToken } from "../api/client";
import { btn, card, cx, ConfirmButton, EmptyState, Spinner, Toggle, useToast } from "../lib/ui";

export default function Mods() {
  const { id = "" } = useParams();
  const { data: mods, isLoading } = useMods(id);
  const { data: server } = useServer(id);
  const toggle = useToggleMod(id);
  const del = useDeleteMod(id);
  const upload = useUploadMods(id);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const locked = server ? server.process.state !== "stopped" : true;
  const onErr = (err: unknown) => toast("err", (err as Error).message);

  const enabled = mods?.filter((m) => m.enabled) ?? [];
  const problems = enabled.filter((m) => m.missingDeps.length);
  const isPaper = server?.loader === "paper";
  const clientMods = enabled.filter((m) => m.environment !== "server");

  const copyList = async () => {
    const text = [
      `${server?.name ?? "서버"} 모드 목록 (${server?.mcVersion ?? ""} ${server?.loader ?? ""})`,
      ...clientMods.map((m) => `- ${m.name ?? m.file}${m.version ? ` ${m.version}` : ""}  (${m.file})`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("ok", "모드 목록을 클립보드에 복사했습니다.");
    } catch {
      toast("err", "클립보드에 복사하지 못했습니다.");
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{isPaper ? "플러그인" : "모드"}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {isPaper ? "plugins/" : "mods/"} 폴더 · 활성 {enabled.length}개 / 전체 {mods?.length ?? 0}개
            {locked && <span className="ml-2 text-amber-300">· 서버를 중지해야 변경할 수 있습니다</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isPaper && clientMods.length > 0 && (
            <>
              <button className={cx(btn.base, btn.secondary)} onClick={copyList}>
                목록 복사
              </button>
              <a className={cx(btn.base, btn.secondary)} href={withToken(`/api/servers/${id}/mods/export`)} title="친구들에게 나눠줄 클라이언트용 모드 zip">
                친구용 zip 다운로드
              </a>
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
              upload.mutate(files, { onSuccess: (r) => toast("ok", `${r.saved.length}개 모드를 추가했습니다.`), onError: onErr });
            }}
          />
          <button className={cx(btn.base, btn.primary)} disabled={locked || upload.isPending} onClick={() => fileRef.current?.click()}>
            {upload.isPending ? "업로드 중..." : "+ jar 추가"}
          </button>
        </div>
      </header>

      {problems.length > 0 && (
        <div className="rounded-lg border border-red-700/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          <b>의존성 문제:</b>{" "}
          {problems.map((m) => `${m.name ?? m.file} → ${m.missingDeps.join(", ")}`).join(" / ")}
          <div className="mt-1 text-xs text-red-300/80">빠진 모드를 추가하거나 버전을 맞추지 않으면 서버가 시작되지 않습니다.</div>
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : !mods?.length ? (
        <EmptyState>mods 폴더에 jar 파일이 없습니다. 바닐라 서버이거나 아직 모드를 넣지 않은 상태예요.</EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {mods.map((m) => (
            <ModCard
              key={m.file}
              mod={m}
              locked={locked}
              onToggle={(v) => toggle.mutate({ file: m.file, enabled: v }, { onError: onErr })}
              onDelete={() => del.mutate(m.file, { onSuccess: () => toast("info", `${m.file} 삭제`), onError: onErr })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ModCard({ mod: m, locked, onToggle, onDelete }: { mod: ModInfo; locked: boolean; onToggle: (v: boolean) => void; onDelete: () => void }) {
  return (
    <li className={cx(card, "flex gap-4", !m.enabled && "opacity-60")}>
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-800">
        {m.iconDataUrl ? <img src={m.iconDataUrl} alt="" className="h-full w-full object-cover" style={{ imageRendering: "pixelated" }} /> : <div className="flex h-full items-center justify-center text-lg">🧩</div>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{m.name ?? m.file}</div>
            <div className="truncate text-xs text-slate-500">
              {m.version && <span className="console-font">{m.version}</span>}
              {m.authors.length > 0 && <span> · {m.authors.join(", ")}</span>}
            </div>
          </div>
          <Toggle checked={m.enabled} disabled={locked} onChange={onToggle} />
        </div>
        {m.description && <p className="mt-2 line-clamp-2 text-xs text-slate-400">{m.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {m.environment === "client" && <Tag cls="bg-sky-900/60 text-sky-300">클라이언트 전용</Tag>}
          {m.loader === "unknown" && <Tag cls="bg-slate-800 text-slate-400">메타데이터 없음</Tag>}
          {m.depends
            .filter((d) => !["minecraft", "java", "fabricloader", "fabric-loader"].includes(d.id))
            .map((d) => (
              <Tag key={d.id} cls={d.satisfied === false ? "bg-red-900/60 text-red-300" : d.satisfied === null ? "bg-amber-900/40 text-amber-300" : "bg-slate-800 text-slate-400"} title={`${d.id} ${d.version}`}>
                {d.id}
              </Tag>
            ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="truncate text-[11px] text-slate-600 console-font" title={m.file}>
            {m.file} · {(m.sizeBytes / 1024 / 1024).toFixed(1)} MB
          </span>
          <ConfirmButton label="삭제" confirmLabel="정말 삭제?" className={btn.ghost} disabled={locked} onConfirm={onDelete} />
        </div>
      </div>
    </li>
  );
}

function Tag({ children, cls, title }: { children: React.ReactNode; cls: string; title?: string }) {
  return (
    <span title={title} className={cx("rounded px-1.5 py-px text-[10px]", cls)}>
      {children}
    </span>
  );
}
