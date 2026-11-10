import { spawn } from "node:child_process";
import { CreateError } from "./errors.js";
import type { CreateJob } from "./job.js";
import { LineSplitter } from "../../lib/lines.js";
import { platform } from "../platform/index.js";

/** 설치기(Fabric·Forge·NeoForge)가 라이브러리를 수백 MB 받을 수 있어 넉넉히 */
export const INSTALLER_TIMEOUT_MS = 10 * 60_000;

/**
 * 설치기 같은 자식 프로세스를 실행하고 출력은 작업 로그로 보낸다. 취소하면 같이 종료된다.
 * 시간 초과면 강제 종료하고 timedOut 을 켠다.
 */
export function runInstaller(job: CreateJob, javaPath: string, args: string[], cwd: string, what: string, timeoutMs = INSTALLER_TIMEOUT_MS): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...platform.childEnv() }, ...platform.spawnOptions() });
    job.trackChild(child);
    const lines: string[] = [];
    let timedOut = false;
    const onLine = (line: string) => {
      if (!line) return;
      job.appendLog(line);
      lines.push(line);
      if (lines.length > 40) lines.shift();
    };
    const splitters = [new LineSplitter(platform.decode, onLine), new LineSplitter(platform.decode, onLine)];
    child.stdout!.on("data", (d: Buffer) => splitters[0].push(d));
    child.stderr!.on("data", (d: Buffer) => splitters[1].push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      platform.killTree(child, true);
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(new CreateError("java_failed", "Java 를 실행하지 못했어요.", "다시 시도해 주세요.", e.message));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      for (const sp of splitters) sp.flush();
      const tail = lines.slice(-15).join("\n");
      if (timedOut && !job.signal.aborted) {
        reject(new CreateError("installer_failed", `${what} 설치기가 ${Math.round(timeoutMs / 60_000)}분 안에 끝나지 않았어요.`, "인터넷이 느리거나 끊겼을 수 있어요. 연결을 확인한 뒤 다시 시도해 주세요.", tail));
        return;
      }
      resolve({ code, tail });
    });
  });
}
