import { useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, FolderOpen, Hammer, Plus, Power, Server, Trash2 } from "lucide-react";
import { useAutostart, useCreateOptions, useRegisterServer, useRemoveServer, useServers, useSetAutostart, useSystem, useUpdateCheck } from "../api/hooks";
import { Logo } from "../App";
import { Badge, Button, Callout, Card, ConfirmButton, EmptyState, Field, Input, Spinner, Toggle, cx, useToast } from "../lib/ui";
import { usePlayOnce } from "../lib/fx";

export default function ServerSelect() {
  const { data: servers, isLoading } = useServers();
  const register = useRegisterServer();
  const remove = useRemoveServer();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: createOpts } = useCreateOptions();
  const { data: sys } = useSystem();
  const update = useUpdateCheck();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const place = usePlayOnce("server-list");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate(
      { path: path.trim(), name: name.trim() || undefined },
      {
        onSuccess: (s) => {
          toast("ok", `'${s.name}' 서버를 등록했습니다.`, { icon: "grass", first: "register" });
          setPath("");
          setName("");
        },
        onError: (err) => toast("err", (err as Error).message),
      },
    );
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 animate-slide-up sm:px-6 sm:py-16">
      <header className="mb-10 text-center">
        <div className="origin-top scale-[0.8] sm:scale-100">
          <Logo size="lg" />
        </div>
        <p className="mx-auto mt-4 max-w-lg text-balance text-slate-400">마인크래프트 서버 폴더를 등록하면 설정 · 모드 · 플레이어 · 콘솔 · 백업을 한 곳에서 관리할 수 있어요.</p>
      </header>

      <Card className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-block text-[12px] text-slate-200">
            <Hammer className="h-4 w-4 text-redstone" /> 새 서버 만들기
            {createOpts && !createOpts.supported && <Badge tone="warning">이 OS 는 준비 중</Badge>}
          </h2>
          <p className="mt-1.5 text-sm text-slate-400">빈 폴더만 고르면 Fabric · Paper · Forge · NeoForge · 순정 서버를 처음부터 만들어요. Java 가 없으면 앱 폴더에 받아서 써요.</p>
        </div>
        <Button variant="primary" icon={Hammer} disabled={!createOpts?.supported} onClick={() => navigate("/new")} title={createOpts?.unsupportedMessage}>
          새 서버 만들기
        </Button>
      </Card>

      <Card className="mb-8">
        <h2 className="mb-4 flex items-center gap-2 font-block text-[12px] text-slate-200">
          <Plus className="h-4 w-4 text-redstone" /> 이미 있는 서버 폴더 추가
        </h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_200px_auto] md:items-end">
            <Field label="서버 폴더 경로">
              <div className="relative">
                <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input className="pl-9" mono placeholder="/Users/me/minecraft/servers/survival" value={path} onChange={(e) => setPath(e.target.value)} required />
              </div>
            </Field>
            <Field label="표시 이름 (선택)">
              <Input placeholder="친구 서버" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button variant="primary" type="submit" loading={register.isPending}>
              등록
            </Button>
          </div>
          <p className="text-[11px] text-slate-500">server.properties 와 eula.txt 가 있는 폴더의 절대 경로를 입력하세요.</p>
        </form>
      </Card>

      <section>
        <h2 className="mb-3 font-block text-[12px] text-slate-200">등록된 서버</h2>
        {isLoading ? (
          <Spinner />
        ) : !servers?.length ? (
          <EmptyState icon={Server} title="등록된 서버가 없어요">
            위에서 서버 폴더 경로를 추가하면 여기에 나타납니다.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {servers.map((s, i) => (
              <li key={s.id} className={cx("slab group relative flex flex-wrap items-center gap-x-4 gap-y-3 p-4", place && "place-in")} style={{ "--k": i } as CSSProperties}>
                <div className="well grid h-11 w-11 shrink-0 place-items-center text-redstone">
                  <Server className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1 basis-[calc(100%-4.5rem)] sm:basis-0">
                  <Link to={`/s/${s.id}`} className="font-medium text-white hover:text-red-300">
                    {s.name}
                  </Link>
                  <div className="truncate font-mono text-[12px] text-slate-500" title={s.path}>
                    {s.path}
                  </div>
                </div>
                <ConfirmButton
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  label="등록 해제"
                  confirmLabel="해제할까요?"
                  onConfirm={() =>
                    remove.mutate(s.id, {
                      onSuccess: () => toast("info", "등록을 해제했습니다. 서버 파일은 그대로 남아 있어요."),
                      onError: (err) => toast("err", (err as Error).message),
                    })
                  }
                />
                <Link to={`/s/${s.id}`} className="focus-ring inline-flex h-9 items-center gap-1.5 bg-[#c42a20] px-3.5 font-block text-[12px] text-white shadow-[inset_2px_2px_0_#ff6b5f,inset_-2px_-2px_0_#5a1712] [text-shadow:1px_1px_0_#5a1712] hover:bg-[#d93a2b]">
                  열기 <ArrowRight className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AutostartCard />

      {sys && (
        <footer className="mt-10 flex flex-wrap items-center justify-center gap-2 text-[12px] text-slate-500">
          <span className="font-block">이 컴퓨터</span>
          <span className="text-slate-300">
            {sys.osLabel} · {sys.archLabel}
          </span>
          {sys.support.manage === "wip" && <Badge tone="warning">이 OS 지원은 준비 중이라 일부 기능이 다르게 동작할 수 있어요</Badge>}
          <span className="text-slate-600">·</span>
          <span className="font-block">BlockPilot</span>
          <span className="text-slate-300 tnum">v{sys.version}</span>
          {update.data ? (
            update.data.newer ? (
              <a href={update.data.url} target="_blank" rel="noreferrer" className="focus-ring">
                <Badge tone="lamp">v{update.data.latest} 이 나왔어요 · 받으러 가기</Badge>
              </a>
            ) : (
              <span className="text-slate-400">{update.data.note ?? "최신 버전이에요"}</span>
            )
          ) : (
            <Button size="sm" variant="ghost" loading={update.isPending} onClick={() => update.mutate(undefined, { onError: (e) => toast("err", (e as Error).message) })} title="누를 때만 GitHub 에 최신 버전을 물어봐요">
              업데이트 확인
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}

/** 로그인 때 BlockPilot 자동 실행. 릴리스 실행 파일로 켰을 때만 토글을 쓸 수 있다 */
function AutostartCard() {
  const { data: info } = useAutostart();
  const set = useSetAutostart();
  const toast = useToast();
  if (!info) return null;
  const onChange = (v: boolean) =>
    set.mutate(v, {
      onSuccess: (r) => toast(v ? "ok" : "info", v ? "이제 로그인하면 BlockPilot 이 저절로 켜져요." : `로그인 자동 실행을 껐어요. 다음 로그인부터 켜지지 않아요.${r.autostarted ? " 지금 켜진 BlockPilot 은 그대로예요." : ""}`, v ? { icon: "lever" } : undefined),
      onError: (e) => toast("err", (e as Error).message),
    });
  const mono = (p?: string) => <span className="break-all font-mono text-[12px]">{p}</span>;
  return (
    <Card className="mt-8 space-y-3">
      {/* label 에는 제목만 — 스크린리더가 스위치 이름으로 설명문까지 읽지 않게. 글자를 눌러도 레버가 움직인다 */}
      <label className={cx("flex items-center justify-between gap-4", info.supported && "cursor-pointer")}>
        <span className={cx("flex items-center gap-2 font-block text-[12px]", info.supported ? "text-slate-200" : "text-slate-400")}>
          <Power className="h-4 w-4 text-redstone" /> 로그인하면 BlockPilot 자동으로 켜기
        </span>
        <Toggle checked={info.enabled} onChange={onChange} disabled={!info.supported || set.isPending} />
      </label>
      <p className="text-[11px] text-slate-500">{info.supported ? (info.enabled && info.hint ? `${info.methodLabel} · ${info.hint}` : info.methodLabel) : info.reason}</p>
      {info.enabled && info.exeMissing && (
        <Callout tone="warning">등록된 실행 파일 {mono(info.registeredExe)} 이(가) 없어요. 옮겼거나 지웠다면 토글을 껐다 켜서 지금 위치로 다시 등록하세요.</Callout>
      )}
      {info.enabled && !info.exeMissing && info.stale && (
        <Callout tone="warning">다른 위치의 실행 파일 {mono(info.registeredExe)} 로 등록돼 있어요. 토글을 껐다 켜면 지금 실행 중인 파일로 바꿔요.</Callout>
      )}
      {info.enabled && info.exePath && !info.stale && !info.exeMissing && (
        <p className="truncate font-mono text-[12px] text-slate-500" title={info.exePath}>
          {info.exePath}
        </p>
      )}
    </Card>
  );
}
