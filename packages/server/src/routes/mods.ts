import type { FastifyInstance } from "fastify";
import { UpdateModInput } from "@blockpilot/shared";
import { listMods, setModEnabled, deleteMod, saveUploadedMod, buildClientModsZip } from "../services/mods.js";
import { detectServer } from "../services/serverInfo.js";
import { loadContext } from "../lib/context.js";
import { badRequest, conflict } from "../lib/errors.js";

export async function modsRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/mods", async (req) => {
    const { id } = req.params as { id: string };
    const { dir } = await loadContext(id);
    const info = await detectServer(dir);
    return listMods(dir, info.mcVersion, info.loader);
  });

  /** 친구용 클라이언트 모드 zip */
  app.get("/api/servers/:id/mods/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { server, dir } = await loadContext(id);
    const info = await detectServer(dir);
    const { stream, files } = await buildClientModsZip(dir, info.mcVersion, info.loader);
    if (!files.length) throw badRequest("내보낼 클라이언트 모드가 없습니다.");
    const name = `${server.name}-client-mods.zip`;
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(stream);
  });

  app.patch("/api/servers/:id/mods/:file", async (req) => {
    const { id, file } = req.params as { id: string; file: string };
    const { enabled } = UpdateModInput.parse(req.body);
    const { dir, managed } = await loadContext(id);
    await assertStopped(managed);
    const info = await detectServer(dir);
    const newFile = await setModEnabled(dir, file, enabled, info.loader);
    return { file: newFile, enabled };
  });

  app.delete("/api/servers/:id/mods/:file", async (req) => {
    const { id, file } = req.params as { id: string; file: string };
    const { dir, managed } = await loadContext(id);
    await assertStopped(managed);
    const info = await detectServer(dir);
    await deleteMod(dir, file, info.loader);
    return { ok: true };
  });

  app.post("/api/servers/:id/mods", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dir, managed } = await loadContext(id);
    await assertStopped(managed);
    const info = await detectServer(dir);
    const saved: string[] = [];
    for await (const part of req.files({ limits: { fileSize: 200 * 1024 * 1024 } })) {
      const buf = await part.toBuffer();
      if (!buf.length) throw badRequest("빈 파일입니다.");
      await saveUploadedMod(dir, part.filename, buf, info.loader);
      saved.push(part.filename);
    }
    if (!saved.length) throw badRequest("업로드된 파일이 없습니다.");
    reply.code(201);
    return { saved };
  });
}

async function assertStopped(managed: { status(): Promise<{ state: string }> }) {
  const { state } = await managed.status();
  if (state !== "stopped") throw conflict("모드 변경은 서버가 중지된 상태에서만 가능합니다.");
}
