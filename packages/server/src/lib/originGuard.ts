import type { FastifyInstance } from "fastify";

/**
 * 브라우저에서 오는 교차 출처 요청 차단.
 *
 * 대시보드는 API 와 같은 출처(같은 호스트:포트)에서 서빙되므로 교차 출처 요청은 전부 거부해도 된다.
 * CORS 만으로는 부족한 이유:
 *  - WebSocket 은 CORS 의 보호를 받지 않는다 → 악성 페이지가 콘솔 소켓에 붙어 명령을 보낼 수 있음
 *  - DNS 리바인딩: 공격자 도메인이 127.0.0.1 을 가리키게 하면 Origin 검사가 무의미 → Host 헤더도 함께 검사
 *
 * 규칙 (/api/* 에만 적용):
 *  1. Host 헤더의 호스트명이 허용 목록(루프백 또는 바인딩 주소)에 없으면 403
 *  2. Origin 헤더가 있으면 그 호스트:포트가 Host 헤더와 같아야 함 (curl 등 Origin 없는 요청은 통과)
 */
export function installOriginGuard(app: FastifyInstance, bindHost: string, devOrigins: string[] = []) {
  const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const allowedHostnames = new Set([...loopbackNames, bindHost.toLowerCase()]);
  const extraOrigins = new Set(devOrigins.map((o) => o.toLowerCase()));

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;

    const host = (req.headers.host ?? "").toLowerCase();
    const hostname = hostnameOf(host);
    // 0.0.0.0 처럼 임의 주소에 바인딩한 경우는 Host 검사를 건너뛴다 (어떤 IP 로 올지 모름). 그땐 토큰 인증이 지킨다.
    const anyAddress = bindHost === "0.0.0.0" || bindHost === "::";
    if (!anyAddress && !allowedHostnames.has(hostname)) {
      return reply.code(403).send({ error: "forbidden", message: "허용되지 않은 Host 헤더입니다." });
    }

    const origin = req.headers.origin;
    if (origin === undefined) return;
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return reply.code(403).send({ error: "forbidden", message: "잘못된 Origin 입니다." });
    }
    if (originHost !== host && !extraOrigins.has(origin.toLowerCase())) {
      req.log.warn({ origin, host }, "교차 출처 요청 차단");
      return reply.code(403).send({ error: "forbidden", message: "다른 출처에서 온 요청은 허용되지 않습니다." });
    }
  });
}

function hostnameOf(host: string): string {
  // "[::1]:4800" → "[::1]", "127.0.0.1:4800" → "127.0.0.1"
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0];
}
