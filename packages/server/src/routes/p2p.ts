import type { FastifyInstance } from "fastify";
import { p2pSupport } from "../services/p2p/native.js";

/** 포트포워딩 없는 친구 초대 (P2P 터널). 1단계: 지원 여부만 (실행 파일에서 네이티브 모듈이 뜨는지 스모크 테스트용) */
export async function p2pRoutes(app: FastifyInstance) {
  app.get("/api/p2p/support", async () => p2pSupport());
}
