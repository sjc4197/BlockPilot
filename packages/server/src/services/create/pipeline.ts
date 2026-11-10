import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CREATE_LOADER_LABEL } from "@blockpilot/shared";
import { BLOCKPILOT_HOME, addServer } from "../../config/store.js";
import { validatePropertyChange, writePropertiesChanges } from "../properties.js";
import { writeList } from "../playerLists.js";
import { lookupProfile } from "../mojang.js";
import { CreateError, toCreateError } from "./errors.js";
import { currentArch, findCachedRuntime, findSystemJava, installRuntime, type JavaRuntime } from "./java.js";
import { getVersionInfo } from "./loaders/mojang.js";
import { providers as defaultProviders, providerOf as providerFrom } from "./loaders/index.js";
import type { LaunchSpec, LoaderProvider } from "./loaders/types.js";
import { prepareTarget } from "./target.js";
import type { CreateJob } from "./job.js";
import { LineSplitter } from "../../lib/lines.js";
import { platform, systemInfo } from "../platform/index.js";

/**
 * 새 서버 만들기 단계 구현. 로더 차이는 loaders/ 의 공급자가, OS 차이는 platform 모듈이 맡는다.
 * 배포처 함수는 deps 로 받는다 — 테스트에서 일부러 틀린 해시를 넣어 실패·정리를 확인하기 위해.
 */

export const defaultDeps = { getVersionInfo, findSystemJava, findCachedRuntime, installRuntime, lookupProfile, providers: defaultProviders };
export type PipelineDeps = typeof defaultDeps;

const MB = 1024 * 1024;
const FIRST_RUN_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 60_000;

/** 로더별로 서버 파일·라이브러리·첫 월드에 필요한 여유 공간 */
const FREE_SPACE_MB: Record<string, number> = { vanilla: 700, fabric: 700, paper: 1024, forge: 1536, neoforge: 1536 };

export function createPipeline(deps: PipelineDeps = defaultDeps) {
  return async function run(job: CreateJob): Promise<string> {
    const inp = job.input;
    const { mcVersion: mc, loaderVersion } = inp;
    const provider: LoaderProvider = deps.providers[inp.loader] ?? providerFrom(inp.loader);
    const loaderLabel = CREATE_LOADER_LABEL[inp.loader];

    // ---------- 1. 사전 점검 ----------
    job.startStep("preflight");
    const sys = systemInfo();
    const arch = currentArch();
    if (!sys.support.create || !arch) {
      throw new CreateError("unsupported_platform", sys.reason ?? "이 컴퓨터에서는 새 서버 만들기를 지원하지 않아요.", "이미 만든 서버 폴더는 '이미 있는 서버 폴더 추가'로 연결할 수 있어요.");
    }
    const here = platform.words.thisComputer;

    const prep = await prepareTarget(inp.path);
    const target = prep.target;

    for (const [k, v] of Object.entries(inp.properties)) {
      try {
        validatePropertyChange(k, v);
      } catch (e) {
        throw new CreateError("invalid_setting", `기본 설정 값이 올바르지 않아요: ${(e as Error).message}`, "값을 고친 뒤 다시 시도해 주세요.");
      }
    }
    if (provider.info.hasVersions && !loaderVersion) {
      throw new CreateError("invalid_setting", `${provider.info.versionLabel} 을(를) 골라 주세요.`, "버전 칸에서 하나를 고른 뒤 다시 시도해 주세요.");
    }

    const totalMb = Math.floor(os.totalmem() / MB);
    if (inp.memory.maxMb > totalMb * 0.9) {
      throw new CreateError("memory", `최대 메모리(${gb(inp.memory.maxMb)})가 ${here}의 메모리(${gb(totalMb)})에 비해 너무 커요.`, `최대 메모리를 ${gb(Math.floor(totalMb * 0.75))} 이하로 줄여 주세요.`);
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

    await ensureFreeSpace(path.dirname(target), (FREE_SPACE_MB[inp.loader] ?? 1024) * MB, "서버 파일");

    await job.openJournal({ target, targetCreated: !prep.existed, preexisting: prep.preexisting });
    if (!prep.existed) await fsp.mkdir(target);
    job.finishStep("preflight", target);

    // ---------- 2. 버전 정보 ----------
    job.startStep("versions");
    const info = await deps.getVersionInfo(mc, job.signal);
    if (provider.info.hasVersions) await provider.assertVersion(mc, loaderVersion, job.signal);
    const javaMajor = await provider.javaMajor(mc, info.javaMajor, job.signal);
    job.finishStep("versions", `Minecraft ${mc} · ${provider.info.hasVersions ? `${loaderLabel} ${loaderVersion}` : loaderLabel} · Java ${javaMajor} 필요`);

    // ---------- 3. Java ----------
    job.startStep("java", `Java ${javaMajor} 찾는 중`);
    let java: JavaRuntime | null = await deps.findSystemJava(javaMajor);
    if (!java) java = await deps.findCachedRuntime(javaMajor, arch);
    if (java) {
      job.finishStep("java", `${java.source === "system" ? `${here}에 설치된` : "앱 폴더에 받아 둔"} Java ${java.version} 사용`);
    } else {
      await ensureFreeSpace(BLOCKPILOT_HOME, 500 * MB, "Java");
      job.note("java", `Java ${javaMajor} 를 앱 폴더에 받는 중 (시스템에는 설치하지 않아요)`);
      java = await deps.installRuntime(javaMajor, arch, {
        signal: job.signal,
        onProgress: (d, t) => job.progress("java", d, t),
        onTempDir: (dir) => void job.addTempPath(dir),
      });
      const runtimeDir = path.relative(BLOCKPILOT_HOME, java.path).split(path.sep).slice(0, 2).join("/");
      job.finishStep("java", `Java ${java.version} 를 앱 폴더(${runtimeDir})에 받았어요`);
    }

    // ---------- 4·5. 서버 파일 · 로더 설치 (공급자가 두 단계를 진행하거나 건너뛴다) ----------
    const tmp = path.join(BLOCKPILOT_HOME, "tmp", job.id);
    await job.addTempPath(tmp);
    await fsp.mkdir(tmp, { recursive: true });
    const launch = await provider.install({ job, target, mc, loaderVersion, java, tmp, server: info.server });
    await fsp.rm(tmp, { recursive: true, force: true });
    job.throwIfCancelled();

    // ---------- 6. 설정 파일 ----------
    job.startStep("config");
    const scriptName = await writeStartScript(target, java.path, inp.memory.minMb, inp.memory.maxMb, launch);
    await writePropertiesChanges(target, inp.properties);
    await writeEula(target, inp.eulaAccepted);
    if (owner) {
      await writeList(target, "whitelist", [{ uuid: owner.id, name: owner.name }]);
      await writeList(target, "ops", [{ uuid: owner.id, name: owner.name, level: 4, bypassesPlayerLimit: false }]);
    }
    job.finishStep("config", owner ? `${scriptName} · server.properties · eula.txt · ${owner.name} 을(를) OP·화이트리스트에 추가` : `${scriptName} · server.properties · eula.txt`);

    // ---------- 7. 최초 실행 ----------
    job.startStep("first-run", inp.loader === "paper" ? "Paper 가 Minecraft 서버 파일을 받고 월드를 만드는 중 (처음엔 2~3분 걸릴 수 있어요)" : "월드를 만드는 중 (처음엔 1~2분 걸릴 수 있어요)");
    await firstRun(job, target, scriptName);
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

/** 이 OS 의 시작 스크립트(start.sh / start.bat)를 java 경로·메모리·실행 방식을 고정해 만든다 */
async function writeStartScript(target: string, javaPath: string, minMb: number, maxMb: number, launch: LaunchSpec) {
  const script = platform.startScriptFor(javaPath, minMb, maxMb, launch);
  await fsp.writeFile(path.join(target, script.name), script.body, script.mode ? { mode: script.mode } : undefined);
  return script.name;
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
  // Paper 는 첫 실행 때 Mojang 서버 파일을 받아 패치한다 (Paperclip)
  if (/Failed to download|Hash check failed for downloaded file|Failed to download original jar/i.test(log)) return { code: "network", message: "서버가 첫 실행 때 받아야 하는 파일(Minecraft 서버·라이브러리)을 받지 못했어요.", hint: "인터넷 연결을 확인한 뒤 다시 시도해 주세요." };
  // Forge·NeoForge 가 필수 의존성을 못 찾았을 때 (보통 모드 폴더에 뭔가 들어갔을 때)
  if (/Missing or unsupported mandatory dependencies/i.test(log)) return { code: "server_exited", message: "모드 로더가 필요한 의존성을 찾지 못했어요.", hint: "다시 시도해 주세요. 계속되면 다른 로더 버전을 골라 보세요." };
  return { code: "server_exited", message: "서버가 준비를 마치기 전에 꺼졌어요.", hint: "아래 로그 마지막 줄에 원인이 있어요. 설정을 바꿔 다시 시도해 주세요." };
}

/** 시작 스크립트로 켜서 Done 이 뜨면 stop 을 보내고 정상 종료를 기다린다 */
function firstRun(job: CreateJob, target: string, scriptName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cmd, args, verbatim } = platform.scriptCommand(scriptName);
    const child = spawn(cmd, args, { cwd: target, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...platform.childEnv() }, ...platform.spawnOptions(), windowsVerbatimArguments: verbatim });
    job.trackChild(child);
    child.stdin!.on("error", () => {
      /* 서버가 먼저 끝나 입력 파이프가 닫힌 경우 — 종료 처리는 exit 에서 */
    });
    const recent: string[] = [];
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

    const onLine = (line: string) => {
      if (!line) return;
      job.appendLog(line);
      recent.push(line);
      if (recent.length > 60) recent.shift();
      const spawnArea = line.match(/Preparing spawn area: (\d+)%/);
      if (spawnArea) job.note("first-run", `스폰 지역 준비 중 ${spawnArea[1]}%`);
      // Paperclip: "Downloading mojang_1.21.1.jar" → 패치 → "Starting org.bukkit.craftbukkit.Main"
      else if (/^Downloading (mojang_|\S+\.jar)/.test(line)) job.note("first-run", "Paper 가 Minecraft 서버 파일을 받는 중");
      else if (/^Starting org\.bukkit/.test(line)) job.note("first-run", "Paper 준비 완료 — 월드를 만드는 중");
      if (!done && /\]: Done \(/.test(line)) {
        done = true;
        job.note("first-run", "Done 확인 — 서버를 끄는 중");
        child.stdin!.write("stop\n");
        stopTimer = setTimeout(() => {
          platform.killTree(child, false);
          setTimeout(() => platform.killTree(child, true), 10_000).unref();
        }, STOP_TIMEOUT_MS);
      }
    };
    const splitters = [new LineSplitter(platform.decode, onLine), new LineSplitter(platform.decode, onLine)];
    child.stdout!.on("data", (d: Buffer) => splitters[0].push(d));
    child.stderr!.on("data", (d: Buffer) => splitters[1].push(d));

    const timeout = setTimeout(() => {
      platform.killTree(child, true);
      finish(new CreateError("first_run_timeout", "최초 실행이 10분 안에 끝나지 않았어요.", `${platform.words.thisComputer}가 많이 느리거나 메모리가 부족할 수 있어요. 다른 프로그램을 닫고 다시 시도해 주세요.`, recent.slice(-20).join("\n")));
    }, FIRST_RUN_TIMEOUT_MS);

    child.once("error", (e) => finish(new CreateError("java_failed", "서버를 실행하지 못했어요.", "다시 시도해 주세요.", e.message)));
    child.once("exit", (code, signal) => {
      for (const sp of splitters) sp.flush();
      if (job.signal.aborted) return finish(new CreateError("cancelled", "만들기를 취소했어요."));
      if (done) return finish();
      const why = explainServerFailure(recent.join("\n"));
      finish(new CreateError(why.code, why.message, why.hint, `종료 코드 ${code ?? signal}\n${recent.slice(-20).join("\n")}`));
    });
  });
}
