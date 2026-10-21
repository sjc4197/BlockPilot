import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import type { SystemInfo } from "@blockpilot/shared";
import type { OsId, Platform } from "./types.js";
import { macos } from "./macos.js";
import { linux, isMusl } from "./linux.js";
import { windows } from "./windows.js";

export type { Platform, OsId } from "./types.js";
export const platforms: Record<OsId, Platform> = { macos, linux, windows };

/**
 * BlockPilot 이 돌고 있는 컴퓨터의 OS. 사용자가 고르지 않고, 켜질 때 자동으로 정해진다.
 * (원격으로 접속해도 BlockPilot 이 돌아가는 쪽 기준)
 */
export function detectOs(p: NodeJS.Platform = process.platform): OsId | null {
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  if (p === "win32") return "windows";
  return null;
}

const current = detectOs();
/** 지원하지 않는 OS 에서도 앱 자체는 뜨도록 POSIX 기본값으로 */
export const platform: Platform = current ? platforms[current] : linux;

/**
 * OS 별 지원 단계. 해당 단계를 마치고 실제로 검증하면 여기서 켠다.
 * - manage: 기존 서버 연결·관리
 * - create: 새 서버 만들기
 */
const SUPPORT: Record<OsId, { manage: "ok" | "wip"; create: boolean }> = {
  macos: { manage: "ok", create: true },
  // 1단계: Ubuntu CI 에서 실제 서버 만들기·켜기·끄기·삭제 E2E 로 확인
  linux: { manage: "ok", create: true },
  windows: { manage: "wip", create: false },
};

function osLabel(id: OsId | null): string {
  try {
    if (id === "macos") return `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 5000 }).trim()}`;
    if (id === "linux") {
      const rel = readFileSync("/etc/os-release", "utf8");
      return rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? "Linux";
    }
    if (id === "windows") {
      const build = Number(os.release().split(".")[2] ?? 0);
      return `Windows ${build >= 22000 ? "11" : "10"} (빌드 ${build})`;
    }
  } catch {
    /* 이름을 못 읽어도 동작에는 상관없음 */
  }
  return id === "macos" ? "macOS" : id === "linux" ? "Linux" : id === "windows" ? "Windows" : process.platform;
}

function archLabel(id: OsId | null): string {
  if (process.arch === "arm64") return id === "macos" ? "Apple Silicon" : "ARM64";
  if (process.arch === "x64") return id === "macos" ? "Intel" : "x64";
  return process.arch;
}

let info: SystemInfo | null = null;
export function systemInfo(): SystemInfo {
  if (info) return info;
  const archOk = process.arch === "arm64" || process.arch === "x64";
  const support = current ? SUPPORT[current] : { manage: "wip" as const, create: false };
  let reason: string | undefined;
  if (!current) reason = `이 OS(${process.platform})는 지원하지 않아요.`;
  else if (!archOk) reason = `이 CPU(${process.arch})는 아직 지원하지 않아요. x64 또는 ARM64 컴퓨터에서 실행해 주세요.`;
  else if (!support.create) reason = `${current === "linux" ? "Linux" : "Windows"} 에서 새 서버 만들기는 아직 준비 중이에요.`;
  info = {
    os: current ?? "linux",
    osLabel: osLabel(current),
    arch: process.arch,
    archLabel: archLabel(current),
    libc: current === "linux" ? (isMusl() ? "musl" : "glibc") : undefined,
    support: { manage: archOk ? support.manage : "wip", create: archOk && support.create },
    reason,
    words: platform.words,
    pathExample: platform.pathExample,
    sep: current === "windows" ? "\\" : "/",
  };
  return info;
}
