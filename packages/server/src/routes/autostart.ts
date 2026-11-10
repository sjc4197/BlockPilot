import type { FastifyInstance } from "fastify";
import { AutostartUpdate, type AutostartInfo } from "@blockpilot/shared";
import { HttpError } from "../lib/errors.js";
import { AutostartError, autostartInfo, setAutostart } from "../services/platform/autostart/index.js";

/** 로그인 때 BlockPilot 자동 실행 (이 컴퓨터의 로그인 항목) */
export async function autostartRoutes(app: FastifyInstance) {
  app.get("/api/autostart", async (): Promise<AutostartInfo> => autostartInfo());

  app.put("/api/autostart", async (req): Promise<AutostartInfo> => {
    const { enabled } = AutostartUpdate.parse(req.body ?? {});
    try {
      const info = await setAutostart(enabled);
      req.log.info({ enabled, method: info.method }, enabled ? "로그인 자동 실행을 켰어요" : "로그인 자동 실행을 껐어요");
      return info;
    } catch (e) {
      if (e instanceof AutostartError) throw new HttpError(500, "autostart_failed", e.detail ? `${e.message}\n${e.detail}` : e.message);
      throw e;
    }
  });
}
