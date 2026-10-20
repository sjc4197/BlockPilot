import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { RegisterServerInput, type ServerSummary } from "@blockpilot/shared";
import { addServer, listServers, removeServer } from "../config/store.js";
import { detectServer, getJavaVersion, validateServerDir } from "../services/serverInfo.js";
import { readPropertiesFile, toRecord } from "../services/properties.js";
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
    return { ok: true };
  });

  app.get("/api/servers/:id", async (req): Promise<ServerSummary> => {
    const { id } = req.params as { id: string };
    const { server, dir, managed } = await loadContext(id);
    const exists = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false);
    const [info, { lines }, processStatus, javaVersion, modFiles] = await Promise.all([
      detectServer(dir),
      readPropertiesFile(dir),
      managed.status(),
      getJavaVersion(),
      fs.readdir(path.join(dir, "mods")).catch(() => [] as string[]),
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
