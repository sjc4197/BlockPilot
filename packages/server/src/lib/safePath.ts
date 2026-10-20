import path from "node:path";
import { badRequest } from "./errors.js";

/**
 * root 하위의 경로만 허용. 서버 폴더 밖으로 나가는 접근(`../`, 절대경로)은 거부.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw badRequest("서버 폴더 밖의 경로는 접근할 수 없습니다.");
  }
  return target;
}

/** 파일명에 경로 구분자나 상위 이동이 섞여 있으면 거부 */
export function assertPlainFilename(name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw badRequest("잘못된 파일 이름입니다.");
  }
  return name;
}
