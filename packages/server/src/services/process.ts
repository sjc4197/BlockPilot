import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import type { ConsoleLine, ProcessStatus } from "@blockpilot/shared";
import { conflict, badRequest } from "../lib/errors.js";
import { detectServer } from "./serverInfo.js";
import { readPropertiesFile, toRecord } from "./properties.js";

const HISTORY_SIZE = 500;
const STOP_GRACE_MS = 30_000;
const KILL_GRACE_MS = 10_000;

/**
 * 서버 하나의 프로세스와 콘솔을 관리한다.
 * events: "line" (ConsoleLine), "status" (ProcessStatus)
 */
export class ManagedServer extends EventEmitter {
  private child: ChildProcess | null = null;
  private history: ConsoleLine[] = [];
  private ready = false;
  private startedAt?: string;
  private stopping = false;
  private players = new Set<string>();
  private stdoutBuf = "";
  private stderrBuf = "";

  constructor(
    public readonly id: string,
    public readonly dir: string,
  ) {
    super();
    this.setMaxListeners(100);
  }

  getHistory() {
    return this.history;
  }

  isManaged() {
    return this.child !== null;
  }

  async status(): Promise<ProcessStatus> {
    if (this.child) {
      return {
        state: this.stopping ? "stopping" : this.ready ? "running" : "starting",
        pid: this.child.pid,
        startedAt: this.startedAt,
        ready: this.ready,
        onlinePlayers: [...this.players],
      };
    }
    // BlockPilot이 띄운 게 아닌데 포트가 열려 있으면 외부 실행 중
    if (await this.isPortOpen()) {
      return { state: "external", ready: true, onlinePlayers: [] };
    }
    return { state: "stopped", ready: false, onlinePlayers: [] };
  }

  async start() {
    if (this.child) throw conflict("서버가 이미 실행 중입니다.");
    if (await this.isPortOpen()) throw conflict("서버 포트가 이미 사용 중입니다. 다른 곳에서 실행 중인지 확인하세요.");

    const info = await detectServer(this.dir);
    if (!info.eulaAccepted) throw badRequest("eula.txt 에 동의(eula=true)가 필요합니다.");

    let cmd: string;
    let args: string[];
    if (info.hasStartScript) {
      const script = (await fs.access(path.join(this.dir, "start.sh")).then(() => "start.sh", () => "run.sh"));
      cmd = "bash";
      args = [script];
    } else if (info.launchJar) {
      cmd = "java";
      args = ["-Xms2G", "-Xmx4G", "-jar", info.launchJar, "nogui"];
    } else {
      throw badRequest("실행할 start.sh 또는 서버 jar를 찾지 못했습니다.");
    }

    this.ready = false;
    this.stopping = false;
    this.players.clear();
    this.startedAt = new Date().toISOString();
    this.pushLine("system", `$ ${cmd} ${args.join(" ")}`);

    const child = spawn(cmd, args, { cwd: this.dir, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child = child;

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => this.onData("stdout", d));
    child.stderr!.on("data", (d: string) => this.onData("stderr", d));
    child.on("error", (e) => this.pushLine("system", `프로세스 오류: ${e.message}`));
    child.on("exit", (code, signal) => {
      this.flushBuffers();
      this.pushLine("system", `서버 프로세스 종료 (code=${code ?? "null"}${signal ? `, signal=${signal}` : ""})`);
      this.child = null;
      this.ready = false;
      this.stopping = false;
      this.players.clear();
      void this.emitStatus();
    });
    await this.emitStatus();
  }

  async stop() {
    const child = this.child;
    if (!child) throw conflict("BlockPilot이 실행한 서버가 아니거나 이미 중지되어 있습니다.");
    if (this.stopping) return;
    this.stopping = true;
    await this.emitStatus();
    this.pushLine("system", "stop 명령 전송, 월드 저장을 기다리는 중...");
    this.writeStdin("stop");

    const exited = await this.waitExit(child, STOP_GRACE_MS);
    if (exited) return;
    this.pushLine("system", "응답이 없어 SIGTERM 전송");
    child.kill("SIGTERM");
    if (await this.waitExit(child, KILL_GRACE_MS)) return;
    this.pushLine("system", "강제 종료 (SIGKILL)");
    child.kill("SIGKILL");
    await this.waitExit(child, 5_000);
  }

  async restart() {
    if (this.child) await this.stop();
    await this.start();
  }

  sendCommand(command: string) {
    const cmd = command.trim();
    if (!cmd) return;
    if (!this.child) throw conflict("서버가 실행 중이 아닙니다.");
    this.pushLine("input", `> ${cmd}`);
    this.writeStdin(cmd);
  }

  /** 실행 중이면 콘솔 명령 실행 후 true, 아니면 false (호출자가 파일 수정으로 fallback) */
  tryCommand(command: string): boolean {
    if (!this.child || !this.ready) return false;
    this.sendCommand(command);
    return true;
  }

  // ---------- 내부 ----------

  private writeStdin(line: string) {
    this.child?.stdin?.write(line + "\n");
  }

  private onData(source: "stdout" | "stderr", chunk: string) {
    const key = source === "stdout" ? "stdoutBuf" : "stderrBuf";
    this[key] += chunk;
    const parts = this[key].split(/\r?\n/);
    this[key] = parts.pop() ?? "";
    for (const p of parts) {
      this.pushLine(source, p);
      this.inspect(p);
    }
  }

  private flushBuffers() {
    if (this.stdoutBuf) this.pushLine("stdout", this.stdoutBuf);
    if (this.stderrBuf) this.pushLine("stderr", this.stderrBuf);
    this.stdoutBuf = this.stderrBuf = "";
  }

  /** 로그 줄에서 상태 변화를 읽어낸다 */
  private inspect(line: string) {
    if (!this.ready && /\]: Done \(/.test(line)) {
      this.ready = true;
      void this.emitStatus();
      return;
    }
    let m = line.match(/\]: (\S+) joined the game/);
    if (m) {
      this.players.add(m[1]);
      void this.emitStatus();
      return;
    }
    m = line.match(/\]: (\S+) left the game/);
    if (m) {
      this.players.delete(m[1]);
      void this.emitStatus();
      return;
    }
    if (/\]: Stopping the server/.test(line) && !this.stopping) {
      this.stopping = true;
      void this.emitStatus();
    }
  }

  private pushLine(source: ConsoleLine["source"], text: string) {
    const line: ConsoleLine = { ts: Date.now(), text, source };
    this.history.push(line);
    if (this.history.length > HISTORY_SIZE) this.history.splice(0, this.history.length - HISTORY_SIZE);
    this.emit("line", line);
  }

  private async emitStatus() {
    this.emit("status", await this.status());
  }

  private waitExit(child: ChildProcess, ms: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, ms);
      const onExit = () => {
        clearTimeout(t);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  private async isPortOpen(): Promise<boolean> {
    const { lines } = await readPropertiesFile(this.dir);
    const props = toRecord(lines);
    const port = Number(props["server-port"] ?? 25565);
    return new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port });
      const done = (v: boolean) => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(500);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
    });
  }
}

const registry = new Map<string, ManagedServer>();

export function getManaged(id: string, dir: string): ManagedServer {
  let m = registry.get(id);
  if (!m || m.dir !== dir) {
    m = new ManagedServer(id, dir);
    registry.set(id, m);
  }
  return m;
}

/** BlockPilot 종료 시 떠 있는 서버를 정상 종료 */
export async function shutdownAll() {
  await Promise.all([...registry.values()].filter((m) => m.isManaged()).map((m) => m.stop().catch(() => {})));
}
