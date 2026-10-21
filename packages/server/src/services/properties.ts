import fs from "node:fs/promises";
import path from "node:path";
import { PROPERTY_META_BY_KEY } from "@blockpilot/shared";
import { writeFileAtomic } from "../lib/atomicWrite.js";
import { badRequest } from "../lib/errors.js";
import { platform } from "./platform/index.js";

/**
 * server.properties 파서.
 * 주석·빈 줄·키 순서를 그대로 보존하기 위해 라인 단위로 다룬다.
 */

export type PropertyLine =
  | { kind: "entry"; key: string; value: string; raw: string }
  | { kind: "other"; raw: string };

export function parseProperties(text: string): PropertyLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      return { kind: "other", raw };
    }
    const idx = indexOfSeparator(trimmed);
    if (idx < 0) return { kind: "entry", key: unescapeKey(trimmed), value: "", raw };
    return {
      kind: "entry",
      key: unescapeKey(trimmed.slice(0, idx).trim()),
      value: unescapeValue(trimmed.slice(idx + 1).trim()),
      raw,
    };
  });
}

/** 파일이 원래 쓰던 줄바꿈 (Windows 에서 Java 가 쓴 파일은 CRLF) */
export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function serializeProperties(lines: PropertyLine[], eol: "\r\n" | "\n" = "\n"): string {
  return lines
    .map((l) => (l.kind === "entry" ? `${escapeKey(l.key)}=${escapeValue(l.value)}` : l.raw))
    .join(eol);
}

/** 변경 사항을 적용. 기존 키는 제자리에서 값만 바꾸고, 새 키는 끝에 추가. */
export function applyChanges(lines: PropertyLine[], changes: Record<string, string>): PropertyLine[] {
  const remaining = { ...changes };
  const out: PropertyLine[] = lines.map((l) => {
    if (l.kind === "entry" && l.key in remaining) {
      const value = remaining[l.key];
      delete remaining[l.key];
      return { kind: "entry", key: l.key, value, raw: "" };
    }
    return l;
  });
  // 파일 끝에 빈 줄이 있으면 그 앞에 새 키를 넣는다
  const tail = out.length && out[out.length - 1].kind === "other" && out[out.length - 1].raw === "" ? out.pop() : null;
  for (const [key, value] of Object.entries(remaining)) {
    out.push({ kind: "entry", key, value, raw: "" });
  }
  if (tail) out.push(tail);
  return out;
}

export function toRecord(lines: PropertyLine[]): Record<string, string> {
  const r: Record<string, string> = {};
  for (const l of lines) if (l.kind === "entry") r[l.key] = l.value;
  return r;
}

// --- 파일 IO ---

export async function readPropertiesFile(serverDir: string) {
  const file = path.join(serverDir, "server.properties");
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    return { lines: parseProperties(text), eol: detectEol(text), mtime: stat.mtime.toISOString(), exists: true };
  } catch (e: any) {
    if (e.code === "ENOENT") return { lines: [] as PropertyLine[], eol: (platform.id === "windows" ? "\r\n" : "\n") as "\r\n" | "\n", mtime: new Date(0).toISOString(), exists: false };
    throw e;
  }
}

export async function writePropertiesChanges(serverDir: string, changes: Record<string, string>) {
  const file = path.join(serverDir, "server.properties");
  const { lines, eol } = await readPropertiesFile(serverDir);
  const next = applyChanges(lines, changes);
  await writeFileAtomic(file, serializeProperties(next, eol));
  return toRecord(next);
}

// --- 이스케이프 (java.util.Properties 규칙의 실용적 부분집합) ---

function indexOfSeparator(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "=" || c === ":") return i;
  }
  return -1;
}

function unescapeKey(s: string) {
  return s.replace(/\\(.)/g, "$1");
}

function escapeKey(s: string) {
  return s.replace(/([=:\\ ])/g, "\\$1");
}

function unescapeValue(s: string) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

function escapeValue(s: string) {
  // 마인크래프트 자체도 비ASCII를 \uXXXX로 쓰므로 호환되게 맞춘다 (MOTD 한글 등)
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "=" || ch === ":" || ch === "#" || ch === "!") out += "\\" + ch;
    else if (code < 0x20 || code > 0x7e) {
      // BMP 밖(이모지 등)은 서로게이트 쌍으로 나눠서 각각 \u로
      for (const unit of ch.split("")) out += "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0");
    } else out += ch;
  }
  return out;
}

/** 키·값 형식 검사. 메타데이터에 있는 키는 타입(boolean/enum/int 범위)까지 확인 */
export function validatePropertyChange(key: string, value: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw badRequest(`잘못된 키: ${key}`);
  if (/[\r\n]/.test(value)) throw badRequest(`값에 줄바꿈을 넣을 수 없습니다: ${key}`);
  const meta = PROPERTY_META_BY_KEY[key];
  if (!meta) return;
  switch (meta.type) {
    case "boolean":
      if (value !== "true" && value !== "false") throw badRequest(`${meta.label}: true/false 만 가능`);
      break;
    case "enum":
      if (!meta.options.some((o) => o.value === value)) throw badRequest(`${meta.label}: 허용되지 않는 값 '${value}'`);
      break;
    case "int": {
      if (!/^-?\d+$/.test(value)) throw badRequest(`${meta.label}: 정수만 가능`);
      const n = Number(value);
      if (meta.min !== undefined && n < meta.min) throw badRequest(`${meta.label}: 최소 ${meta.min}`);
      if (meta.max !== undefined && n > meta.max) throw badRequest(`${meta.label}: 최대 ${meta.max}`);
      break;
    }
  }
}
