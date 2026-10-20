import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useParams, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthInfo, useServer } from "./api/hooks";
import { getToken, setToken, setUnauthorizedHandler } from "./api/client";
import { StatusBadge, cx } from "./lib/ui";
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

  if (isLoading) return <div className="p-10 text-slate-400">연결 중...</div>;
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
  { to: "", label: "대시보드", icon: "▦" },
  { to: "settings", label: "서버 설정", icon: "⚙" },
  { to: "players", label: "플레이어", icon: "👤" },
  { to: "mods", label: "모드", icon: "🧩" },
  { to: "configs", label: "설정 파일", icon: "📝" },
  { to: "console", label: "콘솔", icon: ">_" },
  { to: "logs", label: "로그", icon: "📄" },
  { to: "backups", label: "백업", icon: "💾" },
];

function ServerLayout() {
  const { id = "" } = useParams();
  const { data: server, error } = useServer(id);

  if (error) {
    return (
      <div className="p-10 text-center text-slate-300">
        <p>서버 정보를 불러오지 못했습니다: {(error as Error).message}</p>
        <Link to="/" className="mt-4 inline-block text-emerald-400 hover:underline">
          서버 목록으로
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-slate-800 bg-slate-950/80 flex flex-col sticky top-0 h-screen">
        <div className="px-4 py-4 border-b border-slate-800">
          <Link to="/" className="text-xs text-slate-500 hover:text-slate-300">
            ← 서버 목록
          </Link>
          <div className="mt-2 font-semibold truncate" title={server?.path}>
            {server?.name ?? "..."}
          </div>
          <div className="mt-1 text-xs text-slate-400">{server ? `${loaderLabel(server.loader)} ${server.mcVersion ?? ""}` : ""}</div>
          <div className="mt-2">{server && <StatusBadge state={server.process.state} />}</div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === ""}
              className={({ isActive }) =>
                cx("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm", isActive ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200")
              }
            >
              <span className="w-5 text-center text-xs opacity-80">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 text-[11px] text-slate-600 border-t border-slate-800">BlockPilot</div>
      </aside>
      <main className="flex-1 min-w-0 p-8">{server ? <Outlet /> : <div className="text-slate-400">불러오는 중...</div>}</main>
    </div>
  );
}

export function loaderLabel(loader: string) {
  return { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", paper: "Paper", vanilla: "Vanilla", unknown: "알 수 없음" }[loader] ?? loader;
}
