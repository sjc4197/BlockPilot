import { useEffect, useState } from "react";
import { ArrowUp, Folder, FolderOpen, HardDrive, Home, Server, X } from "lucide-react";
import { useFsList } from "../api/hooks";
import { Badge, Button, Callout, Spinner, cx } from "../lib/ui";

/**
 * 서버를 만들 폴더 고르기. 폴더를 눌러 들어가고, 현재 폴더를 고른다.
 * - 현재 폴더가 비어 있으면 그 폴더에 바로 만든다
 * - 비어 있지 않으면 그 안에 서버 이름으로 새 폴더를 만든다
 */
export function FolderPicker({ initialPath, folderName, onPick, onClose }: { initialPath: string; folderName: string; onPick: (path: string) => void; onClose: () => void }) {
  // 처음엔 입력된 경로(아직 없을 수 있음)의 가장 가까운 상위 폴더로 연다. 그 뒤로는 고른 폴더 그대로
  const [nav, setNav] = useState<{ path: string; nearest: boolean }>({ path: initialPath, nearest: true });
  const setCurrent = (p: string) => setNav({ path: p, nearest: false });
  const { data, error, isFetching } = useFsList(nav.path, nav.nearest);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sep = data?.path.includes("\\") ? "\\" : "/";
  const newChild = data ? `${data.path.replace(/[\\/]+$/, "")}${sep}${folderName}` : "";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal aria-label="폴더 찾기" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass flex h-[min(620px,88vh)] w-[min(880px,96vw)] flex-col">
        <header className="flex items-center justify-between px-5 py-3 shadow-[inset_0_-2px_0_#08080a]">
          <h2 className="flex items-center gap-2 font-block text-[12px] text-white">
            <FolderOpen className="h-4 w-4 text-redstone" /> 서버를 만들 폴더 찾기
          </h2>
          <Button size="sm" variant="ghost" icon={X} onClick={onClose} aria-label="닫기" />
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-48 shrink-0 space-y-1 overflow-y-auto p-3 shadow-[inset_-2px_0_0_#08080a]">
            {data?.shortcuts.map((s) => {
              const Icon = s.kind === "home" ? Home : s.kind === "drive" ? HardDrive : Folder;
              return (
                <button key={s.path} onClick={() => setCurrent(s.path)} className={cx("flex w-full items-center gap-2 px-2.5 py-2 text-left font-block text-[12px] transition-colors focus-ring", data.path === s.path ? "slab text-white" : "text-slate-400 hover:bg-ink-3 hover:text-slate-200")}>
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{s.label}</span>
                </button>
              );
            })}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 px-4 py-2.5">
              <Button size="sm" icon={ArrowUp} disabled={!data?.parent} onClick={() => data?.parent && setCurrent(data.parent)}>
                상위 폴더
              </Button>
              <div className="well flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2 py-1 font-mono text-[12px] text-slate-400">
                {data?.crumbs.map((c, i) => (
                  <span key={c.path} className="flex shrink-0 items-center gap-0.5">
                    <button className={cx("hover:text-white", i === data.crumbs.length - 1 && "text-slate-100")} onClick={() => setCurrent(c.path)}>
                      {c.label.replace(/[\\/]+$/, "") || "/"}
                    </button>
                    {i < data.crumbs.length - 1 && !(i === 0 && c.label === "/") && <span className="text-slate-600">{sep}</span>}
                  </span>
                ))}
              </div>
              {isFetching && <Spinner />}
            </div>

            <div className="well mx-4 min-h-0 flex-1 overflow-y-auto p-1">
              {error ? (
                <div className="p-3">
                  <Callout tone="danger">{(error as Error).message}</Callout>
                </div>
              ) : !data ? (
                <div className="p-6">
                  <Spinner />
                </div>
              ) : data.entries.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">하위 폴더가 없어요.</div>
              ) : (
                <ul>
                  {data.entries.map((e) => (
                    <li key={e.path}>
                      <button onClick={() => setCurrent(e.path)} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-slate-200 transition-colors hover:bg-ink-3 focus-ring">
                        {e.isServer ? <Server className="h-4 w-4 shrink-0 text-redstone" /> : <Folder className="h-4 w-4 shrink-0 text-slate-500" />}
                        <span className="min-w-0 flex-1 truncate">{e.name}</span>
                        {e.isServer ? <Badge tone="brand">등록된 서버</Badge> : e.empty ? <Badge tone="lamp">비어 있음</Badge> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data?.truncated && <p className="px-4 pt-1 text-[11px] text-slate-500">폴더가 많아 앞쪽 300개만 보여요.</p>}

            <footer className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 text-sm">
                {!data ? null : data.isServer ? (
                  <span className="text-amber-300">이미 등록된 서버 폴더예요. 다른 곳을 골라 주세요.</span>
                ) : data.empty ? (
                  <span className="text-slate-300">빈 폴더예요. 이 폴더에 바로 서버를 만들어요.</span>
                ) : (
                  <span className="text-slate-300">
                    이 폴더 안에 <code className="font-mono text-white">{folderName}</code> 폴더를 새로 만들어요.
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>
                  취소
                </Button>
                <Button variant="primary" disabled={!data || data.isServer} onClick={() => data && onPick(data.empty ? data.path : newChild)}>
                  {data?.empty ? "이 폴더 선택" : "여기에 새 폴더로"}
                </Button>
              </div>
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
