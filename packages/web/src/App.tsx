import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useParams, Link, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Archive, Boxes, ChevronRight, FileCode2, LayoutDashboard, ScrollText, Settings2, SquareTerminal, Users } from "lucide-react";
import { useAuthInfo, useServer } from "./api/hooks";
import { getToken, setToken, setUnauthorizedHandler } from "./api/client";
import { StatusBadge, cx } from "./lib/ui";
import { ProcessControls } from "./components/ProcessControls";
import { DustRow, PixelLeverMark } from "./components/Lever";
import ServerSelect from "./pages/ServerSelect";
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
import Players from "./pages/Players";
import Mods from "./pages/Mods";
import Console from "./pages/Console";
import ConfigFiles from "./pages/ConfigFiles";
import Logs from "./pages/Logs";
import Backups from "./pages/Backups";
import Login from "./pages/Login";

export default function App() {
  const qc = useQueryClient();
  const { data: auth, isLoading } = useAuthInfo();
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setNeedLogin(true));
  }, []);
  useEffect(() => {
    if (auth) setNeedLogin(auth.required && !auth.authenticated);
  }, [auth]);

  if (isLoading) return <FullscreenLoader />;
  if (needLogin || (auth?.required && !getToken())) {
    return (
      <Login
        onLogin={(token) => {
          setToken(token);
          setNeedLogin(false);
          qc.invalidateQueries();
        }}
      />
    );
  }

  return (
    <Routes>
      <Route path="/" element={<ServerSelect />} />
      <Route path="/s/:id" element={<ServerLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="settings" element={<Settings />} />
        <Route path="players" element={<Players />} />
        <Route path="mods" element={<Mods />} />
        <Route path="configs" element={<ConfigFiles />} />
        <Route path="console" element={<Console />} />
        <Route path="logs" element={<Logs />} />
        <Route path="backups" element={<Backups />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

const NAV = [
  { to: "", label: "대시보드", icon: LayoutDashboard },
  { to: "settings", label: "서버 설정", icon: Settings2 },
  { to: "players", label: "플레이어", icon: Users },
  { to: "mods", label: "모드", icon: Boxes },
  { to: "configs", label: "설정 파일", icon: FileCode2 },
  { to: "console", label: "콘솔", icon: SquareTerminal },
  { to: "logs", label: "로그", icon: ScrollText },
  { to: "backups", label: "백업", icon: Archive },
];

/** J 시안: 레버 마크 + BLOCK/PILOT 픽셀 워드마크 + 레드스톤 가루 밑줄 */
export function Logo({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <span className={cx("inline-flex items-center", lg ? "gap-4" : "gap-2.5", className)}>
      <PixelLeverMark className={lg ? "h-16 w-16" : "h-8 w-8"} />
      <span className="inline-flex flex-col">
        <span className={cx("font-pixel font-bold leading-none text-white", lg ? "text-[38px]" : "text-[15px]")}>
          BLOCK<span className="text-redstone">PILOT</span>
        </span>
        <DustRow count={lg ? 24 : 13} lit={lg ? 14 : 8} size={lg ? 5 : 3} className={lg ? "mt-3" : "mt-1.5"} />
      </span>
    </span>
  );
}

function ServerLayout() {
  const { id = "" } = useParams();
  const { data: server, error } = useServer(id);
  const location = useLocation();
  const current = NAV.find((n) => (n.to === "" ? location.pathname === `/s/${id}` : location.pathname.endsWith(`/${n.to}`)));

  if (error) {
    return (
      <div className="mx-auto mt-24 max-w-md text-center">
        <p className="text-slate-300">서버 정보를 불러오지 못했습니다.</p>
        <p className="mt-1 text-sm text-slate-500">{(error as Error).message}</p>
        <Link to="/" className="mt-5 inline-flex items-center gap-1.5 text-sm text-brand-400 hover:underline">
          <ArrowLeft className="h-4 w-4" /> 서버 목록으로
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[232px] shrink-0 flex-col border-r border-line bg-ink-1/60 backdrop-blur-sm">
        <div className="px-4 pt-4 pb-3">
          <Link to="/" className="focus-ring rounded-md">
            <Logo />
          </Link>
        </div>
        <div className="mx-3 mb-3 rounded-xl border border-line bg-ink-2/70 px-3 py-2.5">
          <div className="truncate text-sm font-medium text-white" title={server?.path}>
            {server?.name ?? "…"}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500">{server ? `${loaderLabel(server.loader)} ${server.mcVersion ?? ""}` : ""}</div>
          <div className="mt-2">{server && <StatusBadge state={server.process.state} size="sm" />}</div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === ""}
              className={({ isActive }) =>
                cx(
                  "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition focus-ring",
                  isActive ? "bg-ink-3 text-white shadow-[0_1px_0_rgba(255,255,255,.05)_inset]" : "text-slate-400 hover:bg-ink-2 hover:text-slate-200",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <n.icon className={cx("h-4 w-4 transition", isActive ? "text-brand-400" : "text-slate-500 group-hover:text-slate-300")} />
                  {n.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-4 py-3">
          <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300">
            <ArrowLeft className="h-3.5 w-3.5" /> 서버 목록
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-line bg-ink-0/70 px-6 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-1.5 text-sm text-slate-400">
            <span className="truncate">{server?.name}</span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
            <span className="truncate font-medium text-slate-200">{current?.label ?? ""}</span>
          </div>
          {server && <ProcessControls serverId={id} status={server.process} size="sm" />}
        </header>
        <main className="flex-1 px-6 py-6">
          <div key={location.pathname} className="mx-auto max-w-6xl animate-fade-in">
            {server ? <Outlet /> : <FullscreenLoader inline />}
          </div>
        </main>
      </div>
    </div>
  );
}

function FullscreenLoader({ inline }: { inline?: boolean }) {
  return (
    <div className={cx("flex items-center justify-center text-sm text-slate-500", inline ? "py-24" : "h-screen")}>
      <span className="mr-2 h-2 w-2 animate-pulse-dot rounded-full bg-brand-400" />
      불러오는 중…
    </div>
  );
}

export function loaderLabel(loader: string) {
  return { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", paper: "Paper", vanilla: "Vanilla", unknown: "알 수 없음" }[loader] ?? loader;
}
