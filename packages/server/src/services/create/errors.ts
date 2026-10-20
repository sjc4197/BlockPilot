/**
 * 새 서버 만들기 과정의 오류. message/hint 는 화면에 그대로 보여 주는 한글 문장이다.
 * - message: 무슨 일이 있었는지
 * - hint: 사용자가 할 수 있는 일
 * - detail: 원문 오류, 로그 마지막 줄 등 (접어서 보여 줌)
 */
export type CreateErrorCode =
  | "unsupported_platform"
  | "invalid_path"
  | "folder_not_empty"
  | "eula_required"
  | "busy"
  | "nickname_not_found"
  | "network"
  | "not_found"
  | "http_error"
  | "hash_mismatch"
  | "disk_full"
  | "no_permission"
  | "port_in_use"
  | "memory"
  | "java_failed"
  | "installer_failed"
  | "server_exited"
  | "first_run_timeout"
  | "cancelled"
  | "interrupted"
  | "internal";

export class CreateError extends Error {
  constructor(
    public code: CreateErrorCode,
    message: string,
    public hint?: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "CreateError";
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, detail: this.detail };
  }
}

const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** 알 수 없는 오류를 사용자에게 보여 줄 수 있는 CreateError 로 바꾼다 */
export function toCreateError(e: unknown, ctx: { url?: string; path?: string } = {}): CreateError {
  if (e instanceof CreateError) return e;
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.code ?? err?.cause?.code;
  const raw = [err?.message, err?.cause?.message].filter(Boolean).join(" / ");

  if (err?.name === "AbortError" || code === "ABORT_ERR") {
    return new CreateError("cancelled", "만들기를 취소했어요.");
  }
  if (code && NETWORK_CODES.has(code)) {
    const host = ctx.url ? safeHost(ctx.url) : undefined;
    return new CreateError("network", host ? `${host} 에 연결하지 못했어요.` : "인터넷에 연결하지 못했어요.", "인터넷 연결을 확인한 뒤 다시 시도해 주세요.", raw || code);
  }
  if (code === "ENOSPC") {
    return new CreateError("disk_full", "디스크 공간이 부족해요.", "필요 없는 파일을 지워 공간을 확보한 뒤 다시 시도해 주세요.", raw);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new CreateError("no_permission", `${ctx.path ? `'${ctx.path}' ` : ""}폴더에 파일을 쓸 권한이 없어요.`, "다른 폴더를 고르거나, Finder 에서 폴더 권한을 확인해 주세요.", raw);
  }
  // fetch 가 "fetch failed" 로 감싸는 네트워크 오류
  if (err?.message === "fetch failed") {
    const host = ctx.url ? safeHost(ctx.url) : undefined;
    return new CreateError("network", host ? `${host} 에 연결하지 못했어요.` : "인터넷에 연결하지 못했어요.", "인터넷 연결을 확인한 뒤 다시 시도해 주세요.", raw);
  }
  return new CreateError("internal", "예상하지 못한 오류가 났어요.", "다시 시도해 보고, 계속되면 아래 상세 내용을 알려 주세요.", raw || String(e));
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
