import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CreateError, toCreateError } from "./errors.js";
import { retryFs } from "../../lib/retry.js";

export type HashAlgo = "sha1" | "sha256";

export interface DownloadOptions {
  url: string;
  dest: string;
  hash: { algo: HashAlgo; expected: string };
  /** content-length 가 없을 때 진행률 계산에 쓰는 크기 */
  expectedSize?: number;
  onProgress?: (done: number, total?: number) => void;
  signal?: AbortSignal;
  /** 네트워크 오류 시 재시도 횟수 (해시 불일치·404 는 재시도하지 않음) */
  retries?: number;
  /** 이 시간 동안 데이터가 한 바이트도 안 오면 끊는다 */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_MS = 30_000;

/**
 * 파일을 받으면서 해시를 계산하고, 일치할 때만 dest 로 옮긴다.
 * 받는 중에는 dest + ".part" 에 쓰고, 실패하면 .part 를 지운다 (dest 는 절대 만들지 않음).
 */
export async function downloadFile(o: DownloadOptions): Promise<{ bytes: number; digest: string }> {
  const retries = o.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await downloadOnce(o);
    } catch (e) {
      const ce = toCreateError(e, { url: o.url });
      if (o.signal?.aborted) throw new CreateError("cancelled", "만들기를 취소했어요.");
      if (ce.code !== "network") throw ce;
      lastErr = ce;
      if (attempt < retries) await sleep(800 * (attempt + 1), o.signal);
    }
  }
  throw lastErr;
}

async function downloadOnce(o: DownloadOptions) {
  const part = o.dest + ".part";
  await fsp.mkdir(path.dirname(o.dest), { recursive: true });

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let idle: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error("idle timeout")), o.idleTimeoutMs ?? DEFAULT_IDLE_MS);
  };

  try {
    resetIdle();
    const res = await fetch(o.url, { signal: ctrl.signal, redirect: "follow" });
    if (res.status === 404) {
      throw new CreateError("not_found", "받아야 할 파일이 서버에 없어요.", "선택한 버전이 더 이상 배포되지 않을 수 있어요. 다른 버전을 골라 주세요.", o.url);
    }
    if (!res.ok || !res.body) {
      throw new CreateError("http_error", `파일을 받지 못했어요 (HTTP ${res.status}).`, "잠시 후 다시 시도해 주세요.", o.url);
    }
    const total = Number(res.headers.get("content-length")) || o.expectedSize;
    const hash = createHash(o.hash.algo);
    let done = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        done += chunk.length;
        resetIdle();
        o.onProgress?.(done, total);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), meter, fs.createWriteStream(part));

    const digest = hash.digest("hex");
    if (digest !== o.hash.expected.toLowerCase()) {
      throw new CreateError(
        "hash_mismatch",
        `받은 파일이 공식 해시와 달라요 (${path.basename(o.dest)}).`,
        "다운로드 중에 파일이 손상됐거나 바뀌었을 수 있어요. 다시 시도해 주세요. 계속 다르면 네트워크(프록시·VPN)를 확인해 주세요.",
        `${o.hash.algo} 기대값 ${o.hash.expected}\n${o.hash.algo} 실제값 ${digest}\n${o.url}`,
      );
    }
    await retryFs(() => fsp.rename(part, o.dest));
    return { bytes: done, digest };
  } catch (e) {
    await fsp.rm(part, { force: true });
    if (ctrl.signal.aborted && !o.signal?.aborted) {
      throw new CreateError("network", `${new URL(o.url).host} 에서 응답이 끊겼어요.`, "인터넷 연결을 확인한 뒤 다시 시도해 주세요.", String((ctrl.signal.reason as Error)?.message ?? ""));
    }
    throw e;
  } finally {
    clearTimeout(idle);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** JSON 을 받는다. sha1 을 주면 원문 바이트의 sha1 을 확인한다 (Mojang 버전 JSON) */
export async function fetchJson<T>(url: string, opts: { sha1?: string; signal?: AbortSignal; retries?: number } = {}): Promise<T> {
  const buf = await fetchBuffer(url, opts);
  if (opts.sha1) {
    const digest = createHash("sha1").update(buf).digest("hex");
    if (digest !== opts.sha1.toLowerCase()) {
      throw new CreateError("hash_mismatch", "받은 버전 정보가 공식 해시와 달라요.", "다시 시도해 주세요. 계속 다르면 네트워크(프록시·VPN)를 확인해 주세요.", `sha1 기대값 ${opts.sha1}\nsha1 실제값 ${digest}\n${url}`);
    }
  }
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw new CreateError("http_error", "버전 정보를 읽지 못했어요.", "잠시 후 다시 시도해 주세요.", url);
  }
}

export async function fetchText(url: string, opts: { signal?: AbortSignal; retries?: number } = {}): Promise<string> {
  return (await fetchBuffer(url, opts)).toString("utf8");
}

async function fetchBuffer(url: string, opts: { signal?: AbortSignal; retries?: number }): Promise<Buffer> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      if (res.status === 404) throw new CreateError("not_found", "요청한 정보를 찾을 수 없어요.", "선택한 버전이 더 이상 배포되지 않을 수 있어요.", url);
      if (!res.ok) throw new CreateError("http_error", `정보를 받지 못했어요 (HTTP ${res.status}).`, "잠시 후 다시 시도해 주세요.", url);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (opts.signal?.aborted) throw new CreateError("cancelled", "만들기를 취소했어요.");
      const ce = e instanceof CreateError ? e : ctrl.signal.aborted ? new CreateError("network", `${new URL(url).host} 에서 응답이 없어요.`, "인터넷 연결을 확인한 뒤 다시 시도해 주세요.", url) : toCreateError(e, { url });
      if (ce.code !== "network") throw ce;
      lastErr = ce;
      if (attempt < retries) await sleep(800 * (attempt + 1), opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

/** 이미 디스크에 있는 파일의 해시 */
export async function hashFile(file: string, algo: HashAlgo): Promise<string> {
  const h = createHash(algo);
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
