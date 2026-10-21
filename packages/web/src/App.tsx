import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useParams, Link, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Archive, Boxes, ChevronRight, FileCode2, LayoutDashboard, ScrollText, Settings2, SquareTerminal, Users } from "lucide-react";
import { useAuthInfo, useServer } from "./api/hooks";
import { getToken, setToken, setUnauthorizedHandler } from "./api/client";
import { StatusBadge, cx } from "./lib/ui";
import { DustLoader, Lamp, LeverGlyph } from "./lib/pixel";
import { ProcessControls } from "./components/ProcessControls";
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
import NewServer from "./pages/NewServer";

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
      <Route path="/new" element={<NewServer />} />
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

// 로고 레버는 앱을 처음 열 때 한 번만 당겨진다 (화면을 옮길 때마다 다시 켜지지 않게)
let logoPowered = false;

/**
 * 로고 C 시안 "램프 점등": 앱의 전원 레버 + BLOCK/PILOT + 레드스톤 가루 + 램프.
 * 레버가 넘어가면 신호가 가루를 타고 램프까지 가고, 램프가 켜지면 PILOT 이 빛난다.
 */
export function Logo({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  const lg = size === "lg";
  const [on, setOn] = useState(logoPowered);
  useEffect(() => {
    if (on) return;
    const t = setTimeout(() => {
      logoPowered = true;
      setOn(true);
    }, 350);
    return () => clearTimeout(t);
  }, [on]);
  const dots = lg ? 22 : 12;
  const dot = lg ? 5 : 3;
  const tuck = lg ? 12 : 6;
  // 레버 그림 오른쪽 빈칸(16칸 중 3칸)만큼 더 당겨서 가루가 받침에 바로 붙게
  const reach = tuck + (lg ? 14 : 7);
  return (
    <span className={cx("logo-c inline-flex items-end", className)} data-on={on} style={{ "--lamp-delay": `${dots * 45 + 260}ms` } as CSSProperties}>
      <LeverGlyph className={lg ? "h-16 w-[73px] shrink-0" : "h-8 w-[37px] shrink-0"} />
      <span className="inline-flex flex-col" style={{ paddingLeft: tuck, gap: lg ? 13 : 6 }}>
        <span className={cx("font-pixel font-bold leading-none text-white", lg ? "text-[38px] [text-shadow:3px_3px_0_#08080a]" : "text-[15px] [text-shadow:2px_2px_0_#08080a]")}>
          BLOCK<span className="logo-pilot">PILOT</span>
        </span>
        <span className="flex items-end" style={{ marginLeft: -reach, gap: dot }}>
          <span className="flex flex-1 items-end justify-between" style={{ gap: dot - 1 }}>
            {Array.from({ length: dots }, (_, i) => (
              <span key={i} className="dust" style={{ width: dot, height: dot, "--i": i, transform: i % 3 === 1 ? `translateY(${-Math.max(1, dot / 3)}px)` : undefined } as CSSProperties} />
            ))}
          </span>
          <Lamp state={on ? "on" : "off"} size={lg ? 12 : 7} />
        </span>
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
        <p className="font-block text-[12px] text-slate-300">서버 정보를 불러오지 못했습니다.</p>
        <p className="mt-1 text-sm text-slate-500">{(error as Error).message}</p>
        <Link to="/" className="mt-5 inline-flex items-center gap-1.5 text-sm text-red-300 hover:underline">
          <ArrowLeft className="h-4 w-4" /> 서버 목록으로
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[232px] shrink-0 flex-col bg-ink-1 shadow-[inset_-2px_0_0_#08080a]">
        <div className="px-4 pb-3 pt-4">
          <Link to="/" className="focus-ring">
            <Logo />
          </Link>
        </div>
        <div className="slab mx-3 mb-3 px-3 py-2.5">
          <div className="truncate text-sm font-medium text-white" title={server?.path}>
            {server?.name ?? "…"}
          </div>
          <div className="mt-0.5 truncate font-block text-[11px] text-slate-500">{server ? `${loaderLabel(server.loader)} ${server.mcVersion ?? ""}` : ""}</div>
          <div className="mt-2">{server && <StatusBadge state={server.process.state} size="sm" />}</div>
        </div>
        <HotbarNav />
        <div className="px-4 py-3 shadow-[inset_0_2px_0_#08080a]">
          <Link to="/" className="inline-flex items-center gap-1.5 font-block text-[12px] text-slate-500 hover:text-slate-300">
            <ArrowLeft className="h-3.5 w-3.5" /> 서버 목록
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 bg-ink-0/90 px-6 shadow-[inset_0_-2px_0_#08080a] backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-1.5 font-block text-[12px] text-slate-500">
            <span className="truncate">{server?.name}</span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
            <span className="truncate text-slate-200">{current?.label ?? ""}</span>
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

/** 입력 중인 칸이 있으면 숫자 키를 메뉴 이동에 쓰지 않는다 */
function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

/**
 * 연출 6 핫바 메뉴: 선택한 메뉴에 핫바 칸 테두리가 계단식으로 옮겨 가고, 숫자 키 1~8 로 바로 이동.
 * 옮기면 게임 속 아이템 이름처럼 메뉴 이름이 화면 아래에 잠깐 뜬다.
 */
function HotbarNav() {
  const navRef = useRef<HTMLElement>(null);
  const [frame, setFrame] = useState<{ top: number; height: number } | null>(null);
  const [itemName, setItemName] = useState<{ label: string; n: number } | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const first = useRef(true);

  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    setFrame(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
    const cur = NAV.find((n) => (n.to === "" ? location.pathname === `/s/${id}` : location.pathname.endsWith(`/${n.to}`)));
    if (first.current) first.current = false;
    else if (cur) setItemName((p) => ({ label: cur.label, n: (p?.n ?? 0) + 1 }));
  }, [location.pathname, id]);

  useEffect(() => {
    if (!itemName) return;
    const t = setTimeout(() => setItemName(null), 1600);
    return () => clearTimeout(t);
  }, [itemName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing(e)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const k = Number(e.key);
      if (!Number.isInteger(k) || k < 1 || k > NAV.length) return;
      e.preventDefault();
      navigate(NAV[k - 1].to ? `/s/${id}/${NAV[k - 1].to}` : `/s/${id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, navigate]);

  return (
    <nav ref={navRef} className="relative flex-1 space-y-1 overflow-y-auto px-3" aria-label="서버 메뉴 (숫자 키 1~8)">
      {frame && <span className="hotbar-frame" style={{ transform: `translateY(${frame.top}px)`, height: frame.height }} aria-hidden />}
      {NAV.map((n, i) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === ""}
          className={({ isActive }) => cx("group relative z-[1] flex items-center gap-2.5 px-2.5 py-2 font-block text-[12px] transition-colors focus-ring", isActive ? "text-white" : "text-slate-400 hover:bg-ink-2 hover:text-slate-200")}
        >
          {({ isActive }) => (
            <>
              <span className={cx("w-3 shrink-0 text-center font-pixel text-[10px] leading-none", isActive ? "text-redstone" : "text-slate-600")}>{i + 1}</span>
              <n.icon className={cx("h-4 w-4", isActive ? "text-redstone" : "text-slate-500 group-hover:text-slate-300")} />
              {n.label}
            </>
          )}
        </NavLink>
      ))}
      {itemName && (
        <span key={itemName.n} className="item-name" aria-hidden>
          {itemName.label}
        </span>
      )}
    </nav>
  );
}

function FullscreenLoader({ inline }: { inline?: boolean }) {
  return (
    <div className={cx("flex items-center justify-center gap-3 font-block text-[12px] text-slate-500", inline ? "py-24" : "h-screen")}>
      <DustLoader count={6} />
      불러오는 중…
    </div>
  );
}

export function loaderLabel(loader: string) {
  return { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", paper: "Paper", vanilla: "Vanilla", unknown: "알 수 없음" }[loader] ?? loader;
}
