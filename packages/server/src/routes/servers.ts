import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { DeleteServerInput, RegisterServerInput, type DeleteServerResult, type ServerSummary } from "@blockpilot/shared";
import { addServer, listServers, removeServer } from "../config/store.js";
import { forgetPlaytime } from "../services/stats.js";
import { detectServer, getServerJavaVersion, validateServerDir } from "../services/serverInfo.js";
import { readPropertiesFile, toRecord } from "../services/properties.js";
import { modsDirName } from "../services/mods.js";
import { deleteServerFolder } from "../services/serverDelete.js";
import { loadContext } from "../lib/context.js";
import { conflict } from "../lib/errors.js";

export async function serversRoutes(app: FastifyInstance) {
  app.get("/api/servers", async () => listServers());

  app.post("/api/servers", async (req, reply) => {
    const input = RegisterServerInput.parse(req.body);
    const dir = await validateServerDir(input.path);
    const server = await addServer({ path: dir, name: input.name ?? path.basename(dir) });
    reply.code(201);
    return server;
  });

  app.delete("/api/servers/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { managed } = await loadContext(id);
    if (managed.isManaged()) throw conflict("실행 중인 서버는 먼저 중지해야 합니다.");
    await removeServer(id);
    await forgetPlaytime(id);
    return { ok: true };
  });

  /** 서버 폴더를 디스크에서 완전히 지운다 (등록 해제와 다름, 되돌릴 수 없음) */
  app.post("/api/servers/:id/delete", async (req): Promise<DeleteServerResult> => {
    const { id } = req.params as { id: string };
    const { confirmName } = DeleteServerInput.parse(req.body ?? {});
    const { server, managed } = await loadContext(id);
    const result = await deleteServerFolder(server, managed, confirmName);
    req.log.warn({ server: server.name, deleted: result.deletedPath }, "서버 폴더를 삭제했어요");
    return result;
  });

  app.get("/api/servers/:id", async (req): Promise<ServerSummary> => {
    const { id } = req.params as { id: string };
    const { server, dir, managed } = await loadContext(id);
    const exists = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false);
    const info = await detectServer(dir);
    const [{ lines }, processStatus, javaVersion, modFiles] = await Promise.all([
      readPropertiesFile(dir),
      managed.status(),
      getServerJavaVersion(dir),
      fs.readdir(path.join(dir, modsDirName(info.loader))).catch(() => [] as string[]),
    ]);
    const p = toRecord(lines);
    return {
      ...server,
      exists,
      loader: info.loader,
      loaderVersion: info.loaderVersion,
      mcVersion: info.mcVersion,
      levelName: p["level-name"] ?? "world",
      eulaAccepted: info.eulaAccepted,
      hasStartScript: info.hasStartScript,
      startScript: info.startScript,
      foreignScript: info.foreignScript,
      javaVersion,
      modCount: modFiles.filter((f) => f.endsWith(".jar")).length,
      process: processStatus,
      properties: {
        motd: p["motd"] ?? "",
        port: Number(p["server-port"] ?? 25565),
        difficulty: p["difficulty"] ?? "easy",
        gamemode: p["gamemode"] ?? "survival",
        maxPlayers: Number(p["max-players"] ?? 20),
        whitelist: p["white-list"] === "true",
      },
    };
  });
}
