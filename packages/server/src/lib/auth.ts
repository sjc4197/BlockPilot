import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAuthToken, setAuthToken } from "../config/store.js";

/**
 * 토큰 인증.
 * - BLOCKPILOT_TOKEN 환경변수 > config.json 의 auth.token
 * - 루프백(127.0.0.1)에만 바인딩하고 토큰이 설정되어 있지 않으면 인증 없음
 * - 외부 주소에 바인딩하면 토큰이 없을 때 자동 생성해서 로그에 출력
 */

let required = false;
let token: string | null = null;

export async function initAuth(app: FastifyInstance, host: string) {
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  token = process.env.BLOCKPILOT_TOKEN ?? (await getAuthToken());
  if (!token && !loopback) {
    token = randomBytes(24).toString("base64url");
    await setAuthToken(token);
    app.log.warn(`외부 주소(${host})에 바인딩: 접속 토큰을 생성했습니다 → ${token}`);
  }
  required = !!token;
  if (required) app.log.info("토큰 인증이 켜져 있습니다. 대시보드에서 토큰을 입력하세요.");

  app.addHook("onRequest", async (req, reply) => {
    if (!required) return;
    if (!req.url.startsWith("/api/")) return;
    if (req.url === "/api/auth" && req.method === "GET") return;
    if (!isAuthenticated(req)) {
      return reply.code(401).send({ error: "unauthorized", message: "인증 토큰이 필요합니다." });
    }
  });
}

export const authRequired = () => required;

export function isAuthenticated(req: FastifyRequest): boolean {
  if (!required || !token) return true;
  const header = req.headers.authorization;
  let candidate: string | undefined;
  if (header?.startsWith("Bearer ")) candidate = header.slice(7);
  else {
    // WebSocket 은 헤더를 못 붙이므로 ?token= 허용
    const url = new URL(req.url, "http://x");
    candidate = url.searchParams.get("token") ?? undefined;
  }
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
