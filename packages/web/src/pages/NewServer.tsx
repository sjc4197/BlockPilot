import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FolderSearch, Hammer, LayoutDashboard, RotateCcw, X } from "lucide-react";
import type { CreateJobStatus, CreateServerInput, CreateStep } from "@blockpilot/shared";
import { useCancelCreate, useCreateJob, useCreateOptions, useStartCreate, useSystem, useVersionInfo, keys } from "../api/hooks";
import { ApiRequestError } from "../api/client";
import { FolderPicker } from "../components/FolderPicker";
import { Lamp, TntIcon } from "../lib/pixel";
import { Badge, Button, Callout, Card, ConfirmButton, Field, Input, PageHeader, SectionTitle, Select, Spinner, Toggle, cx } from "../lib/ui";

const MEMORY_STEPS_MB = [1024, 1536, 2048, 3072, 4096, 5120, 6144, 8192, 10240, 12288, 16384];
const gb = (mb: number) => `${mb / 1024}GB`;

/** 서버 이름 → 폴더 이름 */
function folderNameOf(name: string) {
  const s = name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9가-힣_.-]/g, "");
  return s || "my-server";
}

export default function NewServer() {
  const { data: options, isLoading } = useCreateOptions();
  const [jobId, setJobId] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<CreateServerInput | null>(null);

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
        <Progress jobId={jobId} onRetry={() => setJobId(null)} />
      ) : (
        <CreateForm options={options} initial={lastInput} onStarted={(id, input) => { setLastInput(input); setJobId(id); }} />
      )}
    </div>
  );
}

// ---------- 입력 폼 ----------

function CreateForm({ options, initial, onStarted }: { options: NonNullable<ReturnType<typeof useCreateOptions>["data"]>; initial: CreateServerInput | null; onStarted: (jobId: string, input: CreateServerInput) => void }) {
  const p = initial?.properties ?? {};
  const [name, setName] = useState(initial?.name ?? "my-server");
  const [path, setPath] = useState(initial?.path ?? "");
  const [pathTouched, setPathTouched] = useState(!!initial);
  const [picking, setPicking] = useState(false);
  const [mc, setMc] = useState(initial?.mcVersion ?? options.releases[0]?.id ?? "");
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
  const { data: vinfo, isFetching: vLoading, error: vError } = useVersionInfo(mc);
  const folder = folderNameOf(name);

  useEffect(() => {
    if (!pathTouched) setPath(`${options.defaults.parentDir}/${folder}`);
  }, [folder, pathTouched, options.defaults.parentDir]);
  useEffect(() => {
    if (vinfo && !vinfo.loaders.some((l) => l.version === loader)) setLoader(vinfo.recommendedLoader ?? "");
  }, [vinfo, loader]);

  const memOptions = useMemo(() => MEMORY_STEPS_MB.filter((m) => m <= options.totalMemMb * 0.75), [options.totalMemMb]);
  const ready = eula && name.trim() && path.trim() && mc && loader && !vLoading && !start.isPending;

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
    const input = {
      path: path.trim(),
      name: name.trim(),
      mcVersion: mc,
      loaderVersion: loader,
      memory: { minMb, maxMb },
      properties,
      ...(owner.trim() ? { ownerName: owner.trim() } : {}),
      eulaAccepted: eula,
    } as CreateServerInput;
    start.mutate(input, { onSuccess: (r) => onStarted(r.jobId, input) });
  };

  const err = start.error as ApiRequestError | null;

  return (
    <div className="space-y-5">
      <PageHeader icon={Hammer} title="새 서버 만들기" description="빈 폴더만 고르면 Fabric 서버를 처음부터 만들어요. 받는 파일은 모두 공식 배포처의 해시로 검증해요." />

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
            <Input id="new-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
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

      {/* 버전 */}
      <Card className="space-y-4">
        <SectionTitle>버전</SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Minecraft (정식 버전)">
            <Select id="new-mc" value={mc} onChange={(e) => setMc(e.target.value)}>
              {options.releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fabric 로더">
            <Select id="new-loader" value={loader} onChange={(e) => setLoader(e.target.value)} disabled={!vinfo}>
              {vinfo?.loaders.map((l) => (
                <option key={l.version} value={l.version}>
                  {l.version}
                  {l.stable ? (l.version === vinfo.recommendedLoader ? " (추천)" : "") : " (베타)"}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="well flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
          {vLoading ? (
            <Spinner />
          ) : vError ? (
            <span className="text-red-300">{(vError as Error).message}</span>
          ) : vinfo ? (
            <>
              <span className="flex items-center gap-2">
                <Lamp state={vinfo.java.source === "download" ? "off" : "on"} />
                <span>
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
              <span className="text-slate-500">서버 파일 {vinfo.serverJarMb}MB</span>
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
          <Field label="최대 메모리">
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

      {err && (
        <Callout tone="danger" title={err.message}>
          {err.hint}
          {err.detail && <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-slate-400">{err.detail}</pre>}
        </Callout>
      )}

      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-slate-500">{eula ? "준비됐어요." : "EULA 에 동의해야 만들 수 있어요."}</span>
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

// ---------- 진행 화면 ----------

function Progress({ jobId, onRetry }: { jobId: string; onRetry: () => void }) {
  const { data: job, error } = useCreateJob(jobId);
  const cancel = useCancelCreate();
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (job?.state === "succeeded") qc.invalidateQueries({ queryKey: keys.servers });
    if (job && job.state !== "running") qc.invalidateQueries({ queryKey: ["create", "options"] });
  }, [job?.state, qc, job]);

  if (error) {
    return (
      <Callout tone="warning" title={(error as Error).message}>
        <Button className="mt-3" onClick={onRetry}>
          새로 만들기
        </Button>
      </Callout>
    );
  }
  if (!job) return <Spinner />;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Hammer}
        title={job.state === "running" ? "서버를 만드는 중" : job.state === "succeeded" ? "서버를 만들었어요" : job.state === "cancelled" ? "만들기를 취소했어요" : "서버를 만들지 못했어요"}
        description={
          <span className="font-mono text-[12px]">
            {job.input.name} · Minecraft {job.input.mcVersion} · Fabric {job.input.loaderVersion} · {job.input.path}
          </span>
        }
        actions={
          job.state === "running" && <ConfirmButton icon={X} label="취소" confirmLabel="정말 취소? 만든 파일은 지워져요" onConfirm={() => cancel.mutate(job.id)} />
        }
      />

      <Card padded={false} className="divide-y-2 divide-bevel-lo">
        {job.steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </Card>

      {job.state === "succeeded" && job.serverId && (
        <Callout tone="lamp" title="준비 끝! 서버 목록에 등록했어요">
          최초 실행으로 월드까지 만들어 두었어요. 대시보드에서 레버를 당기면 서버가 켜져요.
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

function FailurePanel({ job, onRetry }: { job: CreateJobStatus; onRetry: () => void }) {
  const e = job.error;
  return (
    <Callout tone={job.state === "cancelled" ? "warning" : "danger"} title={e?.message ?? "알 수 없는 오류"}>
      {e?.hint && <p>{e.hint}</p>}
      {e?.detail && (
        <details className="mt-2">
          <summary className="cursor-pointer font-block text-[12px] text-slate-400">상세 내용</summary>
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
        <Button variant="primary" icon={RotateCcw} onClick={onRetry}>
          설정 고쳐서 다시 시도
        </Button>
        <Link to="/" className="inline-flex">
          <Button>서버 목록</Button>
        </Link>
      </div>
    </Callout>
  );
}
