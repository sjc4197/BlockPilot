import { createContext, forwardRef, useCallback, useContext, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle, type LucideIcon } from "lucide-react";
import type { ProcessState } from "@blockpilot/shared";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- Button ----------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_6px_16px_-6px_rgba(16,185,129,.6)] hover:from-brand-400 hover:to-brand-600 active:translate-y-px",
  secondary: "bg-ink-3 text-slate-100 border border-line-strong hover:bg-ink-4 hover:border-slate-500/40 active:translate-y-px",
  outline: "bg-transparent text-slate-200 border border-line-strong hover:bg-ink-3 active:translate-y-px",
  ghost: "bg-transparent text-slate-300 hover:bg-ink-3 hover:text-white",
  danger: "bg-gradient-to-b from-rose-500 to-rose-600 text-white hover:from-rose-400 hover:to-rose-600 active:translate-y-px",
};
const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-9 px-3.5 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-sm gap-2 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", icon: Icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx("inline-flex items-center justify-center font-medium whitespace-nowrap transition-all duration-150 focus-ring disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0", VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> : null}
      {children}
    </button>
  );
});

/** <a> 를 버튼처럼 (다운로드 링크 등) */
export function LinkButton({ variant = "secondary", size = "md", icon: Icon, className, children, ...rest }: { variant?: Variant; size?: Size; icon?: LucideIcon; className?: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={cx("inline-flex items-center justify-center font-medium whitespace-nowrap transition-all duration-150 focus-ring", VARIANT[variant], SIZE[size], className)} {...rest}>
      {Icon && <Icon className="h-4 w-4" />}
      {children}
    </a>
  );
}

// ---------- Inputs ----------

export const inputCls =
  "w-full h-9 rounded-lg bg-ink-0/70 border border-line-strong px-3 text-sm text-slate-100 placeholder-slate-500 transition focus:outline-none focus:border-brand-500/70 focus:ring-2 focus:ring-brand-500/25 disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} className={cx(inputCls, mono && "font-mono text-[13px]", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputCls, "appearance-none pr-8 bg-no-repeat bg-[right_0.6rem_center] bg-[length:14px]", className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      {label && <span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, size = "md" }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; size?: "sm" | "md" }) {
  const dims = size === "sm" ? { track: "h-5 w-9", knob: "h-4 w-4", on: "translate-x-[18px]", off: "translate-x-0.5" } : { track: "h-6 w-11", knob: "h-5 w-5", on: "translate-x-[22px]", off: "translate-x-0.5" };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 focus-ring disabled:opacity-50", dims.track, checked ? "bg-brand-500 shadow-[0_0_12px_-2px_rgba(16,185,129,.7)]" : "bg-ink-4 border border-line-strong")}
    >
      <span className={cx("inline-block rounded-full bg-white shadow transition-transform duration-200", dims.knob, checked ? dims.on : dims.off)} />
    </button>
  );
}

// ---------- Layout primitives ----------

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cx("surface", padded && "p-5", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, icon: Icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3 min-w-0">
        {Icon && (
          <div className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-ink-2 text-brand-400">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-white">{title}</h1>
          {description && <div className="mt-1 text-sm text-slate-400">{description}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number; icon?: LucideIcon }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx("inline-flex flex-wrap gap-1 rounded-xl border border-line bg-ink-1/70 p-1", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cx("inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition focus-ring", active ? "bg-ink-3 text-white shadow-[0_1px_0_rgba(255,255,255,.06)_inset]" : "text-slate-400 hover:text-slate-200 hover:bg-ink-2")}
          >
            {t.icon && <t.icon className="h-3.5 w-3.5" />}
            {t.label}
            {t.count !== undefined && <span className={cx("rounded-md px-1.5 text-[11px] tnum", active ? "bg-brand-500/20 text-brand-300" : "bg-ink-3 text-slate-400")}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "brand";
const TONE: Record<Tone, string> = {
  neutral: "bg-ink-3 text-slate-300 border-line-strong",
  success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  warning: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  danger: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  info: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  brand: "bg-brand-500/10 text-brand-300 border-brand-500/30",
};

export function Badge({ children, tone = "neutral", className, mono }: { children: ReactNode; tone?: Tone; className?: string; mono?: boolean }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium leading-5", TONE[tone], mono && "font-mono", className)}>{children}</span>;
}

const STATE: Record<ProcessState, { label: string; tone: Tone; pulse?: boolean }> = {
  stopped: { label: "중지됨", tone: "neutral" },
  starting: { label: "시작 중", tone: "warning", pulse: true },
  running: { label: "실행 중", tone: "success", pulse: true },
  stopping: { label: "중지 중", tone: "warning", pulse: true },
  external: { label: "외부 실행 중", tone: "info", pulse: true },
};

export function StatusBadge({ state, size = "md" }: { state: ProcessState; size?: "sm" | "md" }) {
  const s = STATE[state];
  const dot = { neutral: "bg-slate-400", success: "bg-emerald-400", warning: "bg-amber-400", danger: "bg-rose-400", info: "bg-sky-400", brand: "bg-brand-400" }[s.tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border font-medium", TONE[s.tone], size === "sm" ? "px-2 py-px text-[11px]" : "px-2.5 py-0.5 text-xs")}>
      <span className={cx("h-1.5 w-1.5 rounded-full", dot, s.pulse && "animate-pulse-dot")} />
      {s.label}
    </span>
  );
}

export function Callout({ tone = "info", title, children, icon: Icon }: { tone?: Tone; title?: ReactNode; children: ReactNode; icon?: LucideIcon }) {
  const I = Icon ?? (tone === "danger" ? XCircle : tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : Info);
  return (
    <div className={cx("flex gap-3 rounded-xl border px-4 py-3 text-sm", TONE[tone])}>
      <I className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-slate-200">
        {title && <div className="font-medium">{title}</div>}
        <div className={title ? "mt-0.5 text-slate-300/90" : undefined}>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center">
      {Icon && (
        <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-ink-2 text-slate-500">
          <Icon className="h-6 w-6" />
        </div>
      )}
      {title && <div className="text-sm font-medium text-slate-200">{title}</div>}
      {children && <div className="mt-1 max-w-sm text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("h-5 w-5 animate-spin text-slate-500", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-ink-3 px-1.5 py-px font-mono text-[10px] text-slate-300">{children}</kbd>;
}

export function Avatar({ id, size = 28, className }: { id: string; size?: number; className?: string }) {
  return <img src={`https://mc-heads.net/avatar/${encodeURIComponent(id)}/${size}`} alt="" width={size} height={size} className={cx("rounded-md bg-ink-3", className)} style={{ imageRendering: "pixelated" }} loading="lazy" />;
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-px w-full bg-line", className)} />;
}

// ---------- Confirm (alert/confirm 대신 2단계 클릭) ----------

export function ConfirmButton({ label, confirmLabel = "정말요?", onConfirm, variant = "secondary", size = "md", icon, disabled, className }: { label: ReactNode; confirmLabel?: ReactNode; onConfirm: () => void; variant?: Variant; size?: Size; icon?: LucideIcon; disabled?: boolean; className?: string }) {
  const [arm, setArm] = useState(false);
  return (
    <Button
      variant={arm ? "danger" : variant}
      size={size}
      icon={arm ? undefined : icon}
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

// ---------- Toast ----------

type ToastKind = "ok" | "err" | "info";
type Toast = { id: number; kind: ToastKind; text: string };
const ToastCtx = createContext<(kind: ToastKind, text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 6500 : 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[22rem] flex-col gap-2">
        {toasts.map((t) => {
          const I = t.kind === "ok" ? CheckCircle2 : t.kind === "err" ? XCircle : Info;
          const tone = t.kind === "ok" ? "text-emerald-400" : t.kind === "err" ? "text-rose-400" : "text-sky-400";
          return (
            <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-xl glass px-4 py-3 text-sm text-slate-100 shadow-pop animate-slide-in-right">
              <I className={cx("mt-0.5 h-4 w-4 shrink-0", tone)} />
              <span className="min-w-0 flex-1 break-words">{t.text}</span>
            </div>
          );
        })}
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
