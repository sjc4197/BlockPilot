import type { FastifyInstance } from "fastify";
import { loadContext } from "../lib/context.js";
import { readStats } from "../services/stats.js";

export async function statsRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/stats", async (req) => {
    const { id } = req.params as { id: string };
    const { dir } = await loadContext(id);
    return readStats(id, dir);
  });
}
