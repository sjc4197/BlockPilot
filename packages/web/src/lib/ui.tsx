import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { ProcessState } from "@blockpilot/shared";

// ---------- 공통 클래스 ----------

export const btn = {
  base: "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed",
  primary: "bg-emerald-600 hover:bg-emerald-500 text-white",
  secondary: "bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700",
  danger: "bg-red-600/90 hover:bg-red-500 text-white",
  ghost: "hover:bg-slate-800 text-slate-300",
};
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const input =
  "w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 focus:border-emerald-500";

export const card = "rounded-xl border border-slate-800 bg-slate-900/60 p-5";

// ---------- 상태 배지 ----------

const STATE_LABEL: Record<ProcessState, { label: string; cls: string }> = {
  stopped: { label: "중지됨", cls: "bg-slate-700 text-slate-200" },
  starting: { label: "시작 중", cls: "bg-amber-500/20 text-amber-300 border border-amber-500/40" },
  running: { label: "실행 중", cls: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" },
  stopping: { label: "중지 중", cls: "bg-amber-500/20 text-amber-300 border border-amber-500/40" },
  external: { label: "외부 실행 중", cls: "bg-sky-500/20 text-sky-300 border border-sky-500/40" },
};

export function StatusBadge({ state }: { state: ProcessState }) {
  const s = STATE_LABEL[state];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", s.cls)}>
      <span className={cx("h-1.5 w-1.5 rounded-full", state === "running" ? "bg-emerald-400 animate-pulse" : state === "stopped" ? "bg-slate-400" : "bg-amber-400")} />
      {s.label}
    </span>
  );
}

// ---------- 토스트 ----------

type Toast = { id: number; kind: "ok" | "err" | "info"; text: string };
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "rounded-lg px-4 py-3 text-sm shadow-lg border",
              t.kind === "ok" && "bg-emerald-950 border-emerald-700 text-emerald-100",
              t.kind === "err" && "bg-red-950 border-red-700 text-red-100",
              t.kind === "info" && "bg-slate-800 border-slate-600 text-slate-100",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------- 확인 버튼 (alert/confirm 대신 2단계 클릭) ----------

export function ConfirmButton({
  label,
  confirmLabel = "정말요?",
  onConfirm,
  className,
  disabled,
}: {
  label: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [arm, setArm] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      className={cx(btn.base, arm ? btn.danger : className ?? btn.secondary)}
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
    </button>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-emerald-400" />;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">{children}</div>;
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50",
        checked ? "bg-emerald-500" : "bg-slate-700",
      )}
    >
      <span className={cx("inline-block h-5 w-5 rounded-full bg-white shadow transition", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}
