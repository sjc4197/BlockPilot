import type { FastifyInstance } from "fastify";
import { badRequest } from "../lib/errors.js";
import { listModpackVersions, searchModpacks } from "../services/modrinthModpack.js";

/** 새 서버 만들기의 "Modrinth 모드팩" 탭: 검색과 버전 목록. 업로드·검사는 routes/create.ts */
export async function modpackRoutes(app: FastifyInstance) {
  app.get("/api/create/modpack/search", async (req) => {
    const { q = "", offset = "0" } = req.query as { q?: string; offset?: string };
    return searchModpacks(String(q).slice(0, 100), Math.min(10_000, Math.max(0, Math.floor(Number(offset) || 0))));
  });

  app.get("/api/create/modpack/versions", async (req) => {
    const { project } = req.query as { project?: string };
    if (typeof project !== "string" || !/^[\w-]{1,64}$/.test(project)) throw badRequest("모드팩을 골라 주세요.");
    return listModpackVersions(project);
  });
}
