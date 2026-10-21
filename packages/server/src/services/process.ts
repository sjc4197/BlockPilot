import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import type { ConsoleLine, ProcessStatus } from "@blockpilot/shared";
import { conflict, badRequest } from "../lib/errors.js";
import { LineSplitter } from "../lib/lines.js";
import { platform } from "./platform/index.js";
import { detectServer } from "./serverInfo.js";
import { readPropertiesFile, toRecord } from "./properties.js";
import { rconOnce, stripColor, RconError } from "./rcon.js";

const HISTORY_SIZE = 500;
/** Windows pause 안내 (영어·한국어) */
const PAUSE_PROMPT = /Press any key to continue|계속하려면 아무 키나 누르십시오/i;
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
  private splitters: LineSplitter[] = [];
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
    let verbatim = false;
    if (info.startScript) {
      // 이 OS 의 시작 스크립트(start.sh / start.bat)를 그대로 실행 → 메모리 등은 스크립트 설정을 따른다
      ({ cmd, args, verbatim = false } = platform.scriptCommand(info.startScript));
    } else if (info.launchJar) {
      cmd = platform.javaExe;
      args = ["-Xms2G", "-Xmx4G", "-jar", info.launchJar, "nogui"];
    } else {
      throw badRequest(`실행할 시작 스크립트(${platform.startScripts.join(", ")}) 또는 서버 jar를 찾지 못했습니다.`);
    }

    this.ready = false;
    this.stopping = false;
    this.players.clear();
    this.externalCache = null;
    this.startedAt = new Date().toISOString();
    if (!info.startScript && info.foreignScript) {
      this.pushLine("system", `${info.foreignScript} 는 다른 OS 용 시작 스크립트라 쓰지 않고 서버 jar 를 직접 실행해요.`);
    }
    this.pushLine("system", `$ ${cmd} ${args.join(" ")}`);

    const child = spawn(cmd, args, {
      cwd: this.dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...platform.childEnv() },
      ...platform.spawnOptions(),
      windowsVerbatimArguments: verbatim,
    });
    this.child = child;

    this.splitters = (["stdout", "stderr"] as const).map((source) => {
      const sp = new LineSplitter(platform.decode, (line) => {
        this.pushLine(source, line);
        this.inspect(line);
      });
      child[source]!.on("data", (d: Buffer) => {
        sp.push(d);
        // pause 안내는 줄바꿈 없이 나오므로 남은 조각도 본다
        if (PAUSE_PROMPT.test(sp.pending())) this.child?.stdin?.end("\r\n");
      });
      return sp;
    });
    child.on("error", (e) => this.pushLine("system", `프로세스 오류: ${e.message}`));
    child.on("exit", (code, signal) => {
      for (const sp of this.splitters) sp.flush();
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
    this.pushLine("system", "응답이 없어 종료 요청을 보냈어요 (시작 스크립트와 java 모두)");
    platform.killTree(child, false);
    if (await this.waitExit(child, KILL_GRACE_MS)) return;
    this.pushLine("system", "강제 종료");
    platform.killTree(child, true);
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

  /**
   * 서버가 켜져 있으면 자동 저장을 멈추고(save-off) 지금까지 내용을 디스크에 쓴 뒤(save-all flush) fn 을 실행하고,
   * 끝나면 자동 저장을 다시 켠다(save-on). 백업 zip 이 쓰는 도중의 월드 파일을 담지 않게 하기 위함.
   * 꺼져 있으면 fn 만 실행한다.
   */
  async withSavesPaused<T>(fn: () => Promise<T>): Promise<T> {
    if (!(await this.tryCommand("save-off"))) return fn();
    try {
      const saved = this.waitForLine(/Saved the game/i, 15_000);
      await this.tryCommand("save-all flush");
      await saved;
      return await fn();
    } finally {
      await this.tryCommand("save-on").catch(() => {});
    }
  }

  /** 다음 출력 줄 중 pattern 에 맞는 줄을 기다린다 (RCON 응답도 출력으로 들어온다). 시간이 지나면 그냥 진행 */
  private waitForLine(pattern: RegExp, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off("line", onLine);
        resolve();
      };
      const onLine = (l: ConsoleLine) => {
        if (pattern.test(l.text)) done();
      };
      const timer = setTimeout(done, ms);
      this.on("line", onLine);
    });
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

  /** 로그 줄에서 상태 변화를 읽어낸다 */
  private inspect(line: string) {
    // Windows start.bat 끝의 pause: java 가 끝났는데 cmd 가 키 입력을 기다리면 넘겨 준다
    if (PAUSE_PROMPT.test(line)) {
      this.child?.stdin?.end("\r\n");
      return;
    }
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

/** 서버를 지운 뒤 프로세스 관리 객체도 잊는다 */
export function forgetManaged(id: string) {
  registry.delete(id);
}
