import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/atomicWrite.js";

export const EULA_HEADER = "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).";

export interface EulaState {
  /** eula.txt 가 있는지 */
  exists: boolean;
  /** eula=true 가 들어 있는지 (serverInfo.detectServer 와 같은 판정) */
  accepted: boolean;
}

const eulaPath = (dir: string) => path.join(dir, "eula.txt");

export async function readEula(dir: string): Promise<EulaState> {
  const body = await fs.readFile(eulaPath(dir), "utf8").catch(() => null);
  if (body === null) return { exists: false, accepted: false };
  return { exists: true, accepted: /^\s*eula\s*=\s*true/im.test(body) };
}

/**
 * eula.txt 에 eula=true 를 쓴다. 주석·다른 줄은 그대로 두고 eula= 줄만 바꾼다 (없으면 끝에 덧붙임).
 * 파일이 없으면 Mojang 표준 주석 머리말과 함께 새로 만든다.
 * 호출하는 쪽(라우트)이 사용자의 명시적 동의(accepted: true)를 확인한 뒤에만 부른다.
 * 이미 eula=true 면 아무것도 쓰지 않는다 (.blockpilot-backup 에 사본이 쌓이지 않게).
 */
export async function acceptEula(dir: string): Promise<void> {
  if ((await readEula(dir)).accepted) return;
  const existing = await fs.readFile(eulaPath(dir), "utf8").catch(() => null);
  const stamp = `#${new Date().toISOString()} BlockPilot 대시보드에서 사용자가 직접 동의함`;
  let body: string;
  if (existing === null) {
    body = [EULA_HEADER, stamp, "eula=true", ""].join("\n");
  } else {
    const nl = existing.includes("\r\n") ? "\r\n" : "\n";
    const lines = existing.split(/\r?\n/);
    let replaced = false;
    const out = lines.map((line) => {
      if (!replaced && /^\s*eula\s*=/i.test(line)) {
        replaced = true;
        return "eula=true";
      }
      return line;
    });
    // 마지막 빈 줄(끝 개행) 앞에 넣는다
    if (out.length && out[out.length - 1] === "") out.pop();
    if (!replaced) out.push("eula=true");
    out.push("");
    body = out.join(nl);
  }
  await writeFileAtomic(eulaPath(dir), body);
}
