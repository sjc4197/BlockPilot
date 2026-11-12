import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { badRequest, notFound } from "../lib/errors.js";
import { BUNDLE_NAME, DEBUG_DIR, buildDebugBundle, pruneOldBundles } from "../services/debugBundle.js";

/**
 * 문제 신고 파일.
 * - POST /api/debug/bundle → 만들고 { fileName, sizeBytes, downloadPath }
 * - GET  /api/debug/bundle/:fileName → zip 내려받기 (다운로드 링크라 ?token= 허용: lib/auth.ts DOWNLOAD_PATHS)
 * 두 경로 모두 한 시간 지난 파일을 치운다.
 */
export async function debugRoutes(app: FastifyInstance) {
  app.post("/api/debug/bundle", async () => {
    await pruneOldBundles();
    const b = await buildDebugBundle();
    app.log.info({ file: b.fileName, sizeBytes: b.sizeBytes, entries: b.entries.length }, "문제 신고 파일을 만들었어요");
    return { fileName: b.fileName, sizeBytes: b.sizeBytes, entries: b.entries, downloadPath: `/api/debug/bundle/${b.fileName}` };
  });

  app.get("/api/debug/bundle/:fileName", async (req, reply) => {
    const { fileName } = req.params as { fileName: string };
    if (!BUNDLE_NAME.test(fileName)) throw badRequest("올바르지 않은 파일 이름입니다.");
    await pruneOldBundles();
    const full = path.join(DEBUG_DIR, fileName);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) throw notFound("문제 신고 파일이 없어요. 다시 만들어 주세요 (한 시간이 지나면 지워져요).");
    reply.header("content-type", "application/zip");
    reply.header("content-length", st.size);
    reply.header("content-disposition", `attachment; filename="${fileName}"`);
    return reply.send(createReadStream(full));
  });
}
