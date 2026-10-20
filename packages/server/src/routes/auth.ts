import type { FastifyInstance } from "fastify";
import type { AuthInfo } from "@blockpilot/shared";
import { authRequired, isAuthenticated } from "../lib/auth.js";

export async function authRoutes(app: FastifyInstance) {
  /** 인증 없이 호출 가능. 프론트가 로그인 화면을 띄울지 판단하는 용도. */
  app.get("/api/auth", async (req): Promise<AuthInfo> => {
    return { required: authRequired(), authenticated: isAuthenticated(req) };
  });
}
