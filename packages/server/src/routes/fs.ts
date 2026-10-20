import type { FastifyInstance } from "fastify";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FsListing } from "@blockpilot/shared";
import { listServers } from "../config/store.js";
import { CreateError } from "../services/create/errors.js";
import { IGNORABLE, expandHome } from "../services/create/target.js";

const MAX_ENTRIES = 300;

/**
 * 폴더 찾기용. 폴더 이름만 보여 주고 파일 내용은 읽지 않는다.
 * 숨김 폴더(.으로 시작)는 감춘다.
 */
export async function fsRoutes(app: FastifyInstance) {
  app.get("/api/fs/list", async (req): Promise<FsListing> => {
    const { path: raw } = req.query as { path?: string };
    const home = os.homedir();
    const dir = path.resolve(expandHome(raw?.trim() || home));
    if (!path.isAbsolute(dir)) throw new CreateError("invalid_path", "전체 경로를 입력해 주세요.");

    let names: string[];
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) throw new CreateError("invalid_path", "폴더가 아니에요.", "폴더를 골라 주세요.");
      names = await fsp.readdir(dir);
    } catch (e) {
      if (e instanceof CreateError) throw e;
      const code = (e as { code?: string }).code;
      if (code === "ENOENT") throw new CreateError("invalid_path", "없는 폴더예요.", "경로를 확인해 주세요.");
      throw new CreateError("no_permission", "이 폴더를 볼 권한이 없어요.", "다른 폴더를 골라 주세요. macOS 가 권한을 물어보면 허용해 주세요.");
    }

    const servers = new Set((await listServers()).map((s) => path.resolve(s.path)));
    const dirs: FsListing["entries"] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b, "ko"))) {
      if (name.startsWith(".") || dirs.length >= MAX_ENTRIES) continue;
      const full = path.join(dir, name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st?.isDirectory()) continue;
      const inner = await fsp.readdir(full).catch(() => null);
      dirs.push({ name, path: full, empty: inner ? inner.every((n) => IGNORABLE.has(n)) : null, isServer: servers.has(full) });
    }

    const selfInner = names.filter((n) => !IGNORABLE.has(n));
    const shortcuts = [
      { label: "홈", path: home },
      { label: "데스크탑", path: path.join(home, "Desktop") },
      { label: "문서", path: path.join(home, "Documents") },
      { label: "Minecraft 서버", path: path.join(home, "Minecraft", "servers") },
    ];
    const volumes = await fsp.readdir("/Volumes").catch(() => [] as string[]);
    for (const v of volumes) if (!v.startsWith(".") && v !== "Macintosh HD") shortcuts.push({ label: v, path: path.join("/Volumes", v) });
    const existing = [];
    for (const s of shortcuts) if (await fsp.stat(s.path).then((x) => x.isDirectory(), () => false)) existing.push(s);

    return {
      path: dir,
      parent: dir === path.parse(dir).root ? null : path.dirname(dir),
      home,
      empty: selfInner.length === 0,
      isServer: servers.has(dir),
      entries: dirs,
      truncated: dirs.length >= MAX_ENTRIES,
      shortcuts: existing,
    };
  });
}
