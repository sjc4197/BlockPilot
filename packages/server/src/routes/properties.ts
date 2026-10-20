import type { FastifyInstance } from "fastify";
import {
  UpdatePropertiesInput,
  PROPERTY_META_BY_KEY,
  type PropertiesResponse,
  type UpdatePropertiesResult,
} from "@blockpilot/shared";
import { readPropertiesFile, validatePropertyChange, writePropertiesChanges } from "../services/properties.js";
import { loadContext } from "../lib/context.js";

export async function propertiesRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/properties", async (req): Promise<PropertiesResponse> => {
    const { id } = req.params as { id: string };
    const { dir } = await loadContext(id);
    const { lines, mtime } = await readPropertiesFile(dir);
    return {
      entries: lines.filter((l) => l.kind === "entry").map((l) => ({ key: l.key, value: l.value })),
      mtime,
    };
  });

  app.put("/api/servers/:id/properties", async (req): Promise<UpdatePropertiesResult> => {
    const { id } = req.params as { id: string };
    const { changes } = UpdatePropertiesInput.parse(req.body);
    const { dir, managed } = await loadContext(id);

    for (const [key, value] of Object.entries(changes)) validatePropertyChange(key, value);

    // 파일에는 항상 저장 (다음 시작 때 반영되도록). 실행 중이면 가능한 것은 명령으로 즉시 반영.
    await writePropertiesChanges(dir, changes);
    const status = await managed.status();
    const result: UpdatePropertiesResult = { saved: Object.keys(changes), appliedLive: [], needsRestart: [] };
    if (status.state === "running" || status.state === "external") {
      for (const [key, value] of Object.entries(changes)) {
        const meta = PROPERTY_META_BY_KEY[key];
        if (meta?.liveCommand && (await managed.tryCommand(meta.liveCommand(value)).catch(() => false))) result.appliedLive.push(key);
        else result.needsRestart.push(key);
      }
    }
    return result;
  });
}
