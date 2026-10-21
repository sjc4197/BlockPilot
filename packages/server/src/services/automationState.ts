import type { CrashSummary } from "@blockpilot/shared";

/** 자동 재시작·예약 재시작이 메모리에 들고 있는 상태 (화면에 보여 주기용) */
export interface AutomationRuntime {
  recentAttempts: number;
  gaveUp: boolean;
  lastCrash?: CrashSummary;
  nextScheduledAt?: string;
  skipNext: boolean;
}

const state = new Map<string, AutomationRuntime>();

export function automationRuntime(id: string): AutomationRuntime {
  let s = state.get(id);
  if (!s) {
    s = { recentAttempts: 0, gaveUp: false, skipNext: false };
    state.set(id, s);
  }
  return s;
}
