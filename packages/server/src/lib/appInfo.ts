import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKPILOT_HOME } from "../config/store.js";

/**
 * 앱 버전과 실행 방식.
 * - 단일 실행 파일(SEA)로 빌드할 때 esbuild 가 __BLOCKPILOT_VERSION__ 을 채운다
 * - npm start / 개발 중에는 package.json 의 version
 */
declare const __BLOCKPILOT_VERSION__: string | undefined;

function readPackageVersion(): string {
  // packages/server/src/lib → 저장소 루트 package.json
  for (const up of ["../../../../package.json", "../../../package.json"]) {
    try {
      const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), up);
      const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
      if (typeof v === "string") return v;
    } catch {
      /* 다음 후보 */
    }
  }
  return "dev";
}

export const APP_VERSION: string = typeof __BLOCKPILOT_VERSION__ === "string" ? __BLOCKPILOT_VERSION__ : readPackageVersion();

type Sea = { isSea(): boolean; getAsset(key: string, encoding?: string): ArrayBuffer | string };
let seaMod: Sea | null | undefined;
async function sea(): Promise<Sea | null> {
  if (seaMod !== undefined) return seaMod;
  try {
    seaMod = (await import("node:sea")) as unknown as Sea;
  } catch {
    seaMod = null;
  }
  return seaMod;
}

/** 단일 실행 파일로 실행 중인지 */
export async function isSingleExecutable(): Promise<boolean> {
  return (await sea())?.isSea() ?? false;
}

/**
 * 웹 화면 파일 폴더.
 * - 단일 실행 파일: 안에 든 파일을 ~/.blockpilot/app/<버전>/web 에 한 번 풀어 두고 그 폴더를 쓴다
 * - npm start: packages/web/dist
 */
export async function webRoot(moduleDir: string): Promise<string | undefined> {
  const s = await sea();
  if (s?.isSea()) {
    const dir = path.join(BLOCKPILOT_HOME, "app", APP_VERSION, "web");
    const done = path.join(dir, ".complete");
    if (!fs.existsSync(done)) {
      await fsp.rm(dir, { recursive: true, force: true });
      const files = JSON.parse(s.getAsset("web-manifest.json", "utf8") as string) as string[];
      for (const rel of files) {
        if (rel.includes("..") || path.isAbsolute(rel)) continue;
        const out = path.join(dir, rel);
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.writeFile(out, Buffer.from(s.getAsset(`web/${rel}`) as ArrayBuffer));
      }
      await fsp.writeFile(done, APP_VERSION);
    }
    return dir;
  }
  return [path.resolve(moduleDir, "../../web/dist"), path.resolve(moduleDir, "../../../web/dist")].find((p) => fs.existsSync(path.join(p, "index.html")));
}
