import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { BLOCKPILOT_HOME, addServer } from "../../config/store.js";
import { validatePropertyChange, writePropertiesChanges } from "../properties.js";
import { writeList } from "../playerLists.js";
import { lookupProfile } from "../mojang.js";
import { downloadFile, hashFile } from "./download.js";
import { CreateError, toCreateError } from "./errors.js";
import { currentArch, findCachedRuntime, findSystemJava, installRuntime, type JavaRuntime } from "./java.js";
import { getLatestInstaller, getServerLibraries, getVersionInfo, listLoaders } from "./sources.js";
import { prepareTarget } from "./target.js";
import type { CreateJob } from "./job.js";

/**
 * 새 서버 만들기 단계 구현 (Fabric + macOS).
 * 배포처 함수는 deps 로 받는다 — 테스트에서 일부러 틀린 해시를 넣어 실패·정리를 확인하기 위해.
 */

export const defaultDeps = { getVersionInfo, listLoaders, getLatestInstaller, getServerLibraries, findSystemJava, findCachedRuntime, installRuntime, lookupProfile };
export type PipelineDeps = typeof defaultDeps;

const MB = 1024 * 1024;
const FIRST_RUN_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 60_000;

export function createPipeline(deps: PipelineDeps = defaultDeps) {
  return async function run(job: CreateJob): Promise<string> {
    const inp = job.input;
    const { mcVersion: mc, loaderVersion: loader } = inp;

    // ---------- 1. 사전 점검 ----------
    job.startStep("preflight");
    if (process.platform !== "darwin") {
      throw new CreateError("unsupported_platform", "새 서버 만들기는 아직 macOS 에서만 할 수 있어요.", "Linux·Windows 지원은 준비 중이에요. 이미 만든 서버 폴더는 '서버 폴더 추가'로 연결할 수 있어요.");
    }
    const arch = currentArch();
    if (!arch) throw new CreateError("unsupported_platform", `이 Mac 의 CPU(${process.arch})는 지원하지 않아요.`, "Apple Silicon 또는 Intel Mac 에서 실행해 주세요.");

    const prep = await prepareTarget(inp.path);
    const target = prep.target;

    for (const [k, v] of Object.entries(inp.properties)) {
      try {
        validatePropertyChange(k, v);
      } catch (e) {
        throw new CreateError("invalid_setting", `기본 설정 값이 올바르지 않아요: ${(e as Error).message}`, "값을 고친 뒤 다시 시도해 주세요.");
      }
    }

    const totalMb = Math.floor(os.totalmem() / MB);
    if (inp.memory.maxMb > totalMb * 0.9) {
      throw new CreateError("memory", `최대 메모리(${gb(inp.memory.maxMb)})가 이 Mac 의 메모리(${gb(totalMb)})에 비해 너무 커요.`, `최대 메모리를 ${gb(Math.floor(totalMb * 0.75))} 이하로 줄여 주세요.`);
    }

    const port = Number(inp.properties["server-port"] ?? 25565);
    if (!(await isPortFree(port))) {
      throw new CreateError("port_in_use", `포트 ${port} 를 이미 다른 프로그램이 쓰고 있어요.`, "다른 마인크래프트 서버가 켜져 있다면 끄거나, 기본 설정에서 포트를 바꿔 주세요.");
    }

    let owner: { id: string; name: string } | undefined;
    if (inp.ownerName) {
      try {
        owner = await deps.lookupProfile(inp.ownerName);
      } catch (e) {
        const msg = (e as Error).message;
        if (/찾을 수 없습니다/.test(msg)) throw new CreateError("nickname_not_found", `'${inp.ownerName}' 닉네임을 Mojang 에서 찾지 못했어요.`, "철자를 확인하거나, 닉네임 칸을 비우고 나중에 플레이어 화면에서 추가해 주세요.");
        throw toCreateError(e, { url: "https://api.mojang.com" });
      }
    }

    await ensureFreeSpace(path.dirname(target), 700 * MB, "서버 파일");

    await job.openJournal({ target, targetCreated: !prep.existed, preexisting: prep.preexisting });
    if (!prep.existed) await fsp.mkdir(target);
    job.finishStep("preflight", target);

    // ---------- 2. 버전 정보 ----------
    job.startStep("versions");
    const [info, loaders, installer, libraries] = await Promise.all([
      deps.getVersionInfo(mc, job.signal),
      deps.listLoaders(mc, job.signal),
      deps.getLatestInstaller(job.signal),
      deps.getServerLibraries(mc, loader, job.signal),
    ]);
    if (!loaders.some((l) => l.version === loader)) {
      throw new CreateError("not_found", `Fabric 로더 ${loader} 는 Minecraft ${mc} 를 지원하지 않아요.`, "목록에서 다른 로더 버전을 골라 주세요.");
    }
    job.finishStep("versions", `Minecraft ${mc} · Fabric ${loader} · Java ${info.javaMajor} 필요`);

    // ---------- 3. Java ----------
    job.startStep("java", `Java ${info.javaMajor} 찾는 중`);
    let java: JavaRuntime | null = await deps.findSystemJava(info.javaMajor);
    if (!java) java = await deps.findCachedRuntime(info.javaMajor, arch);
    if (java) {
      job.finishStep("java", `${java.source === "system" ? "이 Mac 에 설치된" : "앱 폴더에 받아 둔"} Java ${java.version} 사용`);
    } else {
      await ensureFreeSpace(BLOCKPILOT_HOME, 500 * MB, "Java");
      job.note("java", `Java ${info.javaMajor} 를 앱 폴더에 받는 중 (시스템에는 설치하지 않아요)`);
      java = await deps.installRuntime(info.javaMajor, arch, {
        signal: job.signal,
        onProgress: (d, t) => job.progress("java", d, t),
        onTempDir: (dir) => void job.addTempPath(dir),
      });
      const runtimeDir = path.relative(BLOCKPILOT_HOME, java.path).split(path.sep).slice(0, 2).join("/");
      job.finishStep("java", `Java ${java.version} 를 앱 폴더(${runtimeDir})에 받았어요`);
    }

    // ---------- 4. server.jar ----------
    job.startStep("server-jar", `${(info.server.size / MB).toFixed(1)} MB`);
    await downloadFile({
      url: info.server.url,
      dest: path.join(target, "server.jar"),
      hash: { algo: "sha1", expected: info.server.sha1 },
      expectedSize: info.server.size,
      signal: job.signal,
      onProgress: (d, t) => job.progress("server-jar", d, t),
    });
    job.finishStep("server-jar", "sha1 일치");

    // ---------- 5. Fabric ----------
    job.startStep("fabric", `설치기 ${installer.version}`);
    const tmp = path.join(BLOCKPILOT_HOME, "tmp", job.id);
    await job.addTempPath(tmp);
    const installerJar = path.join(tmp, `fabric-installer-${installer.version}.jar`);
    await downloadFile({ url: installer.url, dest: installerJar, hash: { algo: "sha256", expected: installer.sha256 }, signal: job.signal });
    const out = await runProcess(job, java.path, ["-jar", installerJar, "server", "-dir", target, "-mcversion", mc, "-loader", loader], tmp, 5 * 60_000);
    if (out.code !== 0) {
      throw new CreateError("installer_failed", "Fabric 설치기가 실패했어요.", "인터넷 연결을 확인한 뒤 다시 시도해 주세요. 계속되면 다른 로더 버전을 골라 보세요.", out.tail);
    }
    if (!(await exists(path.join(target, "fabric-server-launch.jar")))) {
      throw new CreateError("installer_failed", "Fabric 설치기가 실행 파일을 만들지 않았어요.", "다시 시도해 주세요.", out.tail);
    }
    job.note("fabric", "라이브러리 해시 확인 중");
    for (const lib of libraries) {
      const file = path.join(target, "libraries", lib.path);
      const digest = await hashFile(file, "sha256").catch(() => null);
      if (digest !== lib.sha256) {
        throw new CreateError(
          "hash_mismatch",
          `Fabric 라이브러리 ${lib.name} 가 공식 해시와 달라요.`,
          "다운로드 중에 파일이 손상됐거나 바뀌었을 수 있어요. 다시 시도해 주세요.",
          `sha256 기대값 ${lib.sha256}\nsha256 실제값 ${digest ?? "(파일 없음)"}\n${lib.path}`,
        );
      }
    }
    await fsp.rm(tmp, { recursive: true, force: true });
    job.finishStep("fabric", `라이브러리 ${libraries.length}개 sha256 일치`);

    // ---------- 6. 설정 파일 ----------
    job.startStep("config");
    await writeStartScript(target, java.path, inp.memory.minMb, inp.memory.maxMb);
    await writePropertiesChanges(target, inp.properties);
    await writeEula(target, inp.eulaAccepted);
    if (owner) {
      await writeList(target, "whitelist", [{ uuid: owner.id, name: owner.name }]);
      await writeList(target, "ops", [{ uuid: owner.id, name: owner.name, level: 4, bypassesPlayerLimit: false }]);
    }
    job.finishStep("config", owner ? `start.sh · server.properties · eula.txt · ${owner.name} 을(를) OP·화이트리스트에 추가` : "start.sh · server.properties · eula.txt");

    // ---------- 7. 최초 실행 ----------
    job.startStep("first-run", "월드를 만드는 중 (처음엔 1~2분 걸릴 수 있어요)");
    await firstRun(job, target);
    const level = inp.properties["level-name"] || "world";
    if (!(await exists(path.join(target, level)))) {
      throw new CreateError("server_exited", "서버가 켜졌다 꺼졌지만 월드 폴더가 만들어지지 않았어요.", "다시 시도해 주세요.", job.log.slice(-20).join("\n"));
    }
    job.finishStep("first-run", "Done 확인 후 정상 종료");

    // ---------- 8. 등록 ----------
    job.startStep("register");
    const server = await addServer({ path: target, name: inp.name });
    job.finishStep("register", server.name);
    return server.id;
  };
}

// ---------- 단계 도우미 ----------

const gb = (mb: number) => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)}GB`;

async function exists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "0.0.0.0", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function ensureFreeSpace(dir: string, bytes: number, what: string) {
  const st = await fsp.statfs(dir).catch(() => null);
  if (!st) return;
  const free = st.bavail * st.bsize;
  if (free < bytes) {
    throw new CreateError("disk_full", `디스크 공간이 부족해요 (${what}에 ${Math.ceil(bytes / MB)}MB 필요, 남은 공간 ${Math.floor(free / MB)}MB).`, "필요 없는 파일을 지워 공간을 확보한 뒤 다시 시도해 주세요.");
  }
}

/** 자식 프로세스를 실행하고 출력은 작업 로그로. 취소 시 같이 종료된다 */
function runProcess(job: CreateJob, cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    job.trackChild(child);
    const lines: string[] = [];
    const onData = (d: Buffer) => {
      const text = d.toString("utf8");
      job.appendLog(text);
      lines.push(...text.split(/\r?\n/).filter(Boolean));
      if (lines.length > 40) lines.splice(0, lines.length - 40);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(new CreateError("java_failed", "Java 를 실행하지 못했어요.", "다시 시도해 주세요.", e.message));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, tail: lines.slice(-15).join("\n") });
    });
  });
}

async function writeStartScript(target: string, javaPath: string, minMb: number, maxMb: number) {
  const q = javaPath.replace(/(["\\$`])/g, "\\$1");
  const body = [
    "#!/bin/bash",
    "# BlockPilot 이 만든 시작 스크립트",
    "# 메모리를 바꾸려면 -Xms(시작 메모리)와 -Xmx(최대 메모리) 값을 고치세요.",
    'cd "$(dirname "$0")"',
    `exec "${q}" -Xms${minMb}M -Xmx${maxMb}M -jar fabric-server-launch.jar nogui`,
    "",
  ].join("\n");
  const file = path.join(target, "start.sh");
  await fsp.writeFile(file, body, { mode: 0o755 });
}

/** eula=true 는 사용자가 폼에서 직접 체크했을 때만 쓴다 (입력 스키마가 literal(true) 를 강제) */
async function writeEula(target: string, accepted: boolean) {
  if (accepted !== true) throw new CreateError("eula_required", "Minecraft EULA 에 동의해야 서버를 만들 수 있어요.", "EULA 를 읽고 동의 체크박스를 직접 체크해 주세요.");
  const body = [
    "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).",
    `#${new Date().toISOString()} BlockPilot 의 새 서버 만들기 화면에서 사용자가 직접 동의함`,
    "eula=true",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(target, "eula.txt"), body);
}

/** 서버 출력에서 흔한 실패 원인을 찾아 한글 안내로 바꾼다 */
export function explainServerFailure(log: string): { code: CreateError["code"]; message: string; hint: string } {
  if (/FAILED TO BIND TO PORT/i.test(log)) return { code: "port_in_use", message: "서버 포트를 열지 못했어요. 다른 프로그램이 쓰고 있어요.", hint: "다른 마인크래프트 서버가 켜져 있다면 끄거나, 포트를 바꿔 다시 시도해 주세요." };
  if (/UnsupportedClassVersionError|requires running the game with Java/i.test(log)) return { code: "java_failed", message: "이 Minecraft 버전에 맞지 않는 Java 로 실행됐어요.", hint: "다시 시도해 주세요. 계속되면 아래 상세 내용을 알려 주세요." };
  if (/Could not reserve enough space|OutOfMemoryError|Invalid (maximum|initial) heap size/i.test(log)) return { code: "memory", message: "서버에 줄 메모리가 부족하거나 설정이 잘못됐어요.", hint: "기본 설정에서 최대 메모리를 줄인 뒤 다시 시도해 주세요." };
  if (/You need to agree to the EULA/i.test(log)) return { code: "eula_required", message: "EULA 동의가 반영되지 않았어요.", hint: "EULA 동의를 체크한 뒤 다시 시도해 주세요." };
  return { code: "server_exited", message: "서버가 준비를 마치기 전에 꺼졌어요.", hint: "아래 로그 마지막 줄에 원인이 있어요. 설정을 바꿔 다시 시도해 주세요." };
}

/** start.sh 로 켜서 Done 이 뜨면 stop 을 보내고 정상 종료를 기다린다 */
function firstRun(job: CreateJob, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["start.sh"], { cwd: target, stdio: ["pipe", "pipe", "pipe"] });
    job.trackChild(child);
    const recent: string[] = [];
    let buf = "";
    let done = false;
    let settled = false;
    const finish = (err?: CreateError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(stopTimer);
      if (err) reject(err);
      else resolve();
    };
    let stopTimer: NodeJS.Timeout | undefined;

    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (!line) continue;
        job.appendLog(line);
        recent.push(line);
        if (recent.length > 60) recent.shift();
        const spawnArea = line.match(/Preparing spawn area: (\d+)%/);
        if (spawnArea) job.note("first-run", `스폰 지역 준비 중 ${spawnArea[1]}%`);
        if (!done && /\]: Done \(/.test(line)) {
          done = true;
          job.note("first-run", "Done 확인 — 서버를 끄는 중");
          child.stdin.write("stop\n");
          stopTimer = setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
          }, STOP_TIMEOUT_MS);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CreateError("first_run_timeout", "최초 실행이 10분 안에 끝나지 않았어요.", "Mac 이 많이 느리거나 메모리가 부족할 수 있어요. 다른 프로그램을 닫고 다시 시도해 주세요.", recent.slice(-20).join("\n")));
    }, FIRST_RUN_TIMEOUT_MS);

    child.once("error", (e) => finish(new CreateError("java_failed", "서버를 실행하지 못했어요.", "다시 시도해 주세요.", e.message)));
    child.once("exit", (code, signal) => {
      if (job.signal.aborted) return finish(new CreateError("cancelled", "만들기를 취소했어요."));
      if (done) return finish();
      const why = explainServerFailure(recent.join("\n"));
      finish(new CreateError(why.code, why.message, why.hint, `종료 코드 ${code ?? signal}\n${recent.slice(-20).join("\n")}`));
    });
  });
}
