import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import type { ConsoleLine, ProcessStatus } from "@blockpilot/shared";
import { conflict, badRequest } from "../lib/errors.js";
import { detectServer } from "./serverInfo.js";
import { readPropertiesFile, toRecord } from "./properties.js";
import { rconOnce, stripColor, RconError } from "./rcon.js";

const HISTORY_SIZE = 500;
const STOP_GRACE_MS = 30_000;
const KILL_GRACE_MS = 10_000;
const EXTERNAL_CACHE_MS = 4_000;

/**
 * 서버 하나의 프로세스와 콘솔을 관리한다.
 * - BlockPilot이 직접 띄운 서버: stdin/stdout 으로 제어
 * - 다른 곳에서 띄운 서버(external): server.properties 의 RCON 설정이 있으면 RCON으로 제어
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
  private externalCache: { at: number; status: ProcessStatus } | null = null;

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
    if (this.externalCache && Date.now() - this.externalCache.at < EXTERNAL_CACHE_MS) return this.externalCache.status;

    const props = await this.props();
    if (!(await this.isPortOpen(props))) {
      this.externalCache = null;
      return { state: "stopped", ready: false, onlinePlayers: [] };
    }
    // 외부 실행 중: RCON으로 접속자 목록까지 가져와 본다
    const status: ProcessStatus = { state: "external", ready: true, onlinePlayers: [], rcon: "disabled" };
    const rcon = rconConfig(props);
    if (rcon) {
      try {
        const res = await rconOnce(rcon.host, rcon.port, rcon.password, "list");
        status.rcon = "connected";
        status.onlinePlayers = parseList(stripColor(res));
      } catch {
        status.rcon = "failed";
      }
    }
    this.externalCache = { at: Date.now(), status };
    return status;
  }

  async start() {
    if (this.child) throw conflict("서버가 이미 실행 중입니다.");
    const props = await this.props();
    if (await this.isPortOpen(props)) throw conflict("서버 포트가 이미 사용 중입니다. 다른 곳에서 실행 중인지 확인하세요.");

    const info = await detectServer(this.dir);
    if (!info.eulaAccepted) throw badRequest("eula.txt 에 동의(eula=true)가 필요합니다.");

    let cmd: string;
    let args: string[];
    if (info.hasStartScript) {
      const script = await fs.access(path.join(this.dir, "start.sh")).then(() => "start.sh", () => "run.sh");
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
    this.externalCache = null;
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
    if (!child) {
      // 외부 실행 서버는 RCON stop 으로 시도
      const st = await this.status();
      if (st.state === "external" && st.rcon === "connected") {
        await this.rcon("stop");
        this.externalCache = null;
        return;
      }
      throw conflict("BlockPilot이 실행한 서버가 아니거나 이미 중지되어 있습니다.");
    }
    if (this.stopping) return;
    this.stopping = true;
    await this.emitStatus();
    this.pushLine("system", "stop 명령 전송, 월드 저장을 기다리는 중...");
    this.writeStdin("stop");

    if (await this.waitExit(child, STOP_GRACE_MS)) return;
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

  /** 콘솔 명령 전송. 직접 띄운 서버는 stdin, 외부 서버는 RCON. */
  async sendCommand(command: string): Promise<void> {
    const cmd = command.trim();
    if (!cmd) return;
    if (this.child) {
      this.pushLine("input", `> ${cmd}`);
      this.writeStdin(cmd);
      return;
    }
    const st = await this.status();
    if (st.state !== "external") throw conflict("서버가 실행 중이 아닙니다.");
    if (st.rcon !== "connected") {
      throw conflict("외부에서 실행 중인 서버입니다. server.properties 에서 enable-rcon=true 와 rcon.password 를 설정하고 서버를 재시작하면 여기서 제어할 수 있어요.");
    }
    this.pushLine("input", `> ${cmd}`);
    await this.rcon(cmd);
  }

  /** 실행 중(직접/외부)이면 명령 실행 후 true, 아니면 false (호출자가 파일 수정으로 fallback) */
  async tryCommand(command: string): Promise<boolean> {
    if (this.child) {
      if (!this.ready) return false;
      await this.sendCommand(command);
      return true;
    }
    const st = await this.status();
    if (st.state === "external" && st.rcon === "connected") {
      await this.sendCommand(command);
      return true;
    }
    return false;
  }

  /** 월드 저장을 강제한다 (백업 전). 실행 중이 아니면 아무것도 안 함. */
  async flushSaves(): Promise<boolean> {
    if (!(await this.tryCommand("save-all flush"))) return false;
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }

  // ---------- 내부 ----------

  private async rcon(cmd: string) {
    const props = await this.props();
    const cfg = rconConfig(props);
    if (!cfg) throw conflict("RCON이 설정되어 있지 않습니다.");
    try {
      const res = stripColor(await rconOnce(cfg.host, cfg.port, cfg.password, cmd));
      for (const line of res.split(/\r?\n/).filter(Boolean)) this.pushLine("stdout", `[RCON] ${line}`);
      this.externalCache = null;
    } catch (e) {
      const msg = e instanceof RconError ? e.message : String(e);
      this.pushLine("system", `RCON 오류: ${msg}`);
      throw conflict(msg);
    }
  }

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

  private async props(): Promise<Record<string, string>> {
    const { lines } = await readPropertiesFile(this.dir);
    return toRecord(lines);
  }

  private isPortOpen(props: Record<string, string>): Promise<boolean> {
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

function rconConfig(props: Record<string, string>) {
  if (props["enable-rcon"] !== "true") return null;
  const password = props["rcon.password"] ?? "";
  if (!password) return null;
  return { host: "127.0.0.1", port: Number(props["rcon.port"] ?? 25575), password };
}

/** "There are 2 of a max of 20 players online: Alice, Bob" → ["Alice","Bob"] */
export function parseList(text: string): string[] {
  const idx = text.indexOf("online:");
  if (idx < 0) return [];
  return text
    .slice(idx + 7)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

export function allManaged() {
  return [...registry.values()];
}

/** BlockPilot 종료 시 떠 있는 서버를 정상 종료 */
export async function shutdownAll() {
  await Promise.all([...registry.values()].filter((m) => m.isManaged()).map((m) => m.stop().catch(() => {})));
}
