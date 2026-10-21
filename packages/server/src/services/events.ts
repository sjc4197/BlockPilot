import { EventEmitter } from "node:events";
import type { ServerEvent } from "@blockpilot/shared";

/**
 * 서버 사건 알림판. 프로세스 관리(process.ts)와 백업이 사건을 올리고,
 * 디스코드 알림·자동 재시작·통계가 듣는다. 듣는 쪽이 실패해도 서버 동작에는 영향이 없다.
 */
const hub = new EventEmitter();
hub.setMaxListeners(50);

export function emitServerEvent(e: Omit<ServerEvent, "at"> & { at?: string }) {
  const event: ServerEvent = { ...e, at: e.at ?? new Date().toISOString() };
  for (const fn of hub.listeners("event") as ((e: ServerEvent) => unknown)[]) {
    try {
      const r = fn(event);
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* 듣는 쪽 오류는 무시 */
    }
  }
}

export function onServerEvent(fn: (e: ServerEvent) => unknown): () => void {
  hub.on("event", fn);
  return () => hub.off("event", fn);
}
