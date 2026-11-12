import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAuthToken, setAuthToken } from "../config/store.js";

/**
 * 토큰 인증.
 * - BLOCKPILOT_TOKEN 환경변수 > config.json 의 auth.token
 * - 루프백(127.0.0.1)에만 바인딩하고 토큰이 설정되어 있지 않으면 인증 없음
 * - 외부 주소에 바인딩하면 토큰이 없을 때 자동 생성해서 터미널에만 출력 (앱 로그 파일에는 토큰을 남기지 않는다)
 *
 * 토큰을 받는 자리:
 *  - 일반 API: `Authorization: Bearer <토큰>`
 *  - WebSocket(콘솔): 브라우저는 업그레이드 요청에 헤더를 못 붙이므로 서브프로토콜로 보낸다.
 *    `new WebSocket(url, ["blockpilot", "bp.token.<base64url(토큰)>"])` → 서버(ws)는 첫 번째 "blockpilot" 을 골라 돌려준다.
 *    (전엔 ?token= 쿼리였는데 URL 은 접근 로그·브라우저 기록에 남아서 뺐다)
 *  - 다운로드 링크(<a href>): 헤더를 못 붙이는 유일한 곳이라 아래 DOWNLOAD_PATHS 에만 ?token= 을 허용
 */

/** 서브프로토콜 이름: 웹(client.ts wsProtocols) 과 같아야 한다 */
export const WS_PROTOCOL = "blockpilot";
export const WS_TOKEN_PREFIX = "bp.token.";
/** ?token= 쿼리를 받아 주는 GET 경로 (브라우저가 그냥 여는 다운로드 링크) */
const DOWNLOAD_PATHS = [/^\/api\/servers\/[^/]+\/backups\/[^/]+\/download$/, /^\/api\/servers\/[^/]+\/mods\/export$/, /^\/api\/debug\/bundle\/[^/]+$/];

/**
 * 토큰 무차별 대입 제한: 같은 IP 에서 10분 안에 서로 다른 틀린 토큰을 5개 내밀면 그다음부터 429.
 * "시도 횟수" 가 아니라 "서로 다른 틀린 토큰 수" 를 세는 이유: 대시보드는 한 화면에서 요청을 여러 개 동시에 보내므로
 * 저장된 토큰이 오래된 것이면(서버가 토큰을 새로 만든 뒤 등) 한 번의 화면 로드만으로 자기 IP 를 잠가 버린다.
 * 무차별 대입은 어차피 매번 다른 토큰을 내밀어야 하니 막히는 건 같다. 토큰 없이 온 요청은 추측이 아니므로 세지 않는다.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
/** 기억하는 IP 수 상한 (넘치면 가장 오래된 것부터 버림) */
const MAX_TRACKED_IPS = 1000;
const failures = new Map<string, { tokens: Set<string>; firstAt: number }>();

let required = false;
let token: string | null = null;

export async function initAuth(app: FastifyInstance, host: string) {
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  token = process.env.BLOCKPILOT_TOKEN ?? (await getAuthToken());
  if (!token && !loopback) {
    token = randomBytes(24).toString("base64url");
    await setAuthToken(token);
    // 토큰 자체는 터미널에만. app.log 는 파일(logs/blockpilot.log)에도 남고 문제 신고 파일에 그대로 들어가므로 토큰을 적지 않는다
    console.log(`외부 주소(${host})에 바인딩: 접속 토큰을 생성했습니다 → ${token}`);
    app.log.warn(`외부 주소(${host})에 바인딩: 새 토큰을 만들어 config.json 에 저장했어요. 토큰은 터미널 출력에서 확인하세요`);
  }
  required = !!token;
  if (required) app.log.info("토큰 인증이 켜져 있습니다. 대시보드에서 토큰을 입력하세요.");

  app.addHook("onRequest", async (req, reply) => {
    if (!required) return;
    if (!req.url.startsWith("/api/")) return;
    const candidate = extractToken(req);
    // GET /api/auth 는 토큰 없이도 열려 있다 (로그인 화면을 띄울지 판단용). 단 토큰을 내밀고 틀린 건 똑같이 센다 —
    // 로그인 화면이 여기로 토큰을 확인하므로, 안 세면 이 경로로 무차별 대입이 된다
    const probe = req.url === "/api/auth" && req.method === "GET";
    if (probe && candidate === undefined) return;
    // 대시보드를 LAN 에 열어 둘 수 있으므로 루프백도 예외 없이 제한한다. 잠긴 동안엔 맞는 토큰도 거절
    if (candidate !== undefined && isLockedOut(req.ip)) {
      return reply.code(429).send({ error: "too_many_attempts", message: "토큰을 너무 많이 틀렸습니다. 10분 뒤에 다시 시도하세요." });
    }
    if (!matches(candidate)) {
      if (candidate !== undefined) recordFailure(req.ip, candidate);
      if (probe) return; // 라우트가 authenticated:false 로 답한다
      return reply.code(401).send({ error: "unauthorized", message: "인증 토큰이 필요합니다." });
    }
    failures.delete(req.ip);
  });
}

export const authRequired = () => required;

export function isAuthenticated(req: FastifyRequest): boolean {
  return matches(extractToken(req));
}

function matches(candidate: string | undefined): boolean {
  if (!required || !token) return true;
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);

  if (isWebSocketUpgrade(req)) return tokenFromSubprotocol(req.headers["sec-websocket-protocol"]);

  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && DOWNLOAD_PATHS.some((p) => p.test(url.pathname))) return url.searchParams.get("token") ?? undefined;
  return undefined;
}

function isWebSocketUpgrade(req: FastifyRequest): boolean {
  return (req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

/** "blockpilot, bp.token.c2VjcmV0" 에서 토큰을 꺼낸다 (base64url 로 감싼 건 서브프로토콜에 못 쓰는 글자가 토큰에 있을 수 있어서) */
function tokenFromSubprotocol(header: string | string[] | undefined): string | undefined {
  if (!header) return undefined;
  const list = (Array.isArray(header) ? header.join(",") : header).split(",").map((s) => s.trim());
  const entry = list.find((p) => p.startsWith(WS_TOKEN_PREFIX));
  if (!entry) return undefined;
  const encoded = entry.slice(WS_TOKEN_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function isLockedOut(ip: string): boolean {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.tokens.size >= MAX_FAILURES;
}

function recordFailure(ip: string, candidate: string) {
  const now = Date.now();
  let entry = failures.get(ip);
  if (entry && now - entry.firstAt > WINDOW_MS) {
    failures.delete(ip);
    entry = undefined;
  }
  if (!entry) {
    if (failures.size >= MAX_TRACKED_IPS) {
      // 만료된 것부터 치우고, 그래도 가득 차면 가장 오래된(먼저 들어온) 항목을 버린다
      for (const [k, v] of failures) if (now - v.firstAt > WINDOW_MS) failures.delete(k);
      if (failures.size >= MAX_TRACKED_IPS) failures.delete(failures.keys().next().value!);
    }
    entry = { tokens: new Set(), firstAt: now };
    failures.set(ip, entry);
  }
  // 틀린 토큰 자체를 들고 있지 않도록 해시만, 잠길 만큼만 (IP 당 최대 5개)
  if (entry.tokens.size < MAX_FAILURES) entry.tokens.add(createHash("sha256").update(candidate).digest("base64"));
}

/** 테스트용: 실패 기록 초기화 */
export function resetAuthFailures() {
  failures.clear();
}
