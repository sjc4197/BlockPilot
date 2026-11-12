export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** 사용자가 할 수 있는 일 (새 서버 만들기 오류 등) */
    public hint?: string,
    public detail?: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "blockpilot.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode 등 */
  }
}

/** 토큰이 있으면 URL에 붙인다 — 헤더를 못 붙이는 다운로드 링크(<a href>) 전용. 서버도 그 경로에서만 ?token= 을 받는다 */
export function withToken(url: string): string {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

/**
 * WebSocket 용 서브프로토콜 목록. 브라우저는 업그레이드 요청에 헤더를 못 붙이므로 토큰을 Sec-WebSocket-Protocol 로 보낸다.
 * ["blockpilot", "bp.token.<base64url(토큰)>"] — 서버(lib/auth.ts)는 첫 번째 "blockpilot" 을 골라 돌려주고 두 번째에서 토큰을 읽는다.
 * (토큰에 서브프로토콜로 못 쓰는 글자가 있을 수 있어 base64url 로 감싼다)
 */
export function wsProtocols(): string[] {
  const t = getToken();
  if (!t) return ["blockpilot"];
  const bytes = new TextEncoder().encode(t);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64url = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return ["blockpilot", "bp.token." + b64url];
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const token = getToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers, body });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiRequestError(res.status, data?.error ?? "error", data?.message ?? `요청 실패 (${res.status})`, data?.hint, data?.detail);
  }
  return data as T;
}
