import { useEffect, useState } from "react";
import { ArrowUp, Folder, FolderOpen, FolderSearch, HardDrive, Home, Server, X } from "lucide-react";
import { useFsList } from "../api/hooks";
import { Badge, Button, Callout, Spinner, cx } from "../lib/ui";

/** 경로의 마지막 폴더 이름 (루트면 경로 그대로) */
const lastName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/**
 * 폴더 고르기 모달. 폴더를 눌러 들어가고 현재 폴더를 고른다.
 * - mode="create" (새 서버 만들기): 비어 있으면 그 폴더에 바로, 아니면 그 안에 folderName 으로 새 폴더를 만든다
 * - mode="register" (이미 있는 서버 폴더 추가): 지금 보고 있는 폴더를 그대로 고른다. 빈 폴더·이미 등록된 폴더는 못 고른다
 */
export function FolderPicker({ mode = "create", initialPath, folderName = "", onPick, onClose }: { mode?: "create" | "register"; initialPath: string; folderName?: string; onPick: (path: string) => void; onClose: () => void }) {
  const register = mode === "register";
  // 처음엔 입력된 경로(없거나 아직 없을 수 있음)의 가장 가까운 상위 폴더(없으면 홈)로 연다. 그 뒤로는 고른 폴더 그대로
  const [nav, setNav] = useState<{ path: string | null; nearest: boolean }>({ path: initialPath || null, nearest: true });
  const setCurrent = (p: string) => setNav({ path: p, nearest: false });
  const { data, error, isFetching } = useFsList(nav.path, nav.nearest);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sep = data?.path.includes("\\") ? "\\" : "/";
  const newChild = data ? `${data.path.replace(/[\\/]+$/, "")}${sep}${folderName}` : "";
  const TitleIcon = register ? FolderSearch : FolderOpen;
  const title = register ? "서버 폴더 찾기" : "서버를 만들 폴더 찾기";
  const canPick = !!data && !data.isServer && (!register || !data.empty);
  const pick = () => data && onPick(register || data.empty ? data.path : newChild);

  const shortcutBtn = (s: NonNullable<typeof data>["shortcuts"][number], chip: boolean) => {
    const Icon = s.kind === "home" ? Home : s.kind === "drive" ? HardDrive : Folder;
    const active = data?.path === s.path;
    return (
      <button
        key={s.path}
        type="button"
        onClick={() => setCurrent(s.path)}
        aria-current={active ? "location" : undefined}
        className={cx(
          "flex items-center gap-2 text-left font-block text-[12px] transition-colors focus-ring",
          chip ? "h-8 shrink-0 px-2.5" : "w-full px-2.5 py-2",
          active ? "slab text-white" : chip ? "bg-ink-3 text-slate-400 hover:bg-ink-4 hover:text-slate-200" : "text-slate-400 hover:bg-ink-3 hover:text-slate-200",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{s.label}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass flex h-[min(620px,88vh)] w-[min(880px,96vw)] flex-col">
        <header className="flex items-center justify-between px-4 py-3 shadow-[inset_0_-2px_0_#08080a] sm:px-5">
          <h2 className="flex items-center gap-2 font-block text-[12px] text-white">
            <TitleIcon className="h-4 w-4 text-redstone" /> {title}
          </h2>
          <Button size="sm" variant="ghost" icon={X} onClick={onClose} aria-label="닫기" />
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 바로가기: 넓은 화면에선 왼쪽 세로 목록, 폰에선 목록 위의 가로 칩 줄 */}
          <aside className="hidden w-48 shrink-0 space-y-1 overflow-y-auto p-3 shadow-[inset_-2px_0_0_#08080a] sm:block" aria-label="바로가기">
            {data?.shortcuts.map((s) => shortcutBtn(s, false))}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {data && data.shortcuts.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto px-3 pt-2.5 [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden" aria-label="바로가기">
                {data.shortcuts.map((s) => shortcutBtn(s, true))}
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
              <Button size="sm" icon={ArrowUp} disabled={!data?.parent} onClick={() => data?.parent && setCurrent(data.parent)} aria-label="상위 폴더">
                <span className="hidden sm:inline">상위 폴더</span>
              </Button>
              <div className="well flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2 py-1 font-mono text-[12px] text-slate-400">
                {data?.crumbs.map((c, i) => (
                  <span key={c.path} className="flex shrink-0 items-center gap-0.5">
                    <button type="button" className={cx("px-0.5 hover:text-white focus-ring", i === data.crumbs.length - 1 && "text-slate-100")} onClick={() => setCurrent(c.path)}>
                      {c.label.replace(/[\\/]+$/, "") || "/"}
                    </button>
                    {i < data.crumbs.length - 1 && !(i === 0 && c.label === "/") && <span className="text-slate-600">{sep}</span>}
                  </span>
                ))}
              </div>
              {isFetching && <Spinner />}
            </div>

            <div className="well mx-3 min-h-0 flex-1 overflow-y-auto p-1 sm:mx-4">
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
                      <button type="button" onClick={() => setCurrent(e.path)} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-slate-200 transition-colors hover:bg-ink-3 focus-ring">
                        {e.isServer ? <Server className="h-4 w-4 shrink-0 text-redstone" /> : <Folder className="h-4 w-4 shrink-0 text-slate-500" />}
                        <span className="min-w-0 flex-1 truncate">{e.name}</span>
                        {e.isServer ? (
                          <Badge tone="brand">{register ? "이미 등록됨" : "등록된 서버"}</Badge>
                        ) : register && e.hasServerProperties ? (
                          <Badge tone="lamp">서버 폴더</Badge>
                        ) : e.empty ? (
                          <Badge tone={register ? "neutral" : "lamp"}>비어 있음</Badge>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data?.truncated && <p className="px-3 pt-1 text-[11px] text-slate-500 sm:px-4">폴더가 많아 앞쪽 300개만 보여요.</p>}

            <footer className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
              <div className="min-w-0 flex-1 text-sm">
                {!data ? null : data.isServer ? (
                  <span className="block text-amber-300">{register ? "이미 등록된 서버 폴더예요." : "이미 등록된 서버 폴더예요. 다른 곳을 골라 주세요."}</span>
                ) : register ? (
                  data.empty ? (
                    <span className="block text-amber-300">빈 폴더예요. server.properties 가 있는 서버 폴더를 골라 주세요.</span>
                  ) : (
                    <span className="block text-slate-300">
                      <code className="font-mono text-white" title={data.path}>
                        {lastName(data.path)}
                      </code>{" "}
                      {data.hasServerProperties ? "폴더를 등록해요." : "폴더에는 server.properties 가 없어요. 그래도 등록할 수 있지만 서버 폴더가 맞는지 확인해 주세요."}
                    </span>
                  )
                ) : data.empty ? (
                  <span className="block text-slate-300">빈 폴더예요. 이 폴더에 바로 서버를 만들어요.</span>
                ) : (
                  <span className="block text-slate-300">
                    이 폴더 안에 <code className="font-mono text-white">{folderName}</code> 폴더를 새로 만들어요.
                  </span>
                )}
                {data && !data.isServer && (
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500" title={data.path}>
                    {data.path}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  취소
                </Button>
                <Button variant="primary" disabled={!canPick} onClick={pick}>
                  {register || data?.empty ? "이 폴더 선택" : "여기에 새 폴더로"}
                </Button>
              </div>
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
