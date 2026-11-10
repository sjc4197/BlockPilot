import type { FastifyInstance } from "fastify";
import { P2pJoinInput } from "@blockpilot/shared";
import { forgetRemembered, joinView, startJoin, stopJoin } from "../services/p2p/join.js";

/** 친구 서버에 접속 (참가 모드). 서버 등록과 무관한 앱 전역 기능 */
export async function joinRoutes(app: FastifyInstance) {
  app.get("/api/join", async () => joinView());

  app.post("/api/join", async (req) => {
    const { inviteCode, name } = P2pJoinInput.parse(req.body ?? {});
    // 초대코드는 로그에 남기지 않는다
    req.log.info({ name }, "친구 서버 접속 시도");
    return startJoin(inviteCode, name);
  });

  app.post("/api/join/stop", async () => stopJoin());

  app.delete("/api/join/remembered", async () => forgetRemembered());
}
