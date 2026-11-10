import fsp from "node:fs/promises";
import path from "node:path";
import type { InstallContext, LaunchSpec } from "./types.js";
import { downloadFile, fetchText, headSize } from "../download.js";
import { CreateError } from "../errors.js";
import { runInstaller } from "../installer.js";

/**
 * Forge·NeoForge 공통: maven 에서 설치기 jar 를 받아 sha256 으로 검증하고, 설치기를 서버 모드로 실행한다.
 * 설치기가 Minecraft 서버 파일과 라이브러리를 직접 받고(설치 프로필의 해시로 스스로 검증) 인자 파일
 * (libraries/<그룹>/<버전>/unix_args.txt · win_args.txt) 을 만든다. 시작 스크립트는 그 인자 파일로 띄운다.
 */

export interface InstallerSpec {
  label: "Forge" | "NeoForge";
  /** 설치기 jar 주소. 같은 주소 + ".sha256" 에 해시가 있다 */
  url: string;
  fileName: string;
  /** 설치기에 넘길 서버 설치 옵션 (대상 폴더 앞) */
  serverFlag: string;
  /** 설치 결과 인자 파일이 있어야 하는 폴더 (서버 폴더 기준, POSIX 구분자) */
  argsDir: string;
}

/** maven 의 .sha256 파일. 해시만 있거나 "해시  파일명" 형식 */
export async function mavenSha256(url: string, what: string, signal?: AbortSignal): Promise<string> {
  const text = await fetchText(`${url}.sha256`, { signal });
  const hash = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash ?? "")) throw new CreateError("http_error", `${what} 설치기의 해시를 읽지 못했어요.`, "잠시 후 다시 시도해 주세요.", `${url}.sha256`);
  return hash;
}

export async function installerSizeMb(url: string, signal?: AbortSignal): Promise<number | undefined> {
  const n = await headSize(url, { signal });
  return n ? n / 1048576 : undefined;
}

export async function installWithInstaller(ctx: InstallContext, spec: InstallerSpec): Promise<LaunchSpec> {
  const { job, target, java, tmp } = ctx;
  job.skipStep("server-jar", `${spec.label} 설치기가 Minecraft 서버 파일을 직접 받아요`);
  job.startStep("loader", "설치기 해시 확인 중");
  const sha256 = await mavenSha256(spec.url, spec.label, job.signal);

  job.note("loader", "설치기 받는 중");
  const installerJar = path.join(tmp, spec.fileName);
  await downloadFile({ url: spec.url, dest: installerJar, hash: { algo: "sha256", expected: sha256 }, signal: job.signal, onProgress: (d, t) => job.progress("loader", d, t) });
  job.clearProgress("loader");
  job.note("loader", "설치기가 Minecraft 서버와 라이브러리를 받는 중 (수백 MB, 몇 분 걸릴 수 있어요)");
  const out = await runInstaller(job, java.path, ["-jar", installerJar, spec.serverFlag, target], tmp, spec.label);
  if (out.code !== 0) {
    throw new CreateError("installer_failed", `${spec.label} 설치기가 실패했어요.`, "인터넷 연결을 확인한 뒤 다시 시도해 주세요. 계속되면 다른 버전을 골라 보세요.", out.tail);
  }
  const argsDir = path.join(target, ...spec.argsDir.split("/"));
  for (const f of ["unix_args.txt", "win_args.txt"]) {
    if (!(await exists(path.join(argsDir, f)))) {
      throw new CreateError("installer_failed", `${spec.label} 설치기가 실행에 필요한 파일(${f})을 만들지 않았어요.`, "다시 시도해 주세요. 계속되면 다른 버전을 골라 보세요.", `${spec.argsDir}/${f}\n${out.tail}`);
    }
  }
  // 설치기가 서버 폴더에 로그를 남겼다면 치운다 (요즘 설치기는 jar 옆=tmp 에 남겨 보통 없음). run.sh · run.bat · user_jvm_args.txt 는 그대로 둔다 (BlockPilot 은 start.sh/.bat 로 켠다)
  await fsp.rm(path.join(target, "installer.log"), { force: true });
  job.finishStep("loader", `설치기 sha256 일치 · 라이브러리는 설치기가 검증`);
  return { kind: "argsFile", dir: spec.argsDir };
}

async function exists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
