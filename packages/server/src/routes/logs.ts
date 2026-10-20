import type { FastifyInstance } from "fastify";
import { listLogs, readLog } from "../services/logs.js";
import { loadContext } from "../lib/context.js";

export async function logsRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/logs", async (req) => {
    const { id } = req.params as { id: string };
    const { dir } = await loadContext(id);
    return listLogs(dir);
  });

  app.get("/api/servers/:id/logs/:kind/:name", async (req) => {
    const { id, kind, name } = req.params as { id: string; kind: string; name: string };
    const { tail } = req.query as { tail?: string };
    const { dir } = await loadContext(id);
    return readLog(dir, kind === "crash" ? "crash" : "log", name, tail ? Number(tail) : undefined);
  });
}
