import type { FastifyInstance } from "fastify";
import { SaveConfigFileInput } from "@blockpilot/shared";
import { listConfigFiles, readConfigFile, writeConfigFile, validate } from "../services/configs.js";
import { loadContext } from "../lib/context.js";
import { badRequest } from "../lib/errors.js";

export async function configsRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/configs", async (req) => {
    const { id } = req.params as { id: string };
    const { dir } = await loadContext(id);
    return listConfigFiles(dir);
  });

  app.get("/api/servers/:id/configs/file", async (req) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path?: string };
    if (!path) throw badRequest("path 가 필요합니다.");
    const { dir } = await loadContext(id);
    return readConfigFile(dir, path);
  });

  app.put("/api/servers/:id/configs/file", async (req) => {
    const { id } = req.params as { id: string };
    const { path, content } = SaveConfigFileInput.parse(req.body);
    const { dir } = await loadContext(id);
    await writeConfigFile(dir, path, content);
    return readConfigFile(dir, path);
  });

  /** 저장하지 않고 문법만 검사 */
  app.post("/api/servers/:id/configs/validate", async (req) => {
    const { path, content } = SaveConfigFileInput.parse(req.body);
    const ext = path.split(".").pop()?.toLowerCase();
    const format = ext === "toml" ? "toml" : ext === "json" || ext === "mcmeta" ? "json" : ext === "yml" || ext === "yaml" ? "yaml" : "text";
    return validate(format, content);
  });
}
