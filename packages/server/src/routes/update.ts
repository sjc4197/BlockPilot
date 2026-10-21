import type { FastifyInstance } from "fastify";
import { APP_VERSION } from "../lib/appInfo.js";
import { HttpError } from "../lib/errors.js";

const RELEASES = "https://github.com/sjc4197/BlockPilot/releases";

/** "1.2.3" 비교 (앞의 v 는 무시) */
export function newerThan(a: string, b: string): boolean {
  const p = (s: string) => s.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export async function updateRoutes(app: FastifyInstance) {
  // 사용자가 "업데이트 확인"을 눌렀을 때만 GitHub 에 최신 릴리스를 묻는다
  app.post("/api/update-check", async () => {
    let res: Response;
    try {
      res = await fetch(process.env.BLOCKPILOT_RELEASES_API ?? "https://api.github.com/repos/sjc4197/BlockPilot/releases/latest", {
        headers: { accept: "application/vnd.github+json", "user-agent": `BlockPilot/${APP_VERSION}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new HttpError(502, "update_check_failed", "GitHub 에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
    if (res.status === 404) return { current: APP_VERSION, newer: false, url: RELEASES, note: "아직 올라온 릴리스가 없어요." };
    if (!res.ok) throw new HttpError(502, "update_check_failed", `GitHub 오류 (${res.status})`);
    const j = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = j.tag_name?.replace(/^v/, "");
    return { current: APP_VERSION, latest, newer: !!latest && newerThan(latest, APP_VERSION), url: j.html_url ?? RELEASES };
  });
}
