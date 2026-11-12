import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModpackInspectResult, ModpackSummary } from "@blockpilot/shared";
import { BLOCKPILOT_HOME } from "../../config/store.js";
import { retryFs } from "../../lib/retry.js";
import { downloadFile } from "./download.js";
import { CreateError, toCreateError } from "./errors.js";
import { planFor, type ModpackPlan } from "./modpack.js";

/**
 * 모드팩(.mrpack) 임시 보관소: 올리거나 Modrinth 에서 받은 팩을 검사한 뒤, 만들기를 누를 때까지 앱 폴더에 둔다.
 * - 1시간 뒤 만료(만들기 작업이 끝나면 다시 1시간), 최대 5개 (받는 중인 것까지 세고, 넘으면 가장 오래된 것부터 지움)
 * - 한 번에 받는(올리는) 팩은 2개까지
 * - 검사·만들기 중인 팩(busy)은 만료·밀어내기에서 빠진다
 * - 기록(메모리)에 없는 파일은 지난 실행이 남긴 것 — 오래된 것부터 치운다
 */

const MB = 1024 * 1024;
export const UPLOADS_DIR = path.join(BLOCKPILOT_HOME, "tmp", "uploads");
export const MODPACK_UPLOAD_MAX_BYTES = 512 * MB;
export const UPLOAD_TTL_MS = 60 * 60_000;
export const MAX_STORED_UPLOADS = 5;
/** 동시에 받는(올리는) 팩 수 상한 */
export const MAX_PENDING_UPLOADS = 2;
const SWEEP_INTERVAL_MS = 10 * 60_000;

export interface StoredUpload {
  id: string;
  /** 보관 파일 절대 경로 */
  file: string;
  /** 화면에 보여 줄 원래 파일 이름 */
  fileName: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  summary?: ModpackSummary;
  /** 검사 때 정한 "넣지 않을 것" 판별 — 만들 때 Modrinth 에 다시 묻지 않고 이걸 쓴다 */
  plan?: ModpackPlan;
  /** 검사·만들기 작업이 쓰는 중 (만료·밀어내기 제외) */
  busy: boolean;
}

export interface StoreOptions {
  /** 보관하자마자 busy 로 (검사가 끝날 때까지 밀려나지 않게). 끝나면 releaseUpload */
  hold?: boolean;
  /** 받는 중에 멈출 신호 (요청을 보낸 화면이 닫힘 등) */
  signal?: AbortSignal;
}

const uploads = new Map<string, StoredUpload>();
/** 받는 중인 id (.part 파일을 치우지 않도록) */
const pending = new Set<string>();

/** 업로드 상한을 넘었을 때 (라우트가 413 으로 돌려준다) */
export class ModpackTooLargeError extends CreateError {
  constructor(maxBytes: number) {
    super("modpack_invalid", `모드팩 파일이 너무 커요 (최대 ${Math.round(maxBytes / MB)}MB).`, "더 작은 팩을 고르거나, 서버를 만든 뒤 모드 화면에서 모드를 나눠 넣어 주세요.");
    this.name = "ModpackTooLargeError";
  }
}

/** 이미 팩 2개를 받는(올리는) 중일 때 (라우트가 429 로 돌려준다) */
export class ModpackBusyError extends CreateError {
  constructor() {
    super("busy", "다른 모드팩을 올리는 중이에요. 끝난 뒤 다시 시도해 주세요.", "올리던 팩 검사가 끝나면 다시 골라 주세요.");
    this.name = "ModpackBusyError";
  }
}

/** 경로 부분·제어 문자를 뺀 표시용 이름 */
function displayName(name: string): string {
  const base = path.posix.basename(String(name ?? "").replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "");
  return (base || "modpack.mrpack").slice(0, 200);
}

async function newSlot(): Promise<{ id: string; file: string }> {
  if (pending.size >= MAX_PENDING_UPLOADS) throw new ModpackBusyError();
  // 자리를 먼저 잡는다 (아래 await 사이에 다른 요청이 끼어들어도 상한을 넘지 않게)
  const id = randomBytes(9).toString("base64url");
  pending.add(id);
  try {
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });
    // 받는 중인 것까지 세서, 가장 오래된 것부터 밀어낸다 (검사·만들기 중인 것은 빼고)
    const idle = [...uploads.values()].filter((u) => !u.busy).sort((a, b) => a.createdAt - b.createdAt);
    while (uploads.size + pending.size > MAX_STORED_UPLOADS && idle.length) await dropUpload(idle.shift()!.id);
  } catch (e) {
    pending.delete(id);
    throw e;
  }
  return { id, file: path.join(UPLOADS_DIR, `${id}.mrpack`) };
}

function register(id: string, file: string, fileName: string, size: number, hold = false): StoredUpload {
  const now = Date.now();
  const entry: StoredUpload = { id, file, fileName: displayName(fileName), size, createdAt: now, expiresAt: now + UPLOAD_TTL_MS, busy: hold };
  uploads.set(id, entry);
  pending.delete(id);
  ensureSweeper();
  return entry;
}

/** 업로드 스트림을 보관한다. .part 에 쓰고 다 받으면 이름을 바꾼다. 상한을 넘으면 즉시 멈추고 지운다 */
export async function storeUpload(stream: Readable, fileName: string, maxBytes = MODPACK_UPLOAD_MAX_BYTES, opts: StoreOptions = {}): Promise<StoredUpload> {
  const { id, file } = await newSlot();
  const part = file + ".part";
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new ModpackTooLargeError(maxBytes));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, limiter, createWriteStream(part));
    if (size === 0) throw new CreateError("modpack_invalid", "빈 파일이에요.", "모드팩(.mrpack) 파일을 다시 골라 주세요.");
    await retryFs(() => fsp.rename(part, file));
  } catch (e) {
    pending.delete(id);
    await fsp.rm(part, { force: true });
    throw toCreateError(e);
  }
  return register(id, file, fileName, size, opts.hold);
}

/** Modrinth 가 아닌 곳의 팩 파일은 받지 않는다 (테스트용으로 BLOCKPILOT_MODRINTH_URL · BLOCKPILOT_MODPACK_EXTRA_HOSTS 의 주소는 허용) */
export function isAllowedPackUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:" && !u.port && u.hostname.toLowerCase() === "cdn.modrinth.com") return true;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const extra = (process.env.BLOCKPILOT_MODPACK_EXTRA_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const api = process.env.BLOCKPILOT_MODRINTH_URL;
  if (api) {
    try {
      extra.push(new URL(api).host.toLowerCase());
    } catch {
      /* 잘못된 값은 무시 */
    }
  }
  return extra.includes(u.host.toLowerCase());
}

/** Modrinth 의 .mrpack 을 받아 보관한다 (sha512 확인) */
export async function storeFromUrl(url: string, sha512: string, size: number, fileName: string, opts: StoreOptions = {}): Promise<StoredUpload> {
  if (!isAllowedPackUrl(url)) {
    throw new CreateError("modpack_blocked_host", "Modrinth 가 아닌 곳의 모드팩 파일이라 받지 않았어요.", "Modrinth 목록에서 다른 버전을 골라 주세요.", url);
  }
  if (size > MODPACK_UPLOAD_MAX_BYTES) throw new ModpackTooLargeError(MODPACK_UPLOAD_MAX_BYTES);
  const { id, file } = await newSlot();
  let r: { bytes: number };
  try {
    r = await downloadFile({
      url,
      dest: file,
      hash: { algo: "sha512", expected: sha512 },
      expectedSize: size,
      maxBytes: Math.min(MODPACK_UPLOAD_MAX_BYTES, size + 64 * 1024),
      // Modrinth CDN 은 넘기지 않는다. 넘겨지면 같은 규칙(Modrinth CDN·테스트 주소)인 곳만
      allowRedirect: (next) => isAllowedPackUrl(next),
      signal: opts.signal,
    });
  } catch (e) {
    pending.delete(id);
    await fsp.rm(file, { force: true });
    throw e;
  }
  return register(id, file, fileName, r.bytes, opts.hold);
}

/** 만료되지 않은 보관 팩. 없거나 만료면 undefined */
export function getUpload(id: string): StoredUpload | undefined {
  const u = uploads.get(id);
  if (!u) return undefined;
  if (!u.busy && u.expiresAt <= Date.now()) {
    void dropUpload(id).catch(() => {});
    return undefined;
  }
  return u;
}

/**
 * 검사 결과(요약 + 판별)를 붙여 두고 화면에 돌려줄 값을 만든다.
 * plan 을 안 주면 inspectMrpack 이 그 요약을 만들 때의 판별을 쓴다
 */
export function rememberSummary(id: string, fileName: string, summary: ModpackSummary, plan: ModpackPlan | undefined = planFor(summary)): ModpackInspectResult {
  const u = uploads.get(id);
  if (!u) throw new CreateError("modpack_expired", "고른 모드팩의 임시 파일이 사라졌어요.", "모드팩을 다시 골라 주세요.");
  u.summary = summary;
  u.plan = plan;
  u.fileName = displayName(fileName);
  return { uploadId: id, summary, fileName: u.fileName, expiresAt: new Date(u.expiresAt).toISOString() };
}

/** 검사·만들기가 끝났을 때: busy 를 풀고 만료를 지금부터 다시 1시간으로 (실패한 뒤 같은 팩으로 다시 시도할 수 있게) */
export function releaseUpload(id: string): void {
  const u = uploads.get(id);
  if (!u) return;
  u.busy = false;
  u.expiresAt = Date.now() + UPLOAD_TTL_MS;
}

export async function dropUpload(id: string): Promise<void> {
  const u = uploads.get(id);
  uploads.delete(id);
  if (u) await fsp.rm(u.file, { force: true });
}

/**
 * 만료된 팩과, 기록에 없는 오래된 파일(지난 실행이 남긴 것)을 지운다.
 * 기록에 없는 파일은 1시간(만료 시간)이 지난 것만 — 같은 앱 폴더를 쓰는 다른 BlockPilot 이 막 올린 팩까지 지우지 않게.
 */
export async function sweepUploads(now = Date.now()): Promise<void> {
  ensureSweeper();
  for (const [id, u] of uploads) if (!u.busy && u.expiresAt <= now) await dropUpload(id);
  let names: string[];
  try {
    names = await fsp.readdir(UPLOADS_DIR);
  } catch {
    return;
  }
  const known = new Set([...uploads.keys(), ...pending]);
  for (const n of names) {
    const id = n.replace(/\.mrpack(\.part)?$/, "");
    if (known.has(id)) continue;
    const full = path.join(UPLOADS_DIR, n);
    const st = await fsp.stat(full).catch(() => null);
    if (st && now - st.mtimeMs >= UPLOAD_TTL_MS) await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

let sweeper: NodeJS.Timeout | undefined;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => void sweepUploads().catch(() => {}), SWEEP_INTERVAL_MS);
  sweeper.unref();
}

/** 테스트용: 기록을 비운다 (파일은 그대로) */
export function __resetUploadsForTests() {
  uploads.clear();
  pending.clear();
}
