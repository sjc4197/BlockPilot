import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Compass, Download, ExternalLink, FileArchive, Package, PackageOpen, RotateCcw, Search, Upload } from "lucide-react";
import { CREATE_LOADER_LABEL, displayLoaderVersion, type CreateModpackRef, type ModpackInspectResult, type ModpackSearchHit, type ModpackVersionEntry } from "@blockpilot/shared";
import { useInspectModpack, useModpackSearch, useModpackVersions, useUploadModpack } from "../api/hooks";
import { ApiRequestError } from "../api/client";
import { Badge, Button, Callout, EmptyState, Input, Select, Spinner, Tabs, cx, useToast } from "../lib/ui";

const fmtDownloads = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
/** 바이트 → "152MB" / "1.4GB" */
export const fmtSize = (bytes: number) => {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(mb < 10 ? 1 : 0)}MB`;
};
/** 처음에 보여 줄 카드 수, "더 보기" 한 번에 늘리는 수 */
const PAGE = 6;

/** 버전 고르기 칸에 보여 줄 한 줄. 팩이 로더 하나만 쓰면 로더 이름은 빼서 짧게 */
const versionLabel = (v: ModpackVersionEntry, withLoader: boolean) =>
  `${v.versionNumber} · MC ${v.gameVersions[0] ?? "?"}${withLoader ? ` · ${v.loaders.map((l) => CREATE_LOADER_LABEL[l]).join("/")}` : ""}${v.versionType === "beta" ? " (베타)" : v.versionType === "alpha" ? " (알파)" : ""}`;

/** Modrinth 모드팩 페이지 */
export const modrinthPackUrl = (projectId: string) => `https://modrinth.com/modpack/${encodeURIComponent(projectId)}`;

/** 팩 아이콘. 주소가 없거나 깨지면 상자 그림으로 */
export function PackIcon({ src, lazy }: { src?: string; lazy?: boolean }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden well">
      {src && !broken ? (
        <img src={src} alt="" className="h-full w-full object-cover" loading={lazy ? "lazy" : undefined} onError={() => setBroken(true)} />
      ) : (
        <div className="grid h-full place-items-center text-slate-500">
          <Package className="h-6 w-6" />
        </div>
      )}
    </div>
  );
}

/**
 * 새 서버 만들기 → "모드팩" 을 골랐을 때. Modrinth 에서 찾거나 .mrpack 을 올리면 서버가 검사해 요약을 돌려준다.
 * 고른 결과(value)는 부모가 들고 있고, 여기선 고르는 과정만 맡는다.
 */
export function ModpackPicker({ value, packRef, onChange, maxUploadBytes }: { value: ModpackInspectResult | null; packRef?: CreateModpackRef | null; onChange: (v: ModpackInspectResult | null, ref: CreateModpackRef | null) => void; maxUploadBytes: number }) {
  const [tab, setTab] = useState<"modrinth" | "upload">("modrinth");
  const [icon, setIcon] = useState<string | undefined>();
  /** 지금 받고 있는(또는 방금 실패한) 팩. 오류를 그 카드 안에 보여 준다 */
  const [pickingId, setPickingId] = useState<string | null>(null);
  const inspect = useInspectModpack();
  const upload = useUploadModpack();

  if (value) {
    return (
      <ModpackSummaryPanel
        value={value}
        iconUrl={icon}
        projectId={packRef?.source === "modrinth" ? packRef.projectId : undefined}
        onReset={() => {
          inspect.reset();
          upload.reset();
          setIcon(undefined);
          onChange(null, null);
        }}
      />
    );
  }

  const switchTab = (t: "modrinth" | "upload") => {
    setTab(t);
    inspect.reset();
    upload.reset();
  };

  return (
    <div className="space-y-4">
      <Tabs
        tabs={[
          { id: "modrinth" as const, label: "Modrinth 검색", icon: Compass },
          { id: "upload" as const, label: "파일 올리기", icon: Upload },
        ]}
        value={tab}
        onChange={switchTab}
      />
      {tab === "modrinth" ? (
        <ModrinthPacks
          busy={inspect.isPending}
          pickingId={pickingId}
          pickError={inspect.error as ApiRequestError | Error | null}
          onUploadTab={() => switchTab("upload")}
          onPick={(hit, versionId) => {
            upload.reset();
            setPickingId(hit.projectId);
            inspect.mutate(
              { source: "modrinth", projectId: hit.projectId, versionId },
              {
                onSuccess: (r) => {
                  setIcon(hit.iconUrl);
                  onChange(r, { uploadId: r.uploadId, source: "modrinth", projectId: hit.projectId, versionId });
                },
              },
            );
          }}
        />
      ) : (
        <>
          {upload.error && <PackError error={upload.error as ApiRequestError | Error} />}
          <UploadZone
            busy={upload.isPending}
            maxUploadBytes={maxUploadBytes}
            onFile={(f) => {
              inspect.reset();
              upload.mutate(f, {
                onSuccess: (r) => {
                  setIcon(undefined);
                  onChange(r, { uploadId: r.uploadId, source: "upload" });
                },
              });
            }}
          />
        </>
      )}
    </div>
  );
}

/** 서버가 준 오류 (+ 해결 방법, 다시 시도) */
function PackError({ error, onRetry, retrying }: { error: ApiRequestError | Error; onRetry?: () => void; retrying?: boolean }) {
  const e = error instanceof ApiRequestError ? error : null;
  return (
    <Callout tone="danger" title={error.message}>
      {e?.hint && <p>{e.hint}</p>}
      {e?.detail && e.code === "modpack_blocked_host" && <pre className="well mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] text-slate-300">{e.detail}</pre>}
      {onRetry && (
        <Button size="sm" className="mt-2" icon={RotateCcw} loading={retrying} onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </Callout>
  );
}

// ---------- Modrinth 에서 찾기 ----------

function ModrinthPacks({ busy, pickingId, pickError, onPick, onUploadTab }: { busy: boolean; pickingId: string | null; pickError: ApiRequestError | Error | null; onPick: (hit: ModpackSearchHit, versionId: string) => void; onUploadTab: () => void }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 400);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setShown(PAGE), [q]);
  const { data, isFetching, isFetchingNextPage, error, refetch, hasNextPage, fetchNextPage } = useModpackSearch(q, true);
  // 같은 팩이 쪽 경계에서 두 번 올 수 있어 projectId 로 거른다
  const hits = useMemo(() => {
    const seen = new Set<string>();
    return (data?.pages ?? []).flatMap((p) => p.hits).filter((h) => !seen.has(h.projectId) && !!seen.add(h.projectId));
  }, [data]);
  const total = data?.pages[0]?.total ?? 0;
  const more = shown < hits.length || !!hasNextPage;

  const showMore = () => {
    const next = shown + PAGE;
    setShown(next);
    // 받아 둔 것보다 더 보여 줘야 하면 다음 쪽을 받는다
    if (next > hits.length && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  };

  return (
    <div className="space-y-3">
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <Input id="modpack-q" className="pl-9" placeholder="모드팩 이름으로 검색 (비우면 인기순)" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {error && !data ? (
        <PackError error={error as Error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : !data ? (
        <div className="flex items-center gap-3 text-[12px] text-slate-500">
          <Spinner /> Modrinth 에서 불러오는 중…
        </div>
      ) : !hits.length ? (
        <EmptyState
          icon={Search}
          title={q ? `Modrinth 에서 "${q}" 모드팩을 찾지 못했어요` : "Modrinth 에서 모드팩을 찾지 못했어요"}
          action={
            <Button icon={Upload} onClick={onUploadTab}>
              파일 올리기로
            </Button>
          }
        >
          다른 이름으로 검색해 보세요. 받은 .mrpack 파일이 있으면 바로 올려도 돼요.
        </EmptyState>
      ) : (
        <>
          <ul className={cx("grid gap-3 md:grid-cols-2", isFetching && !isFetchingNextPage && "opacity-60")}>
            {hits.slice(0, shown).map((h) => (
              <PackCard
                key={h.projectId}
                hit={h}
                selected={selected === h.projectId}
                busy={busy && pickingId === h.projectId}
                disabled={busy}
                pickError={pickingId === h.projectId ? pickError : null}
                onSelect={() => setSelected(selected === h.projectId ? null : h.projectId)}
                onPick={(v) => onPick(h, v)}
              />
            ))}
          </ul>
          {error && <PackError error={error as Error} onRetry={() => void refetch()} retrying={isFetching} />}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-slate-500">
            <span className="break-keep">
              {q ? `"${q}" 검색 결과 ${total.toLocaleString()}개 중 ${Math.min(shown, hits.length).toLocaleString()}개` : `인기순 ${Math.min(shown, hits.length).toLocaleString()}개 · 찾는 팩이 없으면 이름으로 검색해 보세요`} (Fabric·Forge·NeoForge 팩만)
            </span>
            {more && (
              <Button size="sm" variant="ghost" loading={isFetchingNextPage} onClick={showMore}>
                더 보기
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PackCard({ hit: h, selected, busy, disabled, pickError, onSelect, onPick }: { hit: ModpackSearchHit; selected: boolean; busy: boolean; disabled: boolean; pickError: ApiRequestError | Error | null; onSelect: () => void; onPick: (versionId: string) => void }) {
  const { data: versions, isLoading, isFetching, error, refetch } = useModpackVersions(selected ? h.projectId : null);
  const [showPre, setShowPre] = useState(false);
  const [versionId, setVersionId] = useState("");
  const hasRelease = !!versions?.some((v) => v.versionType === "release");
  // 정식 버전만 기본으로. 정식이 하나도 없으면 전부 보여 준다
  const list = useMemo(() => (versions ?? []).filter((v) => showPre || !hasRelease || v.versionType === "release"), [versions, showPre, hasRelease]);
  const multiLoader = new Set((versions ?? []).flatMap((v) => v.loaders)).size > 1;
  useEffect(() => {
    if (list.length && !list.some((v) => v.id === versionId)) setVersionId(list[0].id);
  }, [list, versionId]);

  return (
    <li className={cx("min-w-0", selected ? "slab" : "well")}>
      <button type="button" aria-expanded={selected} disabled={disabled} onClick={onSelect} className="flex w-full min-w-0 gap-3 p-4 text-left focus-ring disabled:cursor-not-allowed sm:gap-4">
        <PackIcon src={h.iconUrl} lazy />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="truncate font-block text-[12px] text-white">{h.title}</div>
          <div className="truncate text-[11px] text-slate-500">
            {h.author} · <Download className="inline h-3 w-3" /> {fmtDownloads(h.downloads)}
          </div>
          <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">{h.description}</p>
          {/* 배지가 많으면 "버전 고르기" 는 다음 줄 오른쪽으로 내려간다 */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {h.loaders.map((l) => (
              <Badge key={l} tone="info">
                {CREATE_LOADER_LABEL[l]}
              </Badge>
            ))}
            {h.gameVersions.slice(0, 3).map((v) => (
              <Badge key={v} mono>
                {v}
              </Badge>
            ))}
            {h.gameVersions.length > 3 && <span className="text-[11px] text-slate-500">외 {h.gameVersions.length - 3}개</span>}
            <span className={cx("ml-auto inline-flex shrink-0 items-center gap-1 pl-2 font-block text-[11px]", selected ? "text-slate-200" : "text-slate-500")}>
              버전 고르기
              <ChevronDown className={cx("h-3.5 w-3.5 transition-transform", selected && "rotate-180")} />
            </span>
          </div>
        </div>
      </button>
      {selected && (
        <div className="space-y-2 px-4 pb-4">
          {error ? (
            <PackError error={error as Error} onRetry={() => void refetch()} retrying={isFetching} />
          ) : isLoading || !versions ? (
            <div className="flex items-center gap-3 text-[12px] text-slate-400">
              <Spinner /> 버전 불러오는 중…
            </div>
          ) : !versions.length ? (
            <span className="text-sm text-slate-400">서버로 만들 수 있는 버전이 없어요.</span>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select aria-label="모드팩 버전" className="min-w-0 sm:flex-1" value={versionId} disabled={disabled} onChange={(e) => setVersionId(e.target.value)}>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      {versionLabel(v, multiLoader)}
                    </option>
                  ))}
                </Select>
                <Button variant="primary" disabled={!versionId || disabled} loading={busy} onClick={() => onPick(versionId)}>
                  이 버전으로
                </Button>
              </div>
              {hasRelease && versions.some((v) => v.versionType !== "release") && (
                <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-400">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-[#c42a20]" checked={showPre} disabled={disabled} onChange={(e) => setShowPre(e.target.checked)} />
                  베타·알파도 보기
                </label>
              )}
              {busy && <p className="text-[12px] text-slate-400">모드팩 받는 중… 큰 팩은 1분 넘게 걸릴 수 있어요</p>}
              {pickError && !busy && <PackError error={pickError} />}
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ---------- 파일 올리기 ----------

function UploadZone({ busy, maxUploadBytes, onFile }: { busy: boolean; maxUploadBytes: number; onFile: (f: File) => void }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (f: File | undefined) => {
    if (!f || busy) return;
    if (!/\.(mrpack|zip)$/i.test(f.name)) return toast("err", ".mrpack 또는 .zip 파일만 올릴 수 있어요.");
    if (maxUploadBytes > 0 && f.size > maxUploadBytes) return toast("err", `파일이 너무 커요 (${fmtSize(f.size)}). ${fmtSize(maxUploadBytes)} 까지 올릴 수 있어요.`);
    onFile(f);
  };

  return (
    <div
      className={cx("well flex flex-col items-center justify-center gap-2 px-6 py-10 text-center transition-colors", over && "bg-redstone/[.08] outline outline-2 outline-redstone/60")}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files[0]);
      }}
    >
      <input
        ref={ref}
        type="file"
        accept=".mrpack,.zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          take(f);
        }}
      />
      <div className="slab mb-1 grid h-12 w-12 place-items-center text-slate-400">
        <FileArchive className="h-6 w-6" />
      </div>
      {busy ? (
        <>
          <Spinner />
          <p className="text-sm text-slate-300">올린 팩을 검사하는 중…</p>
        </>
      ) : (
        <>
          <p className="break-keep font-block text-[12px] text-slate-200">.mrpack 파일을 여기로 끌어다 놓으세요</p>
          <p className="max-w-sm break-keep text-[12px] text-slate-500">
            Modrinth App·Prism 런처에서 내보낸 팩이나 친구가 보내 준 팩을 쓸 수 있어요.{maxUploadBytes > 0 ? ` (최대 ${fmtSize(maxUploadBytes)})` : ""}
          </p>
          <Button className="mt-2" icon={Upload} onClick={() => ref.current?.click()}>
            파일 고르기
          </Button>
        </>
      )}
    </div>
  );
}

// ---------- 고른 팩 요약 ----------

/** 경고 중 "만들 수 없어요" 이유 (서버 문구 기준). 못 찾으면 전부 */
const blockReasons = (warnings: string[]) => {
  const r = warnings.filter((w) => /만들 수 없/.test(w));
  return r.length ? r : warnings;
};

function ModpackSummaryPanel({ value, iconUrl, projectId, onReset }: { value: ModpackInspectResult; iconUrl?: string; projectId?: string; onReset: () => void }) {
  const s = value.summary;
  const blocked = (s.blockedCount ?? 0) > 0;
  const clientOnly = s.clientOnlyCount ?? Math.max(0, s.fileCount - s.serverFileCount);
  const reasons = blocked ? blockReasons(s.warnings) : [];
  const otherWarnings = s.warnings.filter((w) => !reasons.includes(w));
  return (
    <div className="space-y-3">
      <div className="slab flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex min-w-0 flex-1 gap-3 sm:gap-4">
          <PackIcon src={iconUrl} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-words font-block text-[12px] text-white">{s.name}</span>
              <Badge mono>{s.versionId}</Badge>
              {blocked && <Badge tone="danger">만들 수 없음</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="info">
                {CREATE_LOADER_LABEL[s.loader]} {displayLoaderVersion(s.loader, s.mc, s.loaderVersion)}
              </Badge>
              <Badge>Minecraft {s.mc}</Badge>
            </div>
            {/* 항목마다 줄바꿈하지 않게 묶어, 좁으면 항목 단위로 다음 줄로 */}
            <div className="text-[12px] text-slate-300">
              {[`서버에 넣을 모드 ${s.serverFileCount.toLocaleString()}개`, ...(clientOnly > 0 ? [`친구 컴퓨터에만 필요한 것 ${clientOnly.toLocaleString()}개`] : []), fmtSize(s.totalBytes)].map((t, i) => (
                <span key={t}>
                  {i > 0 && " · "}
                  <span className="whitespace-nowrap">{t}</span>
                </span>
              ))}
            </div>
            {s.overrideCount > 0 && <div className="break-keep text-[12px] text-slate-500">설정 등 함께 들어 있는 파일 {s.overrideCount.toLocaleString()}개</div>}
            {s.summary && <p className="line-clamp-2 text-xs leading-relaxed text-slate-500">{s.summary}</p>}
            <div className="truncate font-mono text-[11px] text-slate-600" title={value.fileName}>
              {value.fileName}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="sm" icon={PackageOpen} className="self-end sm:self-start" onClick={onReset}>
          다른 팩 고르기
        </Button>
      </div>
      {blocked ? (
        <Callout tone="danger" title="이 팩으로는 서버를 만들 수 없어요">
          <ul className="space-y-1">
            {reasons.length ? reasons.map((w) => <li key={w}>{w}</li>) : <li>서버에 꼭 필요한 파일 {s.blockedCount}개를 허용되지 않은 주소에서만 받을 수 있어요.</li>}
          </ul>
          <Button size="sm" className="mt-3" icon={PackageOpen} onClick={onReset}>
            다른 팩 고르기
          </Button>
        </Callout>
      ) : (
        <Callout tone="info" title="친구들도 같은 팩이 있어야 해요">
          친구들도 이 팩의 <b className="text-slate-100">같은 버전({s.versionId})</b> 을 Modrinth App·Prism 에 설치해야 접속할 수 있어요.
          {!projectId && " 올린 .mrpack 파일을 친구들에게 그대로 보내 줘도 돼요."}
          {projectId && (
            <a href={modrinthPackUrl(projectId)} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-1 text-red-300 underline underline-offset-2">
              Modrinth 에서 보기 <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </Callout>
      )}
      {otherWarnings.length > 0 && (
        <Callout tone="warning" title="알아 두세요">
          <ul className="space-y-1">
            {otherWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}
