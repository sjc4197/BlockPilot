import type { BackupEntry, BackupStatus } from "@blockpilot/shared";
import type { FastifyBaseLogger } from "fastify";
import { getBackupSettings, listServers } from "../config/store.js";
import { getManaged } from "./process.js";
import { createBackup, listBackups, pruneScheduled } from "./backups.js";
import { emitServerEvent } from "./events.js";

/**
 * 자동 백업 스케줄러. 1분마다 등록된 서버를 돌며 간격이 지난 서버를 백업한다.
 * 실행 중이면 save-all flush 후 백업, 중지 상태면 설정(whenStopped)에 따라.
 * lastRunAt 은 메모리에만 있으므로, 서버별 첫 평가 때 가장 최근 -auto.zip 의 시각으로 채워 넣는다.
 * 그래야 BlockPilot 을 재시작해도 모든 서버가 첫 틱에 한꺼번에 백업하지 않는다.
 */

const TICK_MS = 60_000;
const state = new Map<string, { lastRunAt?: string; lastError?: string; running: boolean; seeded?: boolean }>();
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
      const s = await seedLastRunAt(server.id, server.path);
      if (s.running) continue;
      const due = !s.lastRunAt || Date.now() - new Date(s.lastRunAt).getTime() >= settings.intervalMinutes * 60_000;
      if (!due) continue;
      await runScheduledBackup(server.id, server.path, settings.keep, settings.whenStopped);
    } catch (e) {
      log?.error({ err: e, server: server.id }, "자동 백업 실패");
    }
  }
}

/** 자동 백업 목록에서 가장 최근 것의 시각 (없으면 undefined). listBackups 는 최신순이지만 여기서는 순서에 기대지 않는다 */
export function latestScheduledBackupAt(backups: BackupEntry[]): string | undefined {
  let latest: string | undefined;
  for (const b of backups) {
    if (b.scheduled && (!latest || b.createdAt > latest)) latest = b.createdAt;
  }
  return latest;
}

/**
 * 서버별 첫 평가 때 한 번만: 디스크의 가장 최근 -auto.zip 시각으로 lastRunAt 을 채운다 (이미 값이 있으면 건드리지 않음).
 * 백업 폴더를 못 읽으면 그냥 비워 둔다 (= 예전처럼 다음 틱에 바로 실행).
 */
export async function seedLastRunAt(serverId: string, dir: string) {
  const s = state.get(serverId) ?? { running: false };
  state.set(serverId, s);
  if (s.seeded) return s;
  s.seeded = true;
  if (!s.lastRunAt) {
    const latest = latestScheduledBackupAt(await listBackups(dir).catch(() => []));
    if (latest) s.lastRunAt = latest;
  }
  return s;
}

/** 테스트용: 서버의 스케줄러 메모리 상태를 지운다 */
export function resetSchedulerState(serverId?: string) {
  if (serverId) state.delete(serverId);
  else state.clear();
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
