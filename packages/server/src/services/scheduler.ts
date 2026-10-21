import type { BackupStatus } from "@blockpilot/shared";
import type { FastifyBaseLogger } from "fastify";
import { getBackupSettings, listServers } from "../config/store.js";
import { getManaged } from "./process.js";
import { createBackup, pruneScheduled } from "./backups.js";
import { emitServerEvent } from "./events.js";

/**
 * 자동 백업 스케줄러. 1분마다 등록된 서버를 돌며 간격이 지난 서버를 백업한다.
 * 실행 중이면 save-all flush 후 백업, 중지 상태면 설정(whenStopped)에 따라.
 */

const TICK_MS = 60_000;
const state = new Map<string, { lastRunAt?: string; lastError?: string; running: boolean }>();
let timer: NodeJS.Timeout | null = null;
let log: FastifyBaseLogger | null = null;

export function startScheduler(logger: FastifyBaseLogger) {
  log = logger;
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function backupStatus(serverId: string): Promise<BackupStatus> {
  const settings = await getBackupSettings(serverId);
  const s = state.get(serverId);
  let nextRunAt: string | undefined;
  if (settings.intervalMinutes > 0) {
    const base = s?.lastRunAt ? new Date(s.lastRunAt).getTime() : Date.now();
    nextRunAt = new Date(base + settings.intervalMinutes * 60_000).toISOString();
  }
  return { settings, running: s?.running ?? false, lastRunAt: s?.lastRunAt, lastError: s?.lastError, nextRunAt };
}

async function tick() {
  for (const server of await listServers()) {
    try {
      const settings = await getBackupSettings(server.id);
      if (settings.intervalMinutes <= 0) continue;
      const s = state.get(server.id) ?? { running: false };
      if (s.running) continue;
      const due = !s.lastRunAt || Date.now() - new Date(s.lastRunAt).getTime() >= settings.intervalMinutes * 60_000;
      if (!due) continue;
      await runScheduledBackup(server.id, server.path, settings.keep, settings.whenStopped);
    } catch (e) {
      log?.error({ err: e, server: server.id }, "자동 백업 실패");
    }
  }
}

export async function runScheduledBackup(serverId: string, dir: string, keep: number, whenStopped: boolean) {
  const s = state.get(serverId) ?? { running: false };
  state.set(serverId, s);
  const managed = getManaged(serverId, dir);
  const st = await managed.status();
  if (st.state === "stopped" && !whenStopped) {
    // 중지 상태면 건너뛰되 시각은 갱신해 매 틱마다 재시도하지 않게
    s.lastRunAt = new Date().toISOString();
    return;
  }
  s.running = true;
  try {
    const b = await managed.withSavesPaused(() => createBackup(dir, { scheduled: true }));
    await pruneScheduled(dir, keep);
    s.lastRunAt = new Date().toISOString();
    s.lastError = undefined;
    log?.info({ server: serverId, file: b.file }, "자동 백업 완료");
    emitServerEvent({ serverId, type: "backup", detail: `${b.file} (자동)` });
  } catch (e: any) {
    s.lastRunAt = new Date().toISOString();
    s.lastError = e?.message ?? String(e);
    throw e;
  } finally {
    s.running = false;
  }
}

export function isBackupRunning(serverId: string) {
  return state.get(serverId)?.running ?? false;
}
