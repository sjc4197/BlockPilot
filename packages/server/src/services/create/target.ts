import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BLOCKPILOT_HOME, listServers } from "../../config/store.js";
import { expandHome as expandHomeWith, isInsidePath, samePath } from "../../lib/paths.js";
import { platform } from "../platform/index.js";
import { CreateError } from "./errors.js";

/**
 * 서버를 만들 폴더 검증과, 실패 시 "앱이 만든 것만" 지우는 정리.
 */

/** 폴더가 '비었다'고 볼 때 무시하는 OS 메타 파일 (.DS_Store, desktop.ini 등) */
export const IGNORABLE = platform.ignorable;

export const expandHome = (p: string) => expandHomeWith(p, os.homedir());

/** 지워도 되는 위치인가. 시스템·홈·앱 폴더 자체나 너무 얕은 경로는 거부 */
export function assertDeletableTarget(target: string) {
  if (!path.isAbsolute(target)) throw new CreateError("invalid_path", "폴더 경로는 전체 경로여야 해요.", "다른 폴더를 골라 주세요.");
  const t = path.resolve(target);
  // 드라이브 문자(C:)나 루트는 깊이에 넣지 않는다
  const depth = t.slice(path.parse(t).root.length).split(path.sep).filter(Boolean).length;
  if (depth < 2 || platform.isForbidden(t) || samePath(t, os.homedir()) || isInsidePath(t, BLOCKPILOT_HOME) || isInsidePath(BLOCKPILOT_HOME, t)) {
    throw new CreateError("invalid_path", `'${t}' 은(는) 정리할 수 없는 위치예요.`, "다른 폴더를 골라 주세요.");
  }
  return t;
}

export interface PreparedTarget {
  target: string;
  /** 시작 시점에 폴더가 이미 있었는지 */
  existed: boolean;
  /** 시작 시점에 폴더 안에 있던 항목 (무시 가능한 메타 파일뿐) */
  preexisting: string[];
}

/**
 * 새 서버 폴더로 쓸 수 있는지 확인한다.
 * - 절대 경로, 시스템·홈·앱 폴더 금지
 * - 아직 없거나(부모 폴더는 있어야 함), 있다면 비어 있어야 함
 * - 이미 등록된 서버 폴더와 겹치면 안 됨
 */
export async function prepareTarget(input: string): Promise<PreparedTarget> {
  const raw = expandHome(input.trim());
  if (!raw || !path.isAbsolute(raw)) {
    throw new CreateError("invalid_path", `폴더 경로는 전체 경로여야 해요 (예: ${platform.pathExample}).`, "폴더 찾기 버튼으로 고르거나 전체 경로를 입력해 주세요.");
  }
  const target = assertDeletableTarget(path.resolve(raw));

  for (const s of await listServers()) {
    const sp = path.resolve(s.path);
    if (isInsidePath(target, sp) || isInsidePath(sp, target)) {
      throw new CreateError("invalid_path", `이미 등록된 서버 '${s.name}' 폴더와 겹쳐요.`, "다른 폴더를 골라 주세요.", s.path);
    }
  }

  const parent = path.dirname(target);
  const parentStat = await fsp.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw new CreateError("invalid_path", `상위 폴더 '${parent}' 가 없어요.`, "있는 폴더 안에 만들거나, 상위 폴더를 먼저 만들어 주세요.");
  }

  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return { target, existed: false, preexisting: [] };
  if (!stat.isDirectory()) {
    throw new CreateError("invalid_path", `'${path.basename(target)}' 은(는) 폴더가 아니라 파일이에요.`, "다른 이름을 써 주세요.");
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(target);
  } catch {
    throw new CreateError("no_permission", `'${target}' 폴더를 읽을 권한이 없어요.`, "다른 폴더를 골라 주세요.");
  }
  const real = entries.filter((e) => !IGNORABLE.has(e));
  if (real.length) {
    const shown = real.slice(0, 5).join(", ") + (real.length > 5 ? ` 외 ${real.length - 5}개` : "");
    throw new CreateError("folder_not_empty", "고른 폴더가 비어 있지 않아요.", "기존 파일을 덮어쓰지 않도록 빈 폴더만 쓸 수 있어요. 새 폴더 이름을 입력하거나 빈 폴더를 골라 주세요.", `들어 있는 항목: ${shown}`);
  }
  return { target, existed: true, preexisting: entries };
}

/**
 * 시작 시점에 없던 항목만 지운다. 폴더를 앱이 만들었다면 폴더도 지운다.
 * 돌려주는 값: 지운 항목 이름 (대상 폴더 기준)
 */
export async function cleanupTarget(j: { target: string; targetCreated: boolean; preexisting: string[] }): Promise<string[]> {
  const target = assertDeletableTarget(j.target);
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await fsp.readdir(target);
  } catch {
    return removed; // 폴더가 이미 없음
  }
  const keep = new Set(j.preexisting);
  for (const name of entries) {
    if (keep.has(name)) continue;
    // readdir 이름에는 경로 구분자가 없으므로 항상 target 바로 아래
    await fsp.rm(path.join(target, name), { recursive: true, force: true });
    removed.push(name);
  }
  if (j.targetCreated) {
    const left = await fsp.readdir(target).catch(() => [] as string[]);
    if (left.every((n) => IGNORABLE.has(n))) {
      await fsp.rm(target, { recursive: true, force: true });
      removed.push(`(폴더) ${target}`);
    }
  }
  return removed;
}

/** 앱 폴더 안의 임시 경로만 지운다 */
export async function removeTempPath(p: string) {
  const r = path.resolve(p);
  if (!isInsidePath(r, BLOCKPILOT_HOME) || samePath(r, BLOCKPILOT_HOME)) return;
  await fsp.rm(r, { recursive: true, force: true });
}
