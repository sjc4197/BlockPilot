import type { FastifyInstance } from "fastify";
import { loadContext } from "../lib/context.js";
import { conflict } from "../lib/errors.js";
import { detectServer } from "../services/serverInfo.js";
import { applyUpdates, findUpdates, install, search } from "../services/modrinth.js";

async function target(id: string) {
  const { dir, managed } = await loadContext(id);
  const info = await detectServer(dir);
  return { t: { dir, loader: info.loader, mcVersion: info.mcVersion }, managed };
}
async function assertStopped(managed: Awaited<ReturnType<typeof target>>["managed"]) {
  if ((await managed.status()).state !== "stopped") throw conflict("서버를 끈 뒤에 설치·업데이트할 수 있어요.");
}

export async function modrinthRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/modrinth/search", async (req) => {
    const { id } = req.params as { id: string };
    const { q = "", offset = "0" } = req.query as { q?: string; offset?: string };
    const { t } = await target(id);
    return search(t, String(q).slice(0, 100), Math.max(0, Number(offset) || 0));
  });

  app.post("/api/servers/:id/modrinth/install", async (req) => {
    const { id } = req.params as { id: string };
    const { projectId, allowClientOnly } = (req.body ?? {}) as { projectId?: string; allowClientOnly?: boolean };
    const { t, managed } = await target(id);
    await assertStopped(managed);
    if (!projectId || !/^[\w-]{1,64}$/.test(projectId)) throw conflict("프로젝트가 올바르지 않아요.");
    return install(t, projectId, { allowClientOnly: allowClientOnly === true });
  });

  app.get("/api/servers/:id/modrinth/updates", async (req) => {
    const { id } = req.params as { id: string };
    const { t } = await target(id);
    return findUpdates(t);
  });

  app.post("/api/servers/:id/modrinth/update", async (req) => {
    const { id } = req.params as { id: string };
    const { files } = (req.body ?? {}) as { files?: string[] };
    const { t, managed } = await target(id);
    await assertStopped(managed);
    return applyUpdates(t, Array.isArray(files) ? files.map(String) : []);
  });
}
