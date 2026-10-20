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

/** 토큰이 있으면 URL에 붙인다 (WebSocket, 다운로드 링크용) */
export function withToken(url: string): string {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
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
