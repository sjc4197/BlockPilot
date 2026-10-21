import { spawn } from "node:child_process";
import { platform } from "../services/platform/index.js";

/** 같은 포트에 BlockPilot 이 이미 켜져 있는지 */
export async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system`, { signal: AbortSignal.timeout(1500) });
    const j = (await res.json()) as { os?: string; words?: unknown };
    return res.ok && typeof j.os === "string" && !!j.words;
  } catch {
    return false;
  }
}

/** 기본 브라우저로 연다. 실패해도 조용히 넘어간다 (화면 없는 서버 등) */
export function openBrowser(url: string) {
  try {
    const [cmd, args] = platform.id === "macos" ? ["open", [url]] : platform.id === "windows" ? ["cmd.exe", ["/d", "/c", "start", '""', url]] : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: platform.id === "windows" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* 브라우저를 못 열면 주소만 안내 */
  }
}
