import type { FastifyInstance } from "fastify";

/**
 * 모든 응답에 붙이는 보안 헤더.
 *  - frame-ancestors 'none' / X-Frame-Options DENY: 다른 사이트의 iframe 안에 대시보드를 못 넣게 (클릭재킹)
 *    CSP 는 이 지시어 하나만 — script-src·style-src 까지 걸면 Vite 가 번들한 인라인 스타일·폰트가 깨진다
 *  - nosniff: 업로드·백업 파일을 브라우저가 멋대로 HTML 로 해석하지 않게
 *  - no-referrer: 대시보드 URL 이 외부 링크(Modrinth 등)로 새지 않게
 */
export function installSecurityHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Content-Security-Policy", "frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
  });
}
