import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { BLOCKPILOT_HOME } from "../config/store.js";

/**
 * 앱 로그.
 * - 파일: <BLOCKPILOT_HOME>/logs/blockpilot.log 에 JSON 한 줄씩 (나만 읽기 600). 켤 때 5 MB 를 넘으면 .1 … .5 로 돌린다
 * - 콘솔: 사람이 읽는 한 줄 (시각 · 레벨 · 메시지, 요청은 `GET /api/… 200 12ms`). LOG_FORMAT=json 이면 파일과 같은 JSON
 * - 가림: Authorization·Cookie·WebSocket 서브프로토콜 헤더, URL 의 ?token= 은 기록 자체에서 가린다
 *
 * pino-pretty · transport(워커 스레드) 는 일부러 쓰지 않는다 — 단일 실행 파일(SEA) 안에서 워커 파일을 못 찾는다.
 */

export const LOG_DIR = path.join(BLOCKPILOT_HOME, "logs");
export const LOG_FILE = path.join(LOG_DIR, "blockpilot.log");
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 5;
const FILE_MODE = 0o600;
export const MASK = "[가림]";

export interface AppLoggerOptions {
  level?: string;
  toConsole?: "pretty" | "json" | "none";
  /** 로그 파일 경로. false 면 파일에 쓰지 않는다 (테스트) */
  file?: string | false;
  rotate?: { maxBytes?: number; keep?: number };
}

export interface AppLogger {
  logger: Logger;
  file: string | null;
  /** 종료 직전에 버퍼를 비운다 (파일은 동기 쓰기라 보통 비어 있지만 안전하게) */
  flush(): void;
}

// ---------- 회전 ----------

/** 파일이 maxBytes 를 넘으면 file.1 … file.keep 으로 밀어 둔다 (가장 오래된 것은 지움) */
export function rotateIfLarge(file: string, maxBytes = MAX_BYTES, keep = KEEP) {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  try {
    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* 없는 번호 */
      }
    }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

// ---------- 가림 ----------

const SECRET_KEY = /^(authorization|cookie|set-cookie|sec-websocket-protocol|token|secret|secretKey|password|rcon\.password|webhookUrl|inviteCode)$/i;
const QUERY_SECRET = /([?&](?:token|secret|password)=)[^&#\s"']*/gi;

/** URL 에서 ?token= 같은 값만 가린다 (경로는 그대로) */
export function redactUrl(url: string): string {
  return url.replace(QUERY_SECRET, `$1${MASK}`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 글 속에서 비밀처럼 보이는 것을 가린다 (문제 신고 파일용).
 * - Discord 웹훅 주소: 토큰의 마지막 4자만 남김
 * - P2P 초대코드: z-base-32 80자(4자마다 '-')
 * - `Bearer xxx`, `token=xxx` · `secret=xxx` · `password=xxx`, JSON 의 "token": "xxx" 같은 필드
 * - secrets 로 넘긴 값(접속 토큰 등) 은 어디에 있든 가림
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < 8) continue;
    out = out.replace(new RegExp(escapeRe(s), "g"), MASK);
  }
  out = out.replace(/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/([\w-]+)/g, (_m, tok: string) => `https://discord.com/api/webhooks/…/…${tok.slice(-4)}`);
  out = out.replace(/(?<![a-z0-9])(?:[ybndrfg8ejkmcpqxot1uwisza345h769]{4}-?){20}(?![a-z0-9-])/g, "[초대코드 가림]");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9_\-.=+/]+/g, `$1${MASK}`);
  out = out.replace(/\b((?:token|secret|secretKey|password|rcon\.password|webhookUrl)=)[^&\s"',;]+/gi, `$1${MASK}`);
  out = out.replace(/("(?:token|secret|secretKey|password|webhookUrl|inviteCode|authorization|cookie)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi, `$1${MASK}$2`);
  return out;
}

/** 객체를 재귀적으로 돌며 비밀 키의 값을 가린다. publicKey 는 앞 8자만 남긴다 */
export function redactObject<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (key && SECRET_KEY.test(key)) {
      if (typeof v === "string" && key === "webhookUrl") return v ? redactText(v) : v;
      return v == null || v === "" ? v : MASK;
    }
    if (key && /^publicKey$/i.test(key) && typeof v === "string" && v.length > 12) return `${v.slice(0, 8)}…`;
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === "string") return redactText(v);
    return v;
  };
  return walk(value) as T;
}

// ---------- 콘솔 한 줄 ----------

const LEVEL_LABEL: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO ", 40: "WARN ", 50: "ERROR", 60: "FATAL" };
const LEVEL_COLOR: Record<number, string> = { 10: "90", 20: "90", 30: "32", 40: "33", 50: "31", 60: "35" };
const OWN_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "req", "res", "responseTime", "reqId", "v"]);

type LogLine = { level?: number; time?: number; msg?: string; reqId?: string; req?: { method?: string; url?: string }; res?: { statusCode?: number }; responseTime?: number; err?: { type?: string; message?: string; stack?: string } } & Record<string, unknown>;

function hhmmss(t: number | undefined) {
  const d = t ? new Date(t) : new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * JSON 한 줄을 사람이 읽는 한 줄로. "incoming request" 는 기억만 하고(null) "request completed" 에서 한 줄로 합친다.
 * pending 은 호출자가 들고 있는 reqId → "GET /api/…" 표 (크기는 호출자가 관리).
 */
export function formatPretty(line: LogLine, pending?: Map<string, string>, color = false): string | null {
  const level = line.level ?? 30;
  const paint = (code: string, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const head = `${paint("90", hhmmss(line.time))} ${paint(LEVEL_COLOR[level] ?? "0", LEVEL_LABEL[level] ?? String(level))}`;

  let msg = line.msg ?? "";
  if (line.req && line.msg === "incoming request") {
    const what = `${line.req.method ?? ""} ${line.req.url ?? ""}`.trim();
    if (pending && line.reqId) {
      pending.set(line.reqId, what);
      return null;
    }
    msg = `→ ${what}`;
  } else if (line.res && line.msg === "request completed") {
    const what = (line.reqId && pending?.get(line.reqId)) ?? "";
    if (line.reqId) pending?.delete(line.reqId);
    const ms = typeof line.responseTime === "number" ? ` ${line.responseTime < 10 ? line.responseTime.toFixed(1) : Math.round(line.responseTime)}ms` : "";
    const status = line.res.statusCode ?? "";
    msg = `${what ? what + " " : ""}${paint(Number(status) >= 500 ? "31" : Number(status) >= 400 ? "33" : "0", String(status))}${ms}`;
  }

  const extras: string[] = [];
  for (const [k, v] of Object.entries(line)) {
    if (OWN_KEYS.has(k) || k === "err" || v === undefined) continue;
    extras.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  let out = `${head} ${msg}${extras.length ? " " + paint("90", extras.join(" ")) : ""}`;
  if (line.err) {
    out += `\n  ${paint("31", `${line.err.type ?? "Error"}: ${line.err.message ?? ""}`)}`;
    if (line.err.stack) out += "\n" + line.err.stack.split("\n").slice(1, 8).map((s) => `  ${s.trim()}`).join("\n");
  }
  return out;
}

/** pino 가 쓰는 JSON 줄을 받아 콘솔에 예쁘게 찍는 스트림 */
function prettyStream(sink: NodeJS.WritableStream, color: boolean): Writable {
  const pending = new Map<string, string>();
  let rest = "";
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) {
        if (!l) continue;
        let out: string | null;
        try {
          out = formatPretty(JSON.parse(l) as LogLine, pending, color);
        } catch {
          out = l;
        }
        if (out !== null) sink.write(out + "\n");
        // 응답 없이 끝난 요청이 쌓이지 않게
        if (pending.size > 1000) pending.delete(pending.keys().next().value!);
      }
      cb();
    },
  });
}

// ---------- 만들기 ----------

export function createAppLogger(opts: AppLoggerOptions = {}): AppLogger {
  const level = opts.level ?? "info";
  const toConsole = opts.toConsole ?? "pretty";
  const file = opts.file === false ? null : (opts.file ?? LOG_FILE);
  const streams: pino.StreamEntry[] = [];

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfLarge(file, opts.rotate?.maxBytes, opts.rotate?.keep);
      // 동기 쓰기: 바로 죽어도(크래시 가드 → process.exit) 마지막 줄이 남는다
      const dest = pino.destination({ dest: file, sync: true, mkdir: true, mode: FILE_MODE });
      try {
        fs.chmodSync(file, FILE_MODE);
      } catch {
        /* 권한을 못 바꿔도 로그는 남긴다 */
      }
      streams.push({ level: level as pino.Level, stream: dest });
    } catch (e) {
      console.warn(`[log] 로그 파일을 열지 못했어요 (${file}): ${(e as Error).message}`);
    }
  }
  if (toConsole === "json") streams.push({ level: level as pino.Level, stream: pino.destination({ fd: 1, sync: true }) });
  else if (toConsole === "pretty") streams.push({ level: level as pino.Level, stream: prettyStream(process.stdout, !!process.stdout.isTTY && !process.env.NO_COLOR) });

  const logger = pino(
    {
      level,
      base: { pid: process.pid },
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["sec-websocket-protocol"]', "headers.authorization", "headers.cookie", 'headers["sec-websocket-protocol"]', "token", "secret", "inviteCode"],
        censor: MASK,
      },
      serializers: {
        // Fastify 기본 serializer 와 같은 모양에 URL 의 토큰만 가린다 (헤더는 애초에 기록하지 않는다)
        req: (req: { method?: string; url?: string; headers?: Record<string, unknown>; host?: string; hostname?: string; ip?: string; remoteAddress?: string; socket?: { remotePort?: number } }) => ({
          method: req.method,
          url: typeof req.url === "string" ? redactUrl(req.url) : req.url,
          version: req.headers?.["accept-version"],
          host: req.host ?? req.hostname,
          remoteAddress: req.ip ?? req.remoteAddress,
          remotePort: req.socket?.remotePort,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: pino.stdSerializers.err,
      },
    },
    streams.length ? pino.multistream(streams, { dedupe: false }) : new Writable({ write: (_c, _e, cb) => cb() }),
  );

  return {
    logger,
    file,
    flush() {
      try {
        logger.flush();
      } catch {
        /* 이미 닫힘 */
      }
    },
  };
}
