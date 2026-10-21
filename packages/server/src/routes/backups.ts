import type { FastifyInstance } from "fastify";
import path from "node:path";
import { BackupSettings } from "@blockpilot/shared";
import { createBackup, deleteBackup, listBackups, restoreBackup, BACKUP_DIR, worldDirs } from "../services/backups.js";
import { emitServerEvent } from "../services/events.js";
import { backupStatus } from "../services/scheduler.js";
import { getBackupSettings, setBackupSettings } from "../config/store.js";
import { loadContext } from "../lib/context.js";
import { assertPlainFilename } from "../lib/safePath.js";
import { conflict } from "../lib/errors.js";

export async function backupsRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/backups", async (req) => {
    const { id } = req.params as { id: string };
    const { dir } = await loadContext(id);
    const [backups, status, worlds] = await Promise.all([listBackups(dir), backupStatus(id), worldDirs(dir)]);
    return { backups, status, worlds };
  });

  app.post("/api/servers/:id/backups", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { label } = (req.body ?? {}) as { label?: string };
    const { dir, managed } = await loadContext(id);
    const b = await managed.withSavesPaused(() => createBackup(dir, { label }));
    emitServerEvent({ serverId: id, type: "backup", detail: b.file });
    reply.code(201);
    return b;
  });

  app.delete("/api/servers/:id/backups/:file", async (req) => {
    const { id, file } = req.params as { id: string; file: string };
    const { dir } = await loadContext(id);
    await deleteBackup(dir, file);
    return { ok: true };
  });

  app.post("/api/servers/:id/backups/:file/restore", async (req) => {
    const { id, file } = req.params as { id: string; file: string };
    const { dir, managed } = await loadContext(id);
    const st = await managed.status();
    if (st.state !== "stopped") throw conflict("복원은 서버가 중지된 상태에서만 가능합니다.");
    return restoreBackup(dir, file);
  });

  app.get("/api/servers/:id/backups/:file/download", async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    assertPlainFilename(file);
    const { dir } = await loadContext(id);
    const { createReadStream } = await import("node:fs");
    const { stat } = await import("node:fs/promises");
    const full = path.join(dir, BACKUP_DIR, file);
    const st = await stat(full).catch(() => null);
    if (!st) return reply.code(404).send({ error: "not_found", message: "백업 파일을 찾을 수 없습니다." });
    reply.header("content-type", "application/zip");
    reply.header("content-length", st.size);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);
    return reply.send(createReadStream(full));
  });

  app.get("/api/servers/:id/backups/settings", async (req) => {
    const { id } = req.params as { id: string };
    await loadContext(id);
    return getBackupSettings(id);
  });

  app.put("/api/servers/:id/backups/settings", async (req) => {
    const { id } = req.params as { id: string };
    const settings = BackupSettings.parse(req.body);
    await loadContext(id);
    await setBackupSettings(id, settings);
    return backupStatus(id);
  });
}
