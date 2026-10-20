import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FolderOpen, Plus, Server, Trash2 } from "lucide-react";
import { useRegisterServer, useRemoveServer, useServers } from "../api/hooks";
import { Logo } from "../App";
import { Button, Card, ConfirmButton, EmptyState, Field, Input, Spinner, useToast } from "../lib/ui";

export default function ServerSelect() {
  const { data: servers, isLoading } = useServers();
  const register = useRegisterServer();
  const remove = useRemoveServer();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate(
      { path: path.trim(), name: name.trim() || undefined },
      {
        onSuccess: (s) => {
          toast("ok", `'${s.name}' 서버를 등록했습니다.`);
          setPath("");
          setName("");
        },
        onError: (err) => toast("err", (err as Error).message),
      },
    );
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 animate-slide-up">
      <header className="mb-10 text-center">
        <Logo className="text-3xl" />
        <p className="mx-auto mt-4 max-w-lg text-balance text-slate-400">마인크래프트 서버 폴더를 등록하면 설정 · 모드 · 플레이어 · 콘솔 · 백업을 한 곳에서 관리할 수 있어요.</p>
      </header>

      <Card className="mb-8">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
          <Plus className="h-4 w-4 text-brand-400" /> 서버 폴더 추가
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
        <h2 className="mb-3 text-sm font-semibold text-slate-300">등록된 서버</h2>
        {isLoading ? (
          <Spinner />
        ) : !servers?.length ? (
          <EmptyState icon={Server} title="등록된 서버가 없어요">
            위에서 서버 폴더 경로를 추가하면 여기에 나타납니다.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {servers.map((s, i) => (
              <li key={s.id} className="surface group flex items-center gap-4 p-4 transition hover:border-line-strong animate-slide-up" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ink-3 text-brand-400">
                  <Server className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <Link to={`/s/${s.id}`} className="font-medium text-white hover:text-brand-300">
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
                <Link to={`/s/${s.id}`} className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-3 px-3.5 text-sm font-medium text-white transition group-hover:bg-brand-600">
                  열기 <ArrowRight className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
