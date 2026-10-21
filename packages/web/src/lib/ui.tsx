import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ProcessState } from "@blockpilot/shared";
import { CRACK, burst } from "./burst";
import { DustLoader, ItemIcon, Lamp, LeverGlyph, TntIcon, type ItemName, type LampState } from "./pixel";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** lucide 아이콘과 픽셀 아이콘(TntIcon 등) 둘 다 받는다 */
export type IconType = ComponentType<{ className?: string }>;

// ---------- Button: 돌 버튼 ----------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  // 레드스톤 블록
  primary:
    "bg-[#c42a20] text-white shadow-[inset_2px_2px_0_#ff6b5f,inset_-2px_-2px_0_#5a1712] hover:bg-[#d93a2b] active:shadow-[inset_2px_2px_0_#5a1712,inset_-2px_-2px_0_#ff6b5f] [text-shadow:1px_1px_0_#5a1712]",
  // 돌 버튼
  secondary: "bg-ink-4 text-slate-100 shadow-[inset_2px_2px_0_#5e5e6a,inset_-2px_-2px_0_#1a1a1f] hover:bg-[#44444e] active:shadow-pressed [text-shadow:1px_1px_0_#1a1a1f]",
  outline: "bg-ink-2 text-slate-200 shadow-slab hover:bg-ink-3 active:shadow-pressed",
  ghost: "bg-transparent text-slate-300 hover:bg-ink-3 hover:text-white",
  // TNT
  danger: "bg-[#3a0d0a] text-red-100 shadow-[inset_2px_2px_0_#7a2018,inset_-2px_-2px_0_#160504] hover:bg-[#4a110d]",
};
const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 gap-1.5",
  md: "h-9 px-3.5 gap-2",
  lg: "h-11 px-5 gap-2",
};
const BTN_BASE = "inline-flex items-center justify-center whitespace-nowrap font-block text-[12px] transition-colors focus-ring disabled:opacity-40 disabled:cursor-not-allowed";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconType;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", icon: Icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button ref={ref} disabled={disabled || loading} className={cx(BTN_BASE, VARIANT[variant], SIZE[size], className)} {...rest}>
      {loading ? <DustLoader count={3} size={4} /> : Icon ? <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> : null}
      {children}
    </button>
  );
});

/** <a> 를 버튼처럼 (다운로드 링크 등) */
export function LinkButton({ variant = "secondary", size = "md", icon: Icon, className, children, ...rest }: { variant?: Variant; size?: Size; icon?: IconType; className?: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={cx(BTN_BASE, VARIANT[variant], SIZE[size], className)} {...rest}>
      {Icon && <Icon className="h-4 w-4" />}
      {children}
    </a>
  );
}

// ---------- Inputs: 움푹 파인 홈 ----------

export const inputCls =
  "w-full h-9 bg-[#0d0d0f] shadow-well px-3 text-sm text-slate-100 placeholder-slate-600 transition focus:outline focus:outline-2 focus:outline-redstone/70 focus:outline-offset-0 disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} className={cx(inputCls, mono && "font-mono text-[13px]", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(inputCls, "appearance-none pr-8 bg-no-repeat bg-[right_0.6rem_center] bg-[length:10px]", className)}
      // 픽셀 화살표
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 5 3' shape-rendering='crispEdges'%3E%3Cpath d='M0 0h5v1H0zM1 1h3v1H1zM2 2h1v1H2z' fill='%23a19d94'/%3E%3C/svg%3E\")" }}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      {label && <span className="mb-1.5 block font-block text-[12px] text-slate-400">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

/** 켜기/끄기 = 작은 레버. 오른쪽으로 넘어가고 손잡이가 빨갛게 켜지면 켜진 상태 */
export function Toggle({ checked, onChange, disabled, size = "md" }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-on={checked}
      onClick={() => onChange(!checked)}
      className={cx("inline-grid shrink-0 place-items-center focus-ring disabled:cursor-not-allowed disabled:opacity-40", size === "sm" ? "h-7 w-8" : "h-9 w-10")}
    >
      <LeverGlyph className="h-full w-full" />
    </button>
  );
}

// ---------- Layout primitives ----------

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cx("slab", padded && "p-5", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, icon: Icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: IconType }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <div className="slab mt-0.5 grid h-11 w-11 shrink-0 place-items-center text-redstone">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="font-block text-[24px] leading-tight text-white [text-shadow:2px_2px_0_#08080a]">{title}</h1>
          {description && <div className="mt-1 text-sm text-slate-400">{description}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-block text-[12px] text-slate-300">{children}</h2>
      {right}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number; icon?: IconType }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx("well inline-flex flex-wrap gap-1 p-1", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cx("inline-flex h-8 items-center gap-1.5 px-3 font-block text-[12px] transition-colors focus-ring", active ? "slab text-white" : "text-slate-400 hover:bg-ink-2 hover:text-slate-200")}
          >
            {t.icon && <t.icon className={cx("h-3.5 w-3.5", active && "text-redstone")} />}
            {t.label}
            {t.count !== undefined && <span className={cx("px-1 text-[11px] tnum", active ? "bg-redstone/20 text-red-300" : "bg-ink-3 text-slate-400")}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "brand" | "lamp";
const TONE: Record<Tone, string> = {
  neutral: "bg-[#0d0d0f] text-slate-300 shadow-[inset_1px_1px_0_#08080a,inset_-1px_-1px_0_#2c2c33]",
  success: "bg-emerald-950/70 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(52,211,153,.3)]",
  warning: "bg-amber-950/70 text-amber-300 shadow-[inset_0_0_0_1px_rgba(251,191,36,.3)]",
  danger: "bg-[#2a0b09] text-red-300 shadow-[inset_0_0_0_1px_rgba(255,59,47,.35)]",
  info: "bg-sky-950/70 text-sky-300 shadow-[inset_0_0_0_1px_rgba(56,189,248,.3)]",
  brand: "bg-[#2a0b09] text-red-300 shadow-[inset_0_0_0_1px_rgba(255,59,47,.4)]",
  lamp: "bg-[#2a1d10] text-[#ffe2a8] shadow-[inset_0_0_0_1px_rgba(255,179,71,.35)]",
};

export function Badge({ children, tone = "neutral", className, mono }: { children: ReactNode; tone?: Tone; className?: string; mono?: boolean }) {
  return <span className={cx("inline-flex items-center gap-1 px-1.5 py-px leading-5", mono ? "font-mono text-[11px]" : "font-block text-[12px]", TONE[tone], className)}>{children}</span>;
}

const STATE: Record<ProcessState, { label: string; tone: Tone; lamp: LampState }> = {
  stopped: { label: "중지됨", tone: "neutral", lamp: "off" },
  starting: { label: "시작 중", tone: "warning", lamp: "blink" },
  running: { label: "실행 중", tone: "lamp", lamp: "on" },
  stopping: { label: "중지 중", tone: "warning", lamp: "blink" },
  external: { label: "외부 실행 중", tone: "info", lamp: "on" },
};

/** 서버 상태 = 레드스톤 램프 */
export function StatusBadge({ state, size = "md" }: { state: ProcessState; size?: "sm" | "md" }) {
  const s = STATE[state];
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-block text-[12px]", TONE[s.tone], size === "sm" ? "px-1.5 py-px" : "px-2 py-0.5")}>
      <Lamp state={s.lamp} size={size === "sm" ? 8 : 10} />
      {s.label}
    </span>
  );
}

export function Callout({ tone = "info", title, children, icon: Icon }: { tone?: Tone; title?: ReactNode; children: ReactNode; icon?: IconType }) {
  const I = Icon ?? (tone === "danger" ? XCircle : tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : Info);
  return (
    <div className={cx("flex gap-3 px-4 py-3 text-sm", TONE[tone])}>
      <I className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-slate-200">
        {title && <div className="font-block text-[12px]">{title}</div>}
        <div className={title ? "mt-1 text-slate-300/90" : undefined}>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: IconType; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="well flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon && (
        <div className="slab mb-3 grid h-12 w-12 place-items-center text-slate-500">
          <Icon className="h-6 w-6" />
        </div>
      )}
      {title && <div className="font-block text-[12px] text-slate-200">{title}</div>}
      {children && <div className="mt-1.5 max-w-sm text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 로딩 = 레드스톤 신호 */
export function Spinner({ className }: { className?: string }) {
  return <DustLoader className={className} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="bg-ink-3 px-1.5 py-px font-mono text-[10px] text-slate-300 shadow-[inset_1px_1px_0_#4a4a55,inset_-1px_-1px_0_#08080a]">{children}</kbd>;
}

export function Avatar({ id, size = 28, className }: { id: string; size?: number; className?: string }) {
  return <img src={`https://mc-heads.net/avatar/${encodeURIComponent(id)}/${size}`} alt="" width={size} height={size} className={cx("bg-ink-3 shadow-[0_0_0_2px_#08080a]", className)} style={{ imageRendering: "pixelated" }} loading="lazy" />;
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-[2px] w-full bg-bevel-lo shadow-[0_1px_0_#2c2c33]", className)} />;
}

// ---------- Confirm: TNT 점화 → 한 번 더 누르면 실행 ----------

const PrimedTnt: IconType = ({ className }) => <TntIcon className={className} primed />;

export function ConfirmButton({ label, confirmLabel = "정말요?", onConfirm, variant = "secondary", size = "md", icon, disabled, className }: { label: ReactNode; confirmLabel?: ReactNode; onConfirm: () => void; variant?: Variant; size?: Size; icon?: IconType; disabled?: boolean; className?: string }) {
  const [arm, setArm] = useState(false);
  return (
    <Button
      variant={arm ? "danger" : variant}
      size={size}
      icon={arm ? PrimedTnt : icon}
      disabled={disabled}
      className={className}
      onClick={() => {
        if (arm) {
          setArm(false);
          onConfirm();
        } else {
          setArm(true);
          setTimeout(() => setArm(false), 3000);
        }
      }}
    >
      {arm ? confirmLabel : label}
    </Button>
  );
}

// ---------- HoldButton: 꾹 눌러 캐기 ----------

const HOLD_MS = 1000;

/**
 * 되돌리기 쉬운 삭제용. 누르고 있으면 블록처럼 금이 가다가 다 차면 부서지며 실행된다.
 * 중간에 떼면 금이 다시 메워진다. 짧게 누르면 "꾹 눌러 주세요" 안내. 키보드는 스페이스·엔터를 누르고 있기.
 */
export function HoldButton({ label, onConfirm, icon: Icon, size = "sm", variant = "ghost", disabled, className }: { label: ReactNode; onConfirm: () => void; icon?: IconType; size?: Size; variant?: Variant; disabled?: boolean; className?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const prog = useRef(0);
  const raf = useRef(0);
  const [hint, setHint] = useState(false);
  const [broken, setBroken] = useState(false);

  const draw = (f: number) => {
    const g = canvas.current?.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, 48, 14);
    const n = Math.floor(CRACK.length * (Math.floor(f * 10) / 10));
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 5 === 0 ? "rgba(255,255,255,.28)" : "rgba(0,0,0,.75)";
      g.fillRect(CRACK[i][0], CRACK[i][1], 1, 1);
    }
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 1600);
    return () => clearTimeout(t);
  }, [hint]);

  const start = () => {
    if (disabled || broken) return;
    cancelAnimationFrame(raf.current);
    const t0 = performance.now() - prog.current * HOLD_MS;
    const tick = (t: number) => {
      prog.current = Math.min(1, (t - t0) / HOLD_MS);
      draw(prog.current);
      if (prog.current < 1) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      const r = btn.current?.getBoundingClientRect();
      if (r) burst(r.left + r.width / 2, r.top + r.height / 2, { count: 16, colors: ["#3a3a43", "#4a4a55", "#2d2d35", "#ff3b2f"], spread: 70, size: [3, 6] });
      setBroken(true);
      prog.current = 0;
      draw(0);
      onConfirm();
      setTimeout(() => setBroken(false), 900);
    };
    raf.current = requestAnimationFrame(tick);
  };
  const release = () => {
    cancelAnimationFrame(raf.current);
    if (prog.current > 0 && prog.current < 0.12) setHint(true);
    const back = () => {
      prog.current = Math.max(0, prog.current - 0.08);
      draw(prog.current);
      if (prog.current > 0) raf.current = requestAnimationFrame(back);
    };
    raf.current = requestAnimationFrame(back);
  };

  return (
    <button
      ref={btn}
      type="button"
      disabled={disabled}
      aria-label={typeof label === "string" ? `${label} (꾹 누르기)` : undefined}
      title="꾹 누르고 있으면 실행돼요"
      className={cx(BTN_BASE, VARIANT[variant], SIZE[size], "relative touch-none select-none", broken && "invisible", className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => (e.key === " " || e.key === "Enter") && release()}
      onClick={(e) => e.preventDefault()}
    >
      {Icon && <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />}
      {hint ? "꾹 눌러 주세요" : label}
      <canvas ref={canvas} width={48} height={14} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full [image-rendering:pixelated]" />
    </button>
  );
}

// ---------- Toast: 발전 과제 알림 ----------

type ToastKind = "ok" | "err" | "info";
export interface ToastOptions {
  /** 왼쪽 칸의 아이템 그림 */
  icon?: ItemName;
  /** 처음 한 번만 "도전 과제 완료!" 로 보여 줄 이름 (예: "backup") */
  first?: string;
}
type Toast = { id: number; kind: ToastKind; text: string; icon: ItemName | null; title: string; tone: "gold" | "purple" | "red" | "plain"; leaving?: boolean };
type PushToast = (kind: ToastKind, text: string, opts?: ToastOptions) => void;
const ToastCtx = createContext<PushToast>(() => {});

/** 처음 하는 일인지 (브라우저에 기억). 저장소를 못 쓰면 매번 처음이 아닌 걸로 */
function firstTime(key: string) {
  try {
    const k = `blockpilot.first.${key}`;
    if (localStorage.getItem(k)) return false;
    localStorage.setItem(k, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback<PushToast>((kind, text, opts) => {
    const id = Date.now() + Math.random();
    const challenge = kind === "ok" && !!opts?.first && firstTime(opts.first);
    const t: Toast =
      kind === "err" ? { id, kind, text, icon: "tnt", title: "문제가 생겼어요", tone: "red" }
      : kind === "info" ? { id, kind, text, icon: opts?.icon ?? null, title: "알림", tone: "plain" }
      : { id, kind, text, icon: opts?.icon ?? "lamp", title: challenge ? "도전 과제 완료!" : "발전 과제 달성!", tone: challenge ? "purple" : "gold" };
    setToasts((all) => [...all.slice(-3), t]);
    const life = kind === "err" ? 6500 : challenge ? 5500 : 3800;
    setTimeout(() => setToasts((all) => all.map((x) => (x.id === id ? { ...x, leaving: true } : x))), life);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), life + 320);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* 오른쪽 아래: 위쪽에는 전원 레버가 있어서 가리지 않게 */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col items-end gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role={t.kind === "err" ? "alert" : "status"} className={cx("adv pointer-events-auto", t.leaving && "adv-out")}>
            <span className="adv-icon">{t.icon ? <ItemIcon item={t.icon} className="h-6 w-6" /> : <Info className="h-5 w-5 text-sky-300" />}</span>
            <span className="min-w-0">
              <span className={cx("block font-block text-[12px] leading-5", { gold: "text-[#ffff55]", purple: "text-[#ff6bff]", red: "text-[#ff6b5f]", plain: "text-slate-300" }[t.tone])}>{t.title}</span>
              <span className="block break-words text-[13px] leading-snug text-white">{t.text}</span>
            </span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------- Helpers ----------

export const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`);
export const fmtDate = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function fmtAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
  return `${Math.floor(s / 86400)}일`;
}
