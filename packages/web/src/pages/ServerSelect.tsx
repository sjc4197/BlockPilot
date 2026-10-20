import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useRegisterServer, useRemoveServer, useServers } from "../api/hooks";
import { btn, card, input, useToast, ConfirmButton, EmptyState, cx } from "../lib/ui";

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
    <div className="mx-auto max-w-3xl px-6 py-14">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">
          Block<span className="text-emerald-400">Pilot</span>
        </h1>
        <p className="mt-2 text-slate-400">마인크래프트 서버 폴더를 등록하고 설정·모드·플레이어를 GUI로 관리하세요.</p>
      </header>

      <section className={cx(card, "mb-8")}>
        <h2 className="mb-3 font-semibold">서버 폴더 추가</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-400">서버 폴더 경로 (server.properties가 있는 폴더)</label>
            <input className={input} placeholder="/Users/you/Minecraft/servers/my-server" value={path} onChange={(e) => setPath(e.target.value)} required />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">표시 이름 (선택)</label>
            <input className={input} placeholder="친구 서버" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className={cx(btn.base, btn.primary)} disabled={register.isPending}>
            {register.isPending ? "확인 중..." : "등록"}
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 font-semibold">등록된 서버</h2>
        {isLoading ? (
          <div className="text-slate-400 text-sm">불러오는 중...</div>
        ) : !servers?.length ? (
          <EmptyState>등록된 서버가 없습니다. 위에서 서버 폴더 경로를 추가하세요.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {servers.map((s) => (
              <li key={s.id} className={cx(card, "flex items-center justify-between gap-4 py-4")}>
                <div className="min-w-0">
                  <Link to={`/s/${s.id}`} className="font-medium hover:text-emerald-400">
                    {s.name}
                  </Link>
                  <div className="truncate text-xs text-slate-500" title={s.path}>
                    {s.path}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link to={`/s/${s.id}`} className={cx(btn.base, btn.primary)}>
                    열기
                  </Link>
                  <ConfirmButton
                    label="등록 해제"
                    confirmLabel="해제할까요?"
                    className={btn.ghost}
                    onConfirm={() =>
                      remove.mutate(s.id, {
                        onSuccess: () => toast("info", "등록을 해제했습니다. 서버 파일은 그대로 남아 있습니다."),
                        onError: (err) => toast("err", (err as Error).message),
                      })
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
