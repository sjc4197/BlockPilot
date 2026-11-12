import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FolderSearch, Hammer, LayoutDashboard, Lock, PackageOpen, RotateCcw, X } from "lucide-react";
import { CREATE_LOADER_LABEL, displayLoaderVersion, type CreateJobStatus, type CreateLoader, type CreateLoaderInfo, type CreateModpackRef, type CreateServerInput, type CreateStep, type ModpackInspectResult } from "@blockpilot/shared";
import { useCancelCreate, useCreateJob, useCreateOptions, useCreateReleases, useStartCreate, useSystem, useVersionInfo, keys } from "../api/hooks";
import { ApiRequestError } from "../api/client";
import { FolderPicker } from "../components/FolderPicker";
import { ModpackPicker, fmtSize } from "../components/ModpackPicker";
import { Lamp, TntIcon } from "../lib/pixel";
import { Badge, Button, Callout, Card, ConfirmButton, Field, Input, PageHeader, SectionTitle, Select, Spinner, Toggle, cx, useToast } from "../lib/ui";
import { XpBar } from "../lib/fx";

/** 서버 종류 칸: 로더 다섯 + "모드팩" (모드팩은 팩이 정한 로더로 만든다) */
type Kind = CreateLoader | "modpack";

/** 고른 팩: 화면에 보여 줄 검사 결과 + 만들기 요청에 보낼 참조 */
type PickedPack = { result: ModpackInspectResult; ref: CreateModpackRef };

/** 고른 서버 종류 아래 한 줄 안내. 여섯 종류 모두 짧게 써서 카드 높이가 크게 바뀌지 않는다 */
const LOADER_HINT: Record<Kind, string> = {
  fabric: "모드는 만든 뒤 모드 화면에서 Modrinth 로 넣을 수 있어요. 친구들도 같은 모드와 Fabric 을 깔아야 접속해요.",
  paper: "플러그인은 만든 뒤 모드 화면에서 Modrinth 로 넣을 수 있어요. 친구들은 아무것도 깔지 않아도 돼요.",
  forge: "친구들도 같은 버전의 Forge 와 모드를 깔아야 접속해요. 설치기가 만든 run 스크립트 대신 BlockPilot 의 start 스크립트로 켜요.",
  neoforge: "친구들도 같은 버전의 NeoForge 와 모드를 깔아야 접속해요. 설치기의 run 스크립트 대신 BlockPilot 의 start 스크립트로 켜요.",
  vanilla: "모드·플러그인을 쓸 수 없어요. 나중에 필요하면 Fabric 이나 Paper 로 새로 만들어 주세요.",
  modpack: "팩이 정한 로더·버전으로 만들고 모드·설정을 자동으로 넣어요. 친구들은 같은 팩을 런처(Modrinth App 등)에 설치하면 접속해요.",
};

const MODPACK_TILE = { label: "모드팩", summary: "Modrinth 팩이나 .mrpack 파일로 모드까지 한 번에" };

const MEMORY_STEPS_MB = [1024, 1536, 2048, 3072, 4096, 5120, 6144, 8192, 10240, 12288, 16384];
const gb = (mb: number) => `${Number((mb / 1024).toFixed(1))}GB`;

/** 서버 이름 → 폴더 이름. 어느 OS 에서도 쓸 수 있게: 공백은 -, 끝의 점 제거, Windows 예약 이름(CON 등) 피하기 */
function folderNameOf(name: string) {
  let s = name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9가-힣_.-]/g, "").replace(/[.]+$/, "");
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)) s = `${s}-server`;
  return s || "my-server";
}

export default function NewServer() {
  const { data: options, isLoading } = useCreateOptions();
  const [jobId, setJobId] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<CreateServerInput | null>(null);
  const [lastPack, setLastPack] = useState<PickedPack | null>(null);

  // 새로고침해도 진행 중인 작업으로 돌아온다
  useEffect(() => {
    if (options?.activeJobId && !jobId) setJobId(options.activeJobId);
  }, [options?.activeJobId, jobId]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <Link to="/" className="mb-6 inline-flex items-center gap-1.5 font-block text-[12px] text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> 서버 목록
      </Link>
      {isLoading || !options ? (
        <Spinner />
      ) : !options.supported ? (
        <div className="space-y-5">
          <PageHeader icon={Hammer} title="새 서버 만들기" />
          <Callout tone="warning" title="아직 준비 중이에요">
            {options.unsupportedMessage} 이미 만든 서버 폴더는 서버 목록의 "서버 폴더 추가"로 연결할 수 있어요.
          </Callout>
        </div>
      ) : jobId ? (
        <Progress
          jobId={jobId}
          onRetry={(clearPack) => {
            if (clearPack) setLastPack(null);
            setJobId(null);
          }}
        />
      ) : (
        <CreateForm
          options={options}
          initial={lastInput}
          initialPack={lastPack}
          onStarted={(id, input, pack) => {
            setLastInput(input);
            setLastPack(pack);
            setJobId(id);
          }}
        />
      )}
    </div>
  );
}

// ---------- 입력 폼 ----------

function CreateForm({ options, initial, initialPack, onStarted }: { options: NonNullable<ReturnType<typeof useCreateOptions>["data"]>; initial: CreateServerInput | null; initialPack: PickedPack | null; onStarted: (jobId: string, input: CreateServerInput, pack: PickedPack | null) => void }) {
  const p = initial?.properties ?? {};
  const [name, setName] = useState(initial?.name ?? "my-server");
  const [nameTouched, setNameTouched] = useState(!!initial);
  /** 팩 이름으로 자동으로 채운 이름. 사용자가 그대로 두었으면 다른 팩을 고를 때 다시 바꾼다 */
  const autoName = useRef<string | null>(initial?.modpack && initialPack && initial.name === initialPack.result.summary.name.trim().slice(0, 60) ? initial.name : null);
  /** 팩을 처음 고르기 전의 이름·메모리. 다른 서버 종류로 돌아가면 되돌린다 */
  const prePack = useRef<{ name: string; nameTouched: boolean; minMb: number; maxMb: number } | null>(null);
  const [path, setPath] = useState(initial?.path ?? "");
  const [pathTouched, setPathTouched] = useState(!!initial);
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<Kind>(initial?.modpack ? "modpack" : (initial?.loader ?? "fabric"));
  const [pack, setPack] = useState<PickedPack | null>(initial?.modpack ? initialPack : null);
  const isPack = kind === "modpack";
  const packSummary = isPack ? (pack?.result.summary ?? null) : null;
  /** 실제로 설치할 로더. 모드팩은 팩이 정한 것 (고르기 전엔 Fabric 으로 목록만 불러 둔다) */
  const loaderKind: CreateLoader = kind === "modpack" ? (pack?.result.summary.loader ?? "fabric") : kind;
  const kindInfo = options.loaders.find((l) => l.id === loaderKind) ?? options.loaders[0];
  const { data: releases, isLoading: rLoading, error: rError } = useCreateReleases(loaderKind);
  const [mc, setMc] = useState(initial?.mcVersion ?? "");
  const [loader, setLoader] = useState(initial?.loaderVersion ?? "");
  const [difficulty, setDifficulty] = useState(p.difficulty ?? "normal");
  const [gamemode, setGamemode] = useState(p.gamemode ?? "survival");
  const [pvp, setPvp] = useState(p.pvp ? p.pvp === "true" : true);
  const [whitelist, setWhitelist] = useState(p["white-list"] ? p["white-list"] === "true" : true);
  const [maxPlayers, setMaxPlayers] = useState(p["max-players"] ?? "10");
  const [motd, setMotd] = useState(p.motd ?? "BlockPilot 으로 만든 서버");
  const [port, setPort] = useState(p["server-port"] ?? "25565");
  const [seed, setSeed] = useState(p["level-seed"] ?? "");
  const [minMb, setMinMb] = useState(initial?.memory.minMb ?? options.defaults.memory.minMb);
  const [maxMb, setMaxMb] = useState(initial?.memory.maxMb ?? options.defaults.memory.maxMb);
  const [owner, setOwner] = useState(initial?.ownerName ?? "");
  // EULA 는 다시 시도할 때도 반드시 다시 체크해야 한다
  const [eula, setEula] = useState(false);

  const start = useStartCreate();
  const here = useSystem().data?.words.thisComputer ?? "이 컴퓨터";
  const mcListed = !!releases?.some((r) => r.id === mc);
  // 모드팩은 팩이 정한 Minecraft 를 그대로 쓴다 (목록에 없는 버전이어도 Java 안내는 받아 본다)
  const { data: vinfo, isFetching: vLoading, error: vError } = useVersionInfo(isPack ? packSummary?.mc : mcListed ? mc : undefined, loaderKind);
  const folder = folderNameOf(name);
  const toast = useToast();

  // 서버 종류를 바꾸면 그 종류가 지원하는 Minecraft 목록으로 (고른 버전이 없으면 가장 새 것으로 바꾸고 알려 준다)
  useEffect(() => {
    if (isPack || !releases || mcListed) return;
    const next = releases[0]?.id ?? "";
    if (mc && next) toast("info", `${kindInfo.label} 는 Minecraft ${mc} 를 지원하지 않아 ${next} 으로 바꿨어요.`);
    setMc(next);
  }, [isPack, releases, mcListed, mc, kindInfo.label, toast]);

  useEffect(() => {
    if (!pathTouched) setPath(`${options.defaults.parentDir}/${folder}`);
  }, [folder, pathTouched, options.defaults.parentDir]);
  useEffect(() => {
    if (isPack) return;
    if (vinfo && vinfo.loader === kind && vinfo.mcVersion === mc && !vinfo.loaders.some((l) => l.version === loader)) setLoader(vinfo.recommendedLoader ?? "");
  }, [isPack, vinfo, loader, kind, mc]);

  const memOptions = useMemo(() => MEMORY_STEPS_MB.filter((m) => m <= options.totalMemMb * 0.75), [options.totalMemMb]);
  /** 메모리 칸에 있는 값 중 want 이하로 가장 큰 것 (없으면 가장 작은 것) */
  const snapMem = (want: number) => memOptions.filter((m) => m <= want).pop() ?? memOptions[0] ?? want;

  /** 팩을 고르면 Minecraft·로더 버전·메모리를 팩에 맞추고, 이름을 아직 안 바꿨으면 팩 이름으로 */
  const pickPack = (result: ModpackInspectResult | null, ref: CreateModpackRef | null) => {
    start.reset();
    if (!result || !ref) return setPack(null);
    const s = result.summary;
    if (!prePack.current) prePack.current = { name, nameTouched, minMb, maxMb };
    setPack({ result, ref });
    setMc(s.mc);
    setLoader(s.loaderVersion);
    const max = snapMem(s.suggestedMaxMb);
    setMaxMb(max);
    setMinMb(Math.min(max, snapMem(Math.max(1024, Math.round(max / 2 / 512) * 512))));
    if (!nameTouched || name.trim() === "my-server" || name === autoName.current) {
      const next = s.name.trim().slice(0, 60) || "my-server";
      autoName.current = next;
      setName(next);
    }
  };
  /** 팩이 원하는 메모리 (이 컴퓨터에 맞춰 자르기 전) */
  const packIdealMb = packSummary ? (packSummary.idealMaxMb ?? packSummary.suggestedMaxMb) : 0;
  const memShort = packSummary && memOptions.length > 0 && packIdealMb > memOptions[memOptions.length - 1];
  const packBlocked = !!packSummary && (packSummary.blockedCount ?? 0) > 0;

  const versionOk = isPack ? !!packSummary && !packBlocked : kindInfo.hasVersions ? !!loader && !!vinfo?.loaders.some((l) => l.version === loader) : true;
  const ready = eula && name.trim() && path.trim() && (isPack ? !!packSummary : mc) && versionOk && !vLoading && !start.isPending;

  const submit = () => {
    const properties: Record<string, string> = {
      difficulty,
      gamemode,
      pvp: String(pvp),
      "white-list": String(whitelist),
      "max-players": maxPlayers,
      motd,
      "server-port": port,
    };
    if (seed.trim()) properties["level-seed"] = seed.trim();
    const picked = isPack ? pack : null;
    const input = {
      path: path.trim(),
      name: name.trim(),
      // 모드팩은 검사 결과의 값을 그대로 보낸다 (파이프라인이 팩과 대조한다)
      loader: picked ? picked.result.summary.loader : loaderKind,
      mcVersion: picked ? picked.result.summary.mc : mc,
      loaderVersion: picked ? picked.result.summary.loaderVersion : kindInfo.hasVersions ? loader : "",
      memory: { minMb, maxMb },
      properties,
      ...(owner.trim() ? { ownerName: owner.trim() } : {}),
      ...(picked ? { modpack: picked.ref } : {}),
      eulaAccepted: eula,
    } as CreateServerInput;
    start.mutate(input, { onSuccess: (r) => onStarted(r.jobId, input, picked) });
  };

  const err = start.error as ApiRequestError | null;
  const packErr = !!err?.code?.startsWith("modpack_");

  return (
    <div className="space-y-5">
      <PageHeader icon={Hammer} title="새 서버 만들기" description="빈 폴더만 고르면 서버를 처음부터 만들어요. 받는 파일은 공식 배포처의 해시로 검증해요." />

      {options.recovered.length > 0 && (
        <Callout tone="info" title="지난번에 만들다 중단된 서버를 정리했어요">
          {options.recovered.map((r) => (
            <div key={r.at} className="font-mono text-[12px]">
              {r.target} · {r.cleaned.length}개 항목 삭제
            </div>
          ))}
        </Callout>
      )}

      {/* 폴더 */}
      <Card className="space-y-4">
        <SectionTitle>폴더</SectionTitle>
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <Field label="서버 이름">
            <Input
              id="new-name"
              value={name}
              maxLength={60}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </Field>
          <Field label="서버 폴더" hint="없는 폴더면 새로 만들고, 있는 폴더면 비어 있어야 해요. 직접 입력해도 돼요.">
            <div className="flex gap-2">
              <Input
                id="new-path"
                mono
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setPathTouched(true);
                }}
              />
              <Button icon={FolderSearch} onClick={() => setPicking(true)}>
                찾아보기
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      {/* 서버 종류 */}
      <Card className="space-y-4">
        <SectionTitle>서버 종류</SectionTitle>
        <LoaderPicker
          loaders={options.loaders}
          value={kind}
          onChange={(k) => {
            if (k === kind) return;
            // 모드팩에서 다른 종류로 돌아가면 팩이 바꾼 이름·메모리를 되돌린다
            if (kind === "modpack" && k !== "modpack") {
              const before = prePack.current;
              if (autoName.current && name === autoName.current) {
                setName(before?.name ?? "my-server");
                setNameTouched(before?.nameTouched ?? false);
                autoName.current = null;
              }
              if (pack || before) {
                setMinMb(before?.minMb ?? options.defaults.memory.minMb);
                setMaxMb(before?.maxMb ?? options.defaults.memory.maxMb);
              }
              prePack.current = null;
            }
            if (k === "modpack" && pack && kind !== "modpack") pickPack(pack.result, pack.ref);
            setKind(k);
            setLoader(k === "modpack" && pack ? pack.result.summary.loaderVersion : "");
            if (k === "modpack" && pack) setMc(pack.result.summary.mc);
          }}
        />
        <p className="text-[11px] text-slate-500">{LOADER_HINT[kind]}</p>
      </Card>

      {/* 모드팩 */}
      {isPack && (
        <Card className="space-y-4">
          <SectionTitle>모드팩</SectionTitle>
          <ModpackPicker value={pack?.result ?? null} packRef={pack?.ref ?? null} onChange={pickPack} maxUploadBytes={options.modpackUploadMaxBytes} />
          {memShort && !packBlocked && (
            <Callout tone="warning" title="메모리가 모자랄 수 있어요">
              이 팩은 최대 메모리 {gb(packIdealMb)} 를 권장하지만 {here}에서는 {gb(memOptions[memOptions.length - 1])} 까지만 고를 수 있어요. 모드가 많으면 느리거나 멈출 수 있어요.
            </Callout>
          )}
        </Card>
      )}

      {/* 버전 */}
      <Card className="space-y-4">
        <SectionTitle>버전</SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={isPack ? "Minecraft" : `Minecraft (정식 버전${kindInfo.minMc ? ` · ${kindInfo.minMc} 이상` : ""})`}>
            {isPack ? (
              <LockedValue id="new-mc" value={packSummary?.mc} />
            ) : rError ? (
              <span className="text-sm text-red-300">{(rError as Error).message}</span>
            ) : (
              <Select id="new-mc" value={mc} onChange={(e) => setMc(e.target.value)} disabled={rLoading || !releases?.length}>
                {rLoading && <option value="">불러오는 중…</option>}
                {releases?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {isPack ? (
            <Field label={packSummary ? kindInfo.versionLabel : "로더 버전"}>
              <LockedValue id="new-loader" value={packSummary ? displayLoaderVersion(packSummary.loader, packSummary.mc, packSummary.loaderVersion) : undefined} />
            </Field>
          ) : kindInfo.hasVersions && (
            <Field label={kindInfo.versionLabel}>
              <Select id="new-loader" value={loader} onChange={(e) => setLoader(e.target.value)} disabled={!vinfo || vinfo.loader !== kind}>
                {vinfo?.loader === kind &&
                  vinfo.loaders.map((l) => (
                    <option key={l.version} value={l.version}>
                      {displayLoaderVersion(kind, mc, l.version)}
                      {l.stable ? (l.version === vinfo.recommendedLoader ? " (추천)" : "") : l.version === vinfo.recommendedLoader ? " (베타 · 추천)" : " (베타)"}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
        </div>
        {isPack && (
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Lock className="h-3 w-3 shrink-0" /> {packSummary ? "모드팩이 정한 값이라 바꿀 수 없어요." : "모드팩을 고르면 정해져요."}
          </p>
        )}
        <div className="well flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
          {isPack && !packSummary ? (
            <span className="text-slate-500">모드팩을 고르면 필요한 Java 와 받을 파일을 알려 드려요.</span>
          ) : vLoading || (!isPack && rLoading) ? (
            <Spinner />
          ) : vError ? (
            <span className="text-red-300">{(vError as Error).message}</span>
          ) : vinfo ? (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <Lamp state={vinfo.java.source === "download" ? "off" : "on"} />
                <span className="break-keep">
                  <b className="font-block text-[12px] text-white">Java {vinfo.javaMajor}</b>{" "}
                  <span className="text-slate-400">
                    {vinfo.java.source === "system"
                      ? `${here}에 설치된 ${vinfo.java.version} 을 써요`
                      : vinfo.java.source === "cached"
                        ? `앱 폴더에 받아 둔 ${vinfo.java.version} 을 써요`
                        : `이 없어서 앱 폴더에 받아요${vinfo.java.downloadMb ? ` (약 ${vinfo.java.downloadMb}MB)` : ""} · 시스템에는 설치하지 않아요`}
                  </span>
                </span>
              </span>
              <span className="text-slate-500">
                {loaderKind === "forge" || loaderKind === "neoforge" ? "설치기" : "서버 파일"} {vinfo.downloadMb}MB
                {vinfo.downloadNote ? ` · ${vinfo.downloadNote}` : ""}
                {packSummary ? ` · 모드 ${fmtSize(packSummary.totalBytes)}` : ""}
              </span>
            </>
          ) : null}
        </div>
      </Card>

      {/* 기본 설정 */}
      <Card className="space-y-4">
        <SectionTitle>기본 설정</SectionTitle>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="난이도">
            <Select id="new-difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option value="peaceful">평화로움</option>
              <option value="easy">쉬움</option>
              <option value="normal">보통</option>
              <option value="hard">어려움</option>
            </Select>
          </Field>
          <Field label="게임모드">
            <Select id="new-gamemode" value={gamemode} onChange={(e) => setGamemode(e.target.value)}>
              <option value="survival">서바이벌</option>
              <option value="creative">크리에이티브</option>
              <option value="adventure">어드벤처</option>
            </Select>
          </Field>
          <Field label="최대 인원">
            <Input id="new-max" type="number" min={1} max={1000} value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} />
          </Field>
          <Field label="MOTD (서버 목록 문구)" className="md:col-span-2">
            <Input id="new-motd" value={motd} onChange={(e) => setMotd(e.target.value)} />
          </Field>
          <Field label="포트">
            <Input id="new-port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
          <Field label="시작 메모리" hint={`${here} 메모리 ${gb(options.totalMemMb)}`}>
            <Select id="new-min" value={minMb} onChange={(e) => setMinMb(Number(e.target.value))}>
              {memOptions.filter((m) => m <= maxMb).map((m) => (
                <option key={m} value={m}>
                  {gb(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="최대 메모리" hint={packSummary ? `모드팩에 맞춰 ${gb(snapMem(packSummary.suggestedMaxMb))} 로 정했어요` : undefined}>
            <Select id="new-maxmem" value={maxMb} onChange={(e) => { const v = Number(e.target.value); setMaxMb(v); if (minMb > v) setMinMb(v); }}>
              {memOptions.map((m) => (
                <option key={m} value={m}>
                  {gb(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="월드 시드 (비우면 무작위)">
            <Input id="new-seed" mono value={seed} onChange={(e) => setSeed(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="well flex items-center justify-between px-3 py-1.5 text-sm">
            <span>PvP 허용</span>
            <Toggle checked={pvp} onChange={setPvp} />
          </label>
          <label className="well flex items-center justify-between px-3 py-1.5 text-sm">
            <span>화이트리스트 사용 (등록한 사람만 접속)</span>
            <Toggle checked={whitelist} onChange={setWhitelist} />
          </label>
        </div>
      </Card>

      {/* 닉네임 */}
      <Card className="space-y-3">
        <SectionTitle>내 닉네임 (선택)</SectionTitle>
        <Field hint="입력하면 이 계정을 OP(관리자)와 화이트리스트에 바로 추가해요. 비워 두고 나중에 플레이어 화면에서 추가해도 돼요.">
          <Input id="new-owner" className="max-w-xs" placeholder="Steve" value={owner} onChange={(e) => setOwner(e.target.value)} pattern="[A-Za-z0-9_]{1,16}" />
        </Field>
      </Card>

      {/* EULA */}
      <Card className="space-y-3">
        <SectionTitle>Minecraft EULA</SectionTitle>
        <p className="text-sm text-slate-400">
          Minecraft 서버를 실행하려면 Mojang 의 최종 사용자 라이선스 계약(EULA)에 동의해야 해요. BlockPilot 은 대신 동의하지 않아요.{" "}
          <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-red-300 underline underline-offset-2">
            EULA 읽기 <ExternalLink className="h-3 w-3" />
          </a>
        </p>
        <label htmlFor="new-eula" className={cx("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm", eula ? "slab" : "well")}>
          <input id="new-eula" type="checkbox" className="peer sr-only" checked={eula} onChange={(e) => setEula(e.target.checked)} />
          <span className={cx("grid h-5 w-5 shrink-0 place-items-center shadow-well peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-redstone", eula ? "bg-redstone" : "bg-[#0d0d0f]")} aria-hidden>
            {eula && <span className="h-2 w-2 bg-white" />}
          </span>
          <span className={eula ? "text-white" : "text-slate-300"}>Minecraft EULA 를 읽었고 동의합니다.</span>
        </label>
      </Card>

      <OsNotice />

      {err && (
        <Callout tone="danger" title={err.message}>
          {err.hint}
          {err.detail && <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-slate-400">{err.detail}</pre>}
          {packErr && pack && (
            <Button className="mt-3" icon={PackageOpen} onClick={() => pickPack(null, null)}>
              모드팩 다시 고르기
            </Button>
          )}
        </Callout>
      )}

      <div className="flex items-center justify-between gap-4">
        <span className="break-keep text-sm text-slate-500">{packBlocked ? "이 팩은 만들 수 없어요. 다른 팩을 골라 주세요." : isPack && !packSummary ? "모드팩을 골라 주세요." : !eula ? "EULA 에 동의해야 만들 수 있어요." : "준비됐어요."}</span>
        <Button variant="primary" size="lg" icon={Hammer} disabled={!ready} loading={start.isPending} onClick={submit}>
          서버 만들기
        </Button>
      </div>

      {picking && (
        <FolderPicker
          initialPath={path.trim() || options.defaults.parentDir}
          folderName={folder}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setPath(p);
            setPathTouched(true);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** 모드팩이 정한 값: 고를 수 없으니 셀렉트 대신 자물쇠와 함께 값만 보여 준다 */
function LockedValue({ id, value }: { id: string; value?: string }) {
  return (
    <div id={id} data-value={value ?? ""} className="well flex h-9 min-w-0 items-center gap-2 px-3 text-sm" aria-readonly>
      <Lock className="h-3.5 w-3.5 shrink-0 text-slate-500" />
      <span className={cx("min-w-0 truncate", value ? "font-mono text-[13px] text-slate-100" : "text-slate-500")}>{value ?? "모드팩을 고르면 정해져요"}</span>
    </div>
  );
}

/**
 * 서버 종류 고르기. 넓은 화면에선 인벤토리 칸처럼 다섯 칸을 늘어놓고, 좁은 화면에선 목록 줄로.
 * 고른 칸은 볼록(slab) + 램프 켜짐, 나머지는 오목(well). 알림·자동화 패널의 토글 버튼과 같은 aria-pressed 방식.
 */
function LoaderPicker({ loaders, value, onChange }: { loaders: CreateLoaderInfo[]; value: Kind; onChange: (k: Kind) => void }) {
  const tiles: { id: Kind; label: string; summary: string }[] = [...loaders, { id: "modpack", ...MODPACK_TILE }];
  return (
    <div role="group" aria-label="서버 종류" className="grid grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-3 lg:grid-cols-6">
      {tiles.map((l) => {
        const active = l.id === value;
        return (
          <button
            key={l.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(l.id)}
            className={cx(
              "group flex min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors focus-ring md:min-h-[5.5rem] md:flex-col md:items-start md:gap-1.5 md:py-2.5",
              active ? "slab" : "well hover:bg-ink-2",
            )}
          >
            <span className="flex shrink-0 items-center gap-2">
              <Lamp state={active ? "on" : "off"} size={10} />
              <span className={cx("font-block text-[12px]", active ? "text-white" : "text-slate-300 group-hover:text-white")}>{l.label}</span>
            </span>
            <span className={cx("min-w-0 flex-1 truncate break-keep text-[12px] leading-snug md:whitespace-normal", active ? "text-slate-300" : "text-slate-500")}>{l.summary}</span>
          </button>
        );
      })}
    </div>
  );
}

/** OS 마다 처음 만들 때 알아 두면 좋은 것 */
function OsNotice() {
  const { data: sys } = useSystem();
  if (sys?.os === "windows") {
    return (
      <Callout tone="warning" title="Windows 방화벽">
        최초 실행 때 "Windows 보안 경고" 창이 뜨면 <b className="text-slate-200">액세스 허용</b>을 눌러 주세요. 허용해야 친구들이 접속할 수 있어요.
      </Callout>
    );
  }
  if (sys?.os === "linux") {
    return (
      <Callout tone="info" title="Linux 서버라면">
        방화벽(ufw)을 쓰고 있으면 <code className="font-mono">sudo ufw allow 25565/tcp</code> 처럼 서버 포트를 열어 주세요. 화면 없는 원격 서버(VPS)라면 BlockPilot 을{" "}
        <code className="font-mono">BLOCKPILOT_HOST=0.0.0.0 npm start</code> 로 켜고, 터미널에 나온 접속 토큰으로 다른 PC 브라우저에서 들어오면 돼요.
      </Callout>
    );
  }
  return null;
}

// ---------- 진행 화면 ----------

function Progress({ jobId, onRetry }: { jobId: string; onRetry: (clearPack?: boolean) => void }) {
  const { data: job, error } = useCreateJob(jobId);
  const cancel = useCancelCreate();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const toast = useToast();
  const celebrated = useRef(false);
  useEffect(() => {
    if (job?.state === "succeeded" && !celebrated.current) {
      celebrated.current = true;
      toast("ok", `새 서버를 만들었어요 · ${job.input.name}`, { icon: "grass", first: "create" });
    }
  }, [job?.state, job?.input.name, toast]);

  useEffect(() => {
    if (job?.state === "succeeded") qc.invalidateQueries({ queryKey: keys.servers });
    if (job && job.state !== "running") qc.invalidateQueries({ queryKey: ["create", "options"] });
  }, [job?.state, qc, job]);

  if (error) {
    return (
      <Callout tone="warning" title={(error as Error).message}>
        <Button className="mt-3" onClick={() => onRetry()}>
          새로 만들기
        </Button>
      </Callout>
    );
  }
  if (!job) return <Spinner />;
  const mp = job.input.modpack;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Hammer}
        title={job.state === "running" ? "서버를 만드는 중" : job.state === "succeeded" ? "서버를 만들었어요" : job.state === "cancelled" ? "만들기를 취소했어요" : "서버를 만들지 못했어요"}
        description={
          <span className="block min-w-0 font-mono text-[12px]">
            <span className="block break-keep">
              {mp ? (mp.name === job.input.name ? `모드팩 ${mp.name} ${mp.versionId}` : `${job.input.name} · 모드팩 ${mp.name} ${mp.versionId}`) : job.input.name} · Minecraft {job.input.mcVersion} · {CREATE_LOADER_LABEL[job.input.loader]}
              {job.input.loaderVersion ? ` ${displayLoaderVersion(job.input.loader, job.input.mcVersion, job.input.loaderVersion)}` : ""}
            </span>
            <span className="block truncate text-slate-500" title={job.input.path}>
              {job.input.path}
            </span>
          </span>
        }
        actions={
          job.state === "running" && <ConfirmButton icon={X} label="취소" confirmLabel="정말 취소? 만든 파일은 지워져요" onConfirm={() => cancel.mutate(job.id)} />
        }
      />

      <Card>
        <CreateXp job={job} />
      </Card>

      <Card padded={false} className="divide-y-2 divide-bevel-lo">
        {job.steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </Card>

      {job.state === "succeeded" && job.serverId && (
        <Callout tone="lamp" title="준비 끝! 서버 목록에 등록했어요">
          최초 실행으로 월드까지 만들어 두었어요. 대시보드에서 레버를 당기면 서버가 켜져요.
          {mp && (
            <p className="mt-2">
              친구들도 이 팩의 <b className="text-slate-100">같은 버전({mp.name} {mp.versionId})</b> 을 Modrinth App·Prism 에 설치해야 접속할 수 있어요. 모드 화면에서 친구용 .mrpack 과 안내문도 받을 수 있어요.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" icon={LayoutDashboard} onClick={() => navigate(`/s/${job.serverId}`)}>
              대시보드 열기
            </Button>
            <Button onClick={() => navigate("/")}>서버 목록</Button>
          </div>
        </Callout>
      )}

      {(job.state === "failed" || job.state === "cancelled") && <FailurePanel job={job} onRetry={onRetry} />}

      <Card padded={false} className="overflow-hidden">
        <div className="px-4 py-3">
          <SectionTitle right={<span className="font-block text-[12px] text-slate-600 tnum">{job.log.length}줄</span>}>진행 기록</SectionTitle>
        </div>
        <pre className="well terminal mx-3 mb-3 max-h-72 overflow-auto whitespace-pre-wrap break-all px-4 py-3 text-slate-300">{job.log.slice(-40).join("\n") || "…"}</pre>
      </Card>
    </div>
  );
}

/** 경험치 바: 끝낸 단계 수 = 레벨, 지금 단계의 내려받기 진행률까지 더한 전체 진행률 = 바 */
function CreateXp({ job }: { job: CreateJobStatus }) {
  const total = job.steps.length;
  const finished = job.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const current = job.steps.find((s) => s.state === "running" || s.state === "failed");
  const frac = current?.progress?.total ? Math.min(1, current.progress.done / current.progress.total) : 0;
  const value = job.state === "succeeded" ? 1 : (finished + (current?.state === "running" ? frac : 0)) / total;
  const caption =
    job.state === "succeeded" ? "완료! 대시보드에서 서버를 켤 수 있어요"
    : job.state === "running" ? (current?.label ?? "준비 중")
    : job.state === "cancelled" ? "취소했어요"
    : `${current?.label ?? "만들기"} 에서 멈췄어요`;
  return <XpBar level={finished} value={value} caption={caption} right={`${finished} / ${total} 단계`} tone={job.state === "failed" || job.state === "cancelled" ? "failed" : job.state === "succeeded" ? "done" : "active"} />;
}

function StepRow({ step: s }: { step: CreateStep }) {
  const pct = s.progress?.total ? Math.min(100, Math.round((s.progress.done / s.progress.total) * 100)) : null;
  return (
    <div className={cx("flex items-start gap-4 px-5 py-3.5", s.state === "running" && "bg-redstone/[.05]")}>
      <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center">
        {s.state === "failed" ? <TntIcon className="h-5 w-5" primed /> : <Lamp state={s.state === "done" ? "on" : s.state === "running" ? "blink" : "off"} size={14} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cx("font-block text-[12px]", s.state === "pending" ? "text-slate-500" : "text-white")}>{s.label}</span>
          {s.state === "skipped" && <Badge>건너뜀</Badge>}
        </div>
        {s.note && <p className="mt-0.5 break-all text-sm text-slate-400">{s.note}</p>}
        {s.state === "running" && pct !== null && (
          <div className="mt-2 flex items-center gap-3">
            <div className="well h-3 flex-1 p-[2px]">
              <div className="h-full bg-redstone shadow-[0_0_6px_rgba(255,59,47,.6)] transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <span className="font-block text-[12px] text-slate-400 tnum">
              {(s.progress!.done / 1048576).toFixed(1)} / {(s.progress!.total! / 1048576).toFixed(1)} MB
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function FailurePanel({ job, onRetry }: { job: CreateJobStatus; onRetry: (clearPack?: boolean) => void }) {
  const e = job.error;
  // 팩 자체가 문제면 같은 팩으로 다시 해도 소용없으니 팩을 비우고 다시 고르게 한다
  const packErr = !!e?.code.startsWith("modpack_");
  return (
    <Callout tone={job.state === "cancelled" ? "warning" : "danger"} title={e?.message ?? "알 수 없는 오류"}>
      {e?.hint && <p>{e.hint}</p>}
      {e?.detail && (
        <details className="mt-2" open={e.code === "modpack_blocked_host"}>
          <summary className="cursor-pointer font-block text-[12px] text-slate-400">{e.code === "modpack_blocked_host" ? "허용되지 않은 주소" : "상세 내용"}</summary>
          <pre className="well mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] text-slate-300">{e.detail}</pre>
        </details>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer font-block text-[12px] text-slate-400">정리한 항목 {job.cleaned?.length ?? 0}개 — 이번에 만든 것만 지웠어요</summary>
        <ul className="mt-1 font-mono text-[11px] text-slate-400">
          {(job.cleaned ?? []).map((c) => (
            <li key={c}>{c}</li>
          ))}
          {!job.cleaned?.length && <li>지울 것이 없었어요.</li>}
        </ul>
      </details>
      {job.kept?.map((k) => (
        <p key={k} className="mt-2 text-amber-300">
          {k}
        </p>
      ))}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" icon={packErr ? PackageOpen : RotateCcw} onClick={() => onRetry(packErr)}>
          {packErr ? "모드팩 다시 고르기" : "설정 고쳐서 다시 시도"}
        </Button>
        <Link to="/" className="inline-flex">
          <Button>서버 목록</Button>
        </Link>
      </div>
    </Callout>
  );
}
