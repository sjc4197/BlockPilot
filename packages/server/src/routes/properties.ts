import type { FastifyInstance } from "fastify";
import {
  UpdatePropertiesInput,
  PROPERTY_META_BY_KEY,
  type PropertiesResponse,
  type UpdatePropertiesResult,
} from "@blockpilot/shared";
import { readPropertiesFile, writePropertiesChanges } from "../services/properties.js";
import { loadContext } from "../lib/context.js";
import { badRequest } from "../lib/errors.js";

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

    for (const [key, value] of Object.entries(changes)) validate(key, value);

    // 파일에는 항상 저장 (다음 시작 때 반영되도록). 실행 중이면 가능한 것은 명령으로 즉시 반영.
    await writePropertiesChanges(dir, changes);
    const status = await managed.status();
    const result: UpdatePropertiesResult = { saved: Object.keys(changes), appliedLive: [], needsRestart: [] };
    if (status.state === "running") {
      for (const [key, value] of Object.entries(changes)) {
        const meta = PROPERTY_META_BY_KEY[key];
        if (meta?.liveCommand && managed.tryCommand(meta.liveCommand(value))) result.appliedLive.push(key);
        else result.needsRestart.push(key);
      }
    } else if (status.state === "external") {
      result.needsRestart.push(...Object.keys(changes));
    }
    return result;
  });
}

function validate(key: string, value: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw badRequest(`잘못된 키: ${key}`);
  if (/[\r\n]/.test(value)) throw badRequest(`값에 줄바꿈을 넣을 수 없습니다: ${key}`);
  const meta = PROPERTY_META_BY_KEY[key];
  if (!meta) return;
  switch (meta.type) {
    case "boolean":
      if (value !== "true" && value !== "false") throw badRequest(`${meta.label}: true/false 만 가능`);
      break;
    case "enum":
      if (!meta.options.some((o) => o.value === value)) throw badRequest(`${meta.label}: 허용되지 않는 값 '${value}'`);
      break;
    case "int": {
      if (!/^-?\d+$/.test(value)) throw badRequest(`${meta.label}: 정수만 가능`);
      const n = Number(value);
      if (meta.min !== undefined && n < meta.min) throw badRequest(`${meta.label}: 최소 ${meta.min}`);
      if (meta.max !== undefined && n > meta.max) throw badRequest(`${meta.label}: 최대 ${meta.max}`);
      break;
    }
  }
}
