import type { FastifyInstance } from "fastify";
import { UpdateModInput } from "@blockpilot/shared";
import { listMods, setModEnabled, deleteMod, saveUploadedMod, buildClientModsZip } from "../services/mods.js";
import { detectServer } from "../services/serverInfo.js";
import { buildMrpack } from "../services/modpackExport.js";
import { loadContext } from "../lib/context.js";
import { badRequest, conflict } from "../lib/errors.js";

/**
 * 첨부 파일 이름 헤더. filename* 은 RFC 5987 (encodeURIComponent 가 남기는 ' ( ) * 까지 인코딩),
 * filename 은 따옴표·비ASCII 를 못 쓰는 오래된 클라이언트를 위한 ASCII 이름
 */
export function attachmentHeader(fileName: string, asciiFallback: string): string {
  const star = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const ascii = asciiFallback.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

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
    reply.header("content-disposition", attachmentHeader(name, "client-mods.zip"));
    return reply.send(stream);
  });

  /** 친구용 Modrinth 모드팩(.mrpack). ?config=1 이면 config/ 도 (비밀처럼 보이는 파일은 빼고) */
  app.get("/api/servers/:id/mods/export.mrpack", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { config } = req.query as { config?: string };
    const { server, dir } = await loadContext(id);
    const includeConfig = config === "1" || config === "true";
    const { stream, fileName, stats, offline, versionId, excluded } = await buildMrpack({ dir, name: server.name, includeConfig });
    if (!stats.modrinth && !stats.bundled) throw badRequest("내보낼 모드가 없어요.");
    reply.header("content-type", "application/x-modrinth-modpack+zip");
    reply.header("content-disposition", attachmentHeader(fileName, `modpack-${versionId}.mrpack`));
    if (offline) reply.header("x-blockpilot-note", "modrinth-offline");
    // 비밀이 있어 보여 뺀 설정 파일 수 (README.txt 에 목록)
    if (includeConfig) reply.header("x-blockpilot-excluded", String(excluded.length));
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
