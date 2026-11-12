import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";
import { BLOCKPILOT_HOME, configRecoveryInfo, listServers } from "../config/store.js";
import { APP_VERSION, isSingleExecutable } from "../lib/appInfo.js";
import { LOG_FILE, MASK, redactObject, redactText } from "../lib/logger.js";
import { systemInfo } from "./platform/index.js";
import { detectServer } from "./serverInfo.js";
import { getManaged } from "./process.js";
import { readLog } from "./logs.js";
import { latestCrashReport } from "./crash.js";
import { JOBS_DIR } from "./create/job.js";

/**
 * 문제 신고 파일: 깃허브 이슈에 붙일 수 있게 로그·설정·서버 정보를 zip 하나로 모은다.
 * 월드·모드·백업은 절대 넣지 않고, 토큰·웹훅·초대코드·RCON 비밀번호 같은 비밀은 가린다.
 * <BLOCKPILOT_HOME>/tmp/blockpilot-debug-<시각>.zip 에 만들고, 한 시간이 지난 것은 다음 요청 때 지운다.
 */

export const DEBUG_DIR = path.join(BLOCKPILOT_HOME, "tmp");
export const BUNDLE_PREFIX = "blockpilot-debug-";
export const BUNDLE_NAME = /^blockpilot-debug-[0-9A-Za-z_-]{1,40}\.zip$/;
const BUNDLE_MAX_AGE_MS = 60 * 60_000;
/** 전체 상한 (대략). 넘으면 이후 항목은 건너뛰고 about.json 에 적는다 */
const TOTAL_CAP = 20 * 1024 * 1024;
const APP_LOG_TAIL = 2000;
const SERVER_LOG_TAIL = 300;
const SCRIPT_CAP = 64 * 1024;
const STATUS_TIMEOUT_MS = 3000;
const START_SCRIPTS = ["start.sh", "run.sh", "start.bat", "run.bat", "start.command"];
/** 값을 그대로 보여 줘도 되는 환경 변수. 나머지는 "설정됨" 만 */
const SAFE_ENV = new Set(["BLOCKPILOT_PORT", "BLOCKPILOT_HOST", "BLOCKPILOT_HOME", "BLOCKPILOT_NO_BROWSER", "BLOCKPILOT_JOIN_PORT", "LOG_LEVEL", "LOG_FORMAT", "NODE_ENV"]);

export interface DebugBundle {
  path: string;
  fileName: string;
  sizeBytes: number;
  /** zip 안 항목 (테스트·응답용) */
  entries: string[];
}

/** 설정 파일 속 비밀값을 모은다 — 로그 글 어디에 섞여 있어도 가릴 수 있게 (웹훅은 redactText 의 패턴이 마지막 4자를 남기며 가린다) */
function collectSecrets(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectSecrets(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && v.length >= 8 && /^(token|secret|secretKey|password|inviteCode)$/i.test(k)) out.push(v);
      else collectSecrets(v, out);
    }
  }
  return out;
}

async function readConfigRaw(): Promise<{ parsed?: unknown; error?: string }> {
  try {
    return { parsed: JSON.parse(await fs.readFile(path.join(BLOCKPILOT_HOME, "config.json"), "utf8")) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function tailLines(file: string, n: number): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + "\n";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { error: string }> {
  return Promise.race([p.catch((e) => ({ error: (e as Error).message })), new Promise<{ error: string }>((r) => setTimeout(() => r({ error: `${ms}ms 안에 답이 없음` }), ms).unref())]);
}

/** 만든 지 한 시간이 지난 신고 파일을 지운다 */
export async function pruneOldBundles(maxAgeMs = BUNDLE_MAX_AGE_MS) {
  let names: string[];
  try {
    names = await fs.readdir(DEBUG_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const n of names) {
    if (!n.startsWith(BUNDLE_PREFIX)) continue;
    const full = path.join(DEBUG_DIR, n);
    const st = await fs.stat(full).catch(() => null);
    if (st?.isFile() && now - st.mtimeMs > maxAgeMs) await fs.rm(full, { force: true }).catch(() => {});
  }
}

let inFlight: Promise<DebugBundle> | null = null;

/** 동시에 두 번 눌러도 한 번만 만든다 */
export function buildDebugBundle(): Promise<DebugBundle> {
  if (!inFlight) inFlight = build().finally(() => (inFlight = null));
  return inFlight;
}

async function build(): Promise<DebugBundle> {
  const zip = new yazl.ZipFile();
  const entries: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  const add = (name: string, body: string | Buffer, force = false) => {
    const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    if (!force && total + buf.length > TOTAL_CAP) {
      skipped.push(name);
      return;
    }
    total += buf.length;
    zip.addBuffer(buf, name, { mode: 0o100600 });
    entries.push(name);
  };
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

  const config = await readConfigRaw();
  const secrets = [...collectSecrets(config.parsed), process.env.BLOCKPILOT_TOKEN ?? ""].filter((s) => s.length >= 8);
  const redact = (s: string) => redactText(s, secrets);

  // 설정 (비밀은 가린 채)
  add("config.json", config.parsed !== undefined ? json(redactObject(config.parsed)) : json({ error: config.error }), true);
  add("system.json", json(systemInfo()), true);

  // 앱 로그 (현재 파일 꼬리 + 직전 회전본 꼬리)
  for (const [file, name] of [
    [LOG_FILE, "blockpilot.log"],
    [`${LOG_FILE}.1`, "blockpilot.log.1"],
  ] as const) {
    const tail = await tailLines(file, APP_LOG_TAIL);
    if (tail !== null) add(name, redact(tail));
  }

  // 만들기 작업 일지
  const jobs = await fs.readdir(JOBS_DIR).catch(() => [] as string[]);
  for (const f of jobs.filter((n) => n.endsWith(".json")).sort().slice(-10)) {
    const text = await fs.readFile(path.join(JOBS_DIR, f), "utf8").catch(() => null);
    if (text !== null) add(`jobs/${f}`, redact(text));
  }

  // 등록된 서버마다
  const servers = await listServers().catch(() => []);
  for (const s of servers) {
    const base = `servers/${s.id}`;
    const exists = await fs
      .stat(s.path)
      .then((st) => st.isDirectory())
      .catch(() => false);
    const detected = exists ? await detectServer(s.path).catch((e) => ({ error: (e as Error).message })) : null;
    const status = exists ? await withTimeout(getManaged(s.id, s.path).status(), STATUS_TIMEOUT_MS) : null;
    add(`${base}/info.json`, json(redactObject({ ...s, exists, detected, status })));
    if (!exists) continue;

    const latest = await readLog(s.path, "log", "latest.log", SERVER_LOG_TAIL).catch(() => null);
    if (latest) add(`${base}/latest.log`, redact(latest.lines.join("\n") + "\n"));

    const crash = await latestCrashReport(s.path).catch(() => null);
    if (crash) add(`${base}/crash-reports/${crash.file}`, redact(crash.text));

    for (const name of START_SCRIPTS) {
      const text = await fs.readFile(path.join(s.path, name), "utf8").catch(() => null);
      if (text !== null) add(`${base}/${name}`, redact(text.length > SCRIPT_CAP ? text.slice(0, SCRIPT_CAP) + "\n…(잘림)\n" : text));
    }

    const props = await fs.readFile(path.join(s.path, "server.properties"), "utf8").catch(() => null);
    if (props !== null) add(`${base}/server.properties`, redact(props.replace(/^(rcon\.password=).*$/gm, `$1${MASK}`)));

    const running = await fs.readFile(path.join(s.path, ".blockpilot", "running.json"), "utf8").catch(() => null);
    if (running !== null) add(`${base}/running.json`, redact(running));
  }

  // about.json 은 맨 마지막에 (건너뛴 항목까지 적으려고)
  const envNames = Object.keys(process.env)
    .filter((k) => /^(BLOCKPILOT_|LOG_|NODE_ENV$|JAVA_HOME$)/.test(k))
    .sort();
  add(
    "about.json",
    json({
      version: APP_VERSION,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      node: process.version,
      singleExecutable: await isSingleExecutable(),
      home: BLOCKPILOT_HOME,
      uptimeSec: Math.round(process.uptime()),
      memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576), cpus: os.cpus().length },
      env: Object.fromEntries(envNames.map((k) => [k, SAFE_ENV.has(k) ? process.env[k] : `(설정됨, ${process.env[k]!.length}자)`])),
      configRecovery: configRecoveryInfo(),
      configError: config.error,
      servers: servers.length,
      skippedForSize: skipped,
    }),
    true,
  );

  // 파일로
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `${BUNDLE_PREFIX}${stamp}.zip`;
  const target = path.join(DEBUG_DIR, fileName);
  const part = `${target}.part`;
  try {
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(part, { mode: 0o600 });
      ws.on("close", () => resolve());
      ws.on("error", reject);
      zip.outputStream.on("error", reject);
      zip.outputStream.pipe(ws);
    });
    await fs.rename(part, target);
  } catch (e) {
    await fs.rm(part, { force: true }).catch(() => {});
    throw e;
  }
  const st = await fs.stat(target);
  return { path: target, fileName, sizeBytes: st.size, entries };
}
