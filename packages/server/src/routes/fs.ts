import type { FastifyInstance } from "fastify";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FsListing } from "@blockpilot/shared";
import { listServers } from "../config/store.js";
import { CreateError } from "../services/create/errors.js";
import { IGNORABLE, expandHome } from "../services/create/target.js";
import { platform } from "../services/platform/index.js";

const MAX_ENTRIES = 300;

/** 경로를 화면에 보여 줄 조각으로. "C:\Users\me" → [C:\, Users, me] / "/home/me" → [/, home, me] */
function crumbsOf(dir: string): FsListing["crumbs"] {
  const root = path.parse(dir).root;
  const parts = dir.slice(root.length).split(path.sep).filter(Boolean);
  const out: FsListing["crumbs"] = [{ label: root, path: root }];
  let acc = root;
  for (const p of parts) {
    acc = path.join(acc, p);
    out.push({ label: p, path: acc });
  }
  return out;
}

/** 아직 없는 경로면 있는 상위 폴더까지 올라간다 (새 서버 폴더 기본값처럼 아직 없는 경로로 열 때) */
async function nearestExisting(dir: string): Promise<string> {
  let cur = dir;
  for (;;) {
    const st = await fsp.stat(cur).catch(() => null);
    if (st?.isDirectory()) return cur;
    const up = path.dirname(cur);
    if (up === cur) return os.homedir();
    cur = up;
  }
}

/**
 * 폴더 찾기용. 폴더 이름만 보여 주고 파일 내용은 읽지 않는다.
 * 숨김 폴더(OS 별 규칙)는 감춘다.
 */
export async function fsRoutes(app: FastifyInstance) {
  app.get("/api/fs/list", async (req): Promise<FsListing> => {
    const { path: raw, nearest } = req.query as { path?: string; nearest?: string };
    const home = os.homedir();
    let dir = path.resolve(expandHome(raw?.trim() || home));
    if (!path.isAbsolute(dir)) throw new CreateError("invalid_path", `전체 경로를 입력해 주세요 (예: ${platform.pathExample}).`);
    if (nearest === "1") dir = await nearestExisting(dir);

    let names: string[];
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) throw new CreateError("invalid_path", "폴더가 아니에요.", "폴더를 골라 주세요.");
      names = await fsp.readdir(dir);
    } catch (e) {
      if (e instanceof CreateError) throw e;
      const code = (e as { code?: string }).code;
      if (code === "ENOENT") throw new CreateError("invalid_path", "없는 폴더예요.", "경로를 확인해 주세요.");
      throw new CreateError("no_permission", "이 폴더를 볼 권한이 없어요.", "다른 폴더를 골라 주세요. 권한을 묻는 창이 뜨면 허용해 주세요.");
    }

    const servers = new Set((await listServers()).map((s) => platform.pathKey(s.path)));
    const dirs: FsListing["entries"] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b, "ko"))) {
      if (platform.isHiddenEntry(name) || dirs.length >= MAX_ENTRIES) continue;
      const full = path.join(dir, name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st?.isDirectory()) continue;
      const inner = await fsp.readdir(full).catch(() => null);
      dirs.push({ name, path: full, empty: inner ? inner.every((n) => IGNORABLE.has(n)) : null, isServer: servers.has(platform.pathKey(full)) });
    }

    const shortcuts: FsListing["shortcuts"] = [];
    for (const s of await platform.folderShortcuts()) {
      if (await fsp.stat(s.path).then((x) => x.isDirectory(), () => false)) shortcuts.push(s);
    }

    return {
      path: dir,
      parent: dir === path.parse(dir).root ? null : path.dirname(dir),
      home,
      crumbs: crumbsOf(dir),
      empty: names.every((n) => IGNORABLE.has(n)),
      isServer: servers.has(platform.pathKey(dir)),
      entries: dirs,
      truncated: dirs.length >= MAX_ENTRIES,
      shortcuts,
    };
  });
}
