import path from "node:path";
import { platform } from "../services/platform/index.js";

/**
 * 경로 비교. Windows 는 대소문자를 구분하지 않으므로 OS 규칙(platform.pathKey)으로 맞춘 뒤 비교한다.
 */
export function samePath(a: string, b: string): boolean {
  return platform.pathKey(a) === platform.pathKey(b);
}

/** child 가 parent 와 같거나 그 안에 있는가 */
export function isInsidePath(child: string, parent: string): boolean {
  const c = platform.pathKey(child);
  const p = platform.pathKey(parent).replace(/[\\/]+$/, "");
  return c === p || c.startsWith(p + path.sep);
}

/** "~", "~/x", "~\x" 를 홈 폴더로 */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}
