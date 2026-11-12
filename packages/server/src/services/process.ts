import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { ConsoleLine, ProcessStatus } from "@blockpilot/shared";
import { conflict, badRequest } from "../lib/errors.js";
import { LineSplitter } from "../lib/lines.js";
import { platform } from "./platform/index.js";
import type { ProcessInfo } from "./platform/types.js";
import { detectServer } from "./serverInfo.js";
import { readPropertiesFile, toRecord } from "./properties.js";
import { rconOnce, stripColor, RconError } from "./rcon.js";
import { emitServerEvent } from "./events.js";
import { analyzeCrash } from "./crash.js";

const HISTORY_SIZE = 500;
/** Windows pause 안내 (영어·한국어) */
const PAUSE_PROMPT = /Press any key to continue|계속하려면 아무 키나 누르십시오/i;
const STOP_GRACE_MS = 30_000;
const KILL_GRACE_MS = 10_000;
const EXTERNAL_CACHE_MS = 4_000;
/** 지난번 BlockPilot 이 남긴 서버를 끌 때 stop(RCON)·종료 신호 뒤에 기다리는 시간 */
const ORPHAN_STOP_GRACE_MS = 40_000;
/** 실행 기록의 시각과 실제 프로세스 시작 시각이 이보다 벌어지면 같은 pid 를 다른 프로그램이 받은 것으로 본다 */
const PID_REUSE_SLACK_MS = 120_000;

/**
 * 서버를 띄울 때 <서버 폴더>/.blockpilot/running.json 에 남기는 기록.
 * BlockPilot 만 죽고 서버가 남았을 때(orphan) 다시 켠 BlockPilot 이 알아보고 안전하게 끌 수 있게.
 */
export interface RunningRecord {
  pid: number;
  startedAt: string;
  port: number;
  blockpilotPid: number;
  cmd: string;
  /** 띄운 실행 파일 이름 (bash, cmd.exe, java …). 시작 시각을 못 구할 때 pid 재사용을 가려내는 데 쓴다 */
  exe?: string;
}

export const runningFilePath = (dir: string) => path.join(dir, ".blockpilot", "running.json");
/** /tick query 응답 줄 (콘솔 화면에는 숨긴다) */
const TICK_LINE = /The game is running|Target tick rate|Average time per tick|Percentiles|Unknown or incomplete command|Incorrect argument for command|<--\[HERE\]|tick query/;

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
  /** 레버·API·게임 안 /stop 처럼 일부러 끈 것인지. 아니면 꺼질 때 크래시로 본다 */
  private intentionalStop = false;
  private players = new Set<string>();
  private splitters: LineSplitter[] = [];
  private externalCache: { at: number; status: ProcessStatus } | null = null;
  /** 성능 측정용 명령의 응답을 콘솔 화면에서 숨기는 시간 */
  private silentUntil = 0;

  constructor(
    public readonly id: string,
    public readonly dir: string,
  ) {
    super();
    this.setMaxListeners(100);
  }

  /** 시작 스크립트(또는 java) 프로세스 번호 */
  childPid() {
    return this.child?.pid;
  }

  /**
   * 한 틱에 걸리는 평균 시간(ms)을 잰다 (/tick query, 1.20.3 이상). 응답은 콘솔 화면에 남기지 않는다.
   * 지원하지 않는 버전이면 "unsupported", 응답이 없으면 null.
   */
  async probeTick(): Promise<number | "unsupported" | null> {
    const parse = (text: string) => {
      const m = text.match(/Average time per tick: ([\d.]+)ms/);
      if (m) return Number(m[1]);
      if (/Unknown or incomplete command|Incorrect argument for command/.test(text)) return "unsupported" as const;
      return null;
    };
    if (!this.child) {
      const st = await this.status();
      if (!isUnmanagedLive(st) || st.rcon !== "connected") return null;
      const cfg = rconConfig(await this.props());
      if (!cfg) return null;
      return parse(stripColor(await rconOnce(cfg.host, cfg.port, cfg.password, "tick query").catch(() => "")));
    }
    if (!this.ready) return null;
    this.silentUntil = Date.now() + 3000;
    return new Promise((resolve) => {
      const done = (v: number | "unsupported" | null) => {
        clearTimeout(timer);
        this.off("probe", onLine);
        resolve(v);
      };
      const onLine = (text: string) => {
        const v = parse(text);
        if (v !== null) done(v);
      };
      const timer = setTimeout(() => done(null), 3000);
      this.on("probe", onLine);
      this.writeStdin("tick query");
    });
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
    // 지난번 BlockPilot 이 띄웠다가 BlockPilot 만 꺼져 남은 서버인지 (기록이 있고 그 프로세스가 아직 살아 있으면)
    const orphan = await this.liveRecord();
    const portOpen = await this.isPortOpen(props);
    if (!orphan && !portOpen) {
      this.externalCache = null;
      return { state: "stopped", ready: false, onlinePlayers: [] };
    }
    // 외부 실행 중(또는 고아): RCON으로 접속자 목록까지 가져와 본다
    const status: ProcessStatus = orphan
      ? { state: "orphan", pid: orphan.pid, startedAt: orphan.startedAt, ready: portOpen, onlinePlayers: [], rcon: "disabled", orphan: { pid: orphan.pid, startedAt: orphan.startedAt } }
      : { state: "external", ready: true, onlinePlayers: [], rcon: "disabled" };
    const rcon = portOpen ? rconConfig(props) : null;
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
    if (await this.liveRecord()) throw conflict("지난번 BlockPilot 이 띄운 서버가 아직 돌고 있어요. 먼저 안전하게 끄거나 그냥 두기를 골라 주세요.");
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
    this.intentionalStop = false;
    this.players.clear();
    this.externalCache = null;
    this.startedAt = new Date().toISOString();
    if (!info.startScript && info.foreignScript) {
      this.pushLine("system", `${info.foreignScript} 는 다른 OS 용 시작 스크립트라 쓰지 않고 서버 jar 를 직접 실행해요.`);
    }
    this.pushLine("system", `$ ${cmd} ${args.join(" ")}`);

    // 그새 끝난 자식의 기록이 남지 않게: exit 리스너가 지운 뒤 writeRunning 이 끝나는 순서를 가려낸다
    let exited = false;
    const child = spawn(cmd, args, {
      cwd: this.dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...platform.childEnv() },
      ...platform.spawnOptions(),
      windowsVerbatimArguments: verbatim,
    });
    this.child = child;
    // 서버가 먼저 끝나 입력 파이프가 닫혀도(EPIPE 등) BlockPilot 이 죽지 않게
    child.stdin!.on("error", (e) => this.pushLine("system", `서버 입력 오류: ${e.message}`));

    this.splitters = (["stdout", "stderr"] as const).map((source) => {
      const sp = new LineSplitter(platform.decode, (line) => {
        this.pushLine(source, line);
        this.inspect(line);
      });
      child[source]!.on("data", (d: Buffer) => {
        sp.push(d);
        // pause 안내는 줄바꿈 없이 나오므로 남은 조각도 본다
        if (PAUSE_PROMPT.test(sp.pending())) this.answerPause();
      });
      return sp;
    });
    child.on("error", (e) => this.pushLine("system", `프로세스 오류: ${e.message}`));
    child.on("exit", (code, signal) => {
      exited = true;
      for (const sp of this.splitters) sp.flush();
      this.pushLine("system", `서버 프로세스 종료 (code=${code ?? "null"}${signal ? `, signal=${signal}` : ""})`);
      const intentional = this.intentionalStop;
      const startedAt = this.startedAt;
      this.child = null;
      this.ready = false;
      this.stopping = false;
      this.intentionalStop = false;
      this.players.clear();
      void this.removeRunning();
      void this.emitStatus();
      if (intentional) emitServerEvent({ serverId: this.id, type: "stopped", online: 0 });
      else this.onCrash(code, startedAt);
    });
    // BlockPilot 이 먼저 죽어도 다음에 켠 BlockPilot 이 이 서버를 알아볼 수 있게 기록을 남긴다.
    // 쓰는 동안 자식이 끝나 버리면 exit 리스너의 removeRunning 이 먼저 달려(아직 파일이 없어 할 일 없음) 기록이 남을 수 있으니, 쓴 뒤 다시 확인해 지운다
    if (child.pid !== undefined && !exited) {
      await this.writeRunning({ pid: child.pid, startedAt: this.startedAt, port: Number(props["server-port"] ?? 25565), blockpilotPid: process.pid, cmd: `${cmd} ${args.join(" ")}`, exe: path.basename(cmd) });
      if (exited) await this.removeRunning();
    }
    await this.emitStatus();
  }

  async stop() {
    const child = this.child;
    if (!child) {
      // 외부 실행 서버는 RCON stop 으로 시도
      const st = await this.status();
      if (isUnmanagedLive(st) && st.rcon === "connected") {
        await this.rcon("stop");
        this.externalCache = null;
        return;
      }
      throw conflict("BlockPilot이 실행한 서버가 아니거나 이미 중지되어 있습니다.");
    }
    if (this.stopping) return;
    this.stopping = true;
    this.intentionalStop = true;
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
    // 줄바꿈이 섞여 들어와도 명령 하나로만 보낸다 (한 입력이 여러 명령이 되지 않게)
    const cmd = command.replace(/[\r\n]+/g, " ").trim();
    if (!cmd) return;
    if (this.child) {
      this.pushLine("input", `> ${cmd}`);
      this.writeStdin(cmd);
      return;
    }
    const st = await this.status();
    if (!isUnmanagedLive(st)) throw conflict("서버가 실행 중이 아닙니다.");
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
    if (isUnmanagedLive(st) && st.rcon === "connected") {
      await this.sendCommand(command);
      return true;
    }
    return false;
  }

  /**
   * 지난번 BlockPilot 이 띄우고 남은 서버(orphan)를 안전하게 끈다.
   * RCON 이 되면 stop 명령 → 안 되거나 제때 안 끝나면 종료 신호(스크립트 + java 묶음) → 그래도 남으면 강제 종료.
   */
  async stopOrphan(): Promise<void> {
    if (this.child) throw conflict("이 서버는 지금 BlockPilot 이 직접 관리하고 있어요. 레버로 꺼 주세요.");
    const rec = await this.liveRecord();
    this.externalCache = null;
    if (!rec) throw conflict("지난번에 띄운 서버가 더 이상 돌고 있지 않아요.");
    this.pushLine("system", `지난번 BlockPilot 이 띄운 서버(PID ${rec.pid})를 끄는 중...`);
    const gone = () => !pidAlive(rec.pid);

    const props = await this.props();
    const rcon = rconConfig(props);
    const rconReachable = !!rcon && (await this.isPortOpen(props));
    // Windows 는 콘솔 프로그램에 보낼 '부드러운' 종료 신호가 없어 killTree 가 곧 강제 종료다. RCON 없이 "안전하게" 끌 길이 없으니 거절한다
    const NO_GRACEFUL = "Windows 에서는 RCON 이 꺼진 서버를 안전하게 끌 수 없어요. 서버 창에서 stop 을 입력해 끄거나, 그냥 두기를 고른 뒤 server.properties 에서 enable-rcon 을 켜 주세요.";
    if (!rconReachable && !platform.canStopGracefully) {
      this.pushLine("system", NO_GRACEFUL);
      throw conflict(NO_GRACEFUL);
    }
    let sentStop = false;
    if (rconReachable && rcon) {
      try {
        await rconOnce(rcon.host, rcon.port, rcon.password, "stop");
        sentStop = true;
        this.pushLine("system", "RCON 으로 stop 명령을 보냈어요. 월드 저장을 기다리는 중...");
      } catch (e) {
        const why = e instanceof RconError ? e.message : String(e);
        if (!platform.canStopGracefully) {
          // 강제 종료 말고는 남은 수단이 없으니 월드가 깨질 수 있는 일은 하지 않는다
          this.pushLine("system", `RCON 으로 끄지 못했어요 (${why}). ${NO_GRACEFUL}`);
          throw conflict(`RCON 으로 끄지 못했어요 (${why}). ${NO_GRACEFUL}`);
        }
        this.pushLine("system", `RCON 으로 끄지 못했어요 (${why}). 종료 요청을 보낼게요.`);
      }
    }
    if (sentStop && (await waitUntil(gone, ORPHAN_STOP_GRACE_MS))) return this.orphanGone(rec);

    this.pushLine("system", sentStop ? "응답이 없어 종료 요청을 보냈어요 (시작 스크립트와 java 모두)" : "종료 요청을 보냈어요 (시작 스크립트와 java 모두)");
    platform.killTree(handleFor(rec.pid), false);
    if (await waitUntil(gone, sentStop ? KILL_GRACE_MS : ORPHAN_STOP_GRACE_MS)) return this.orphanGone(rec);
    this.pushLine("system", "강제 종료");
    platform.killTree(handleFor(rec.pid), true);
    if (!(await waitUntil(gone, 5_000))) throw conflict(`서버 프로세스(PID ${rec.pid})를 끝내지 못했어요. 작업 관리자에서 직접 끝내 주세요.`);
    await this.orphanGone(rec);
  }

  /** 지난번 실행 기록을 지우고 그 서버는 이제 '외부 실행 중' 으로만 본다 */
  async ignoreOrphan(): Promise<void> {
    await this.removeRunning();
    this.externalCache = null;
    this.pushLine("system", "지난번에 띄운 서버는 그냥 두기로 했어요. 이제 외부 실행 중인 서버로 보여요.");
    await this.emitStatus();
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

  private async orphanGone(rec: RunningRecord) {
    await this.removeRunning();
    this.externalCache = null;
    this.pushLine("system", `지난번에 띄운 서버(PID ${rec.pid})를 껐어요.`);
    emitServerEvent({ serverId: this.id, type: "stopped", online: 0 });
    await this.emitStatus();
  }

  private async writeRunning(rec: RunningRecord) {
    const file = runningFilePath(this.dir);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(rec, null, 2) + "\n");
    } catch (e) {
      this.pushLine("system", `실행 기록(${file})을 남기지 못했어요: ${(e as Error).message}`);
    }
  }

  private async removeRunning() {
    await fsp.rm(runningFilePath(this.dir), { force: true }).catch(() => {});
  }

  private async readRunning(): Promise<RunningRecord | null> {
    try {
      const raw = JSON.parse(await fsp.readFile(runningFilePath(this.dir), "utf8")) as Partial<RunningRecord>;
      if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0 || typeof raw.startedAt !== "string") return null;
      return {
        pid: raw.pid as number,
        startedAt: raw.startedAt,
        port: Number(raw.port ?? 25565),
        blockpilotPid: Number(raw.blockpilotPid ?? 0),
        cmd: String(raw.cmd ?? ""),
        exe: typeof raw.exe === "string" && raw.exe ? raw.exe : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * 아직 살아 있는 지난번 실행 기록. 프로세스가 끝났거나 같은 pid 를 다른 프로그램이 받은 것이면 기록을 지우고 null.
   * BlockPilot 이 직접 관리 중(child 있음)이면 이 기록은 자기 것이므로 보지 않는다.
   */
  private async liveRecord(): Promise<RunningRecord | null> {
    if (this.child) return null;
    const rec = await this.readRunning();
    if (!rec) return null;
    if (!pidAlive(rec.pid) || !(await recordLooksLive(rec, await platform.processInfo(rec.pid), () => portOpen(rec.port)))) {
      await this.removeRunning();
      return null;
    }
    return rec;
  }

  private writeStdin(line: string) {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.writableEnded && !stdin.destroyed) stdin.write(line + "\n");
  }

  /** start.bat 끝의 pause 에 키 입력을 넘기고 입력을 닫는다. 안내가 조각과 완성된 줄로 두 번 보일 수 있어 한 번만 */
  private answerPause() {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.writableEnded && !stdin.destroyed) stdin.end("\r\n");
  }

  /** 로그 줄에서 상태 변화를 읽어낸다 */
  private inspect(line: string) {
    // Windows start.bat 끝의 pause: java 가 끝났는데 cmd 가 키 입력을 기다리면 넘겨 준다
    if (PAUSE_PROMPT.test(line)) {
      this.answerPause();
      return;
    }
    if (!this.ready && /\]: Done \(/.test(line)) {
      this.ready = true;
      void this.emitStatus();
      emitServerEvent({ serverId: this.id, type: "started", online: 0 });
      return;
    }
    let m = line.match(/\]: (\S+) joined the game/);
    if (m) {
      this.players.add(m[1]);
      void this.emitStatus();
      emitServerEvent({ serverId: this.id, type: "joined", player: m[1], online: this.players.size });
      return;
    }
    m = line.match(/\]: (\S+) left the game/);
    if (m) {
      this.players.delete(m[1]);
      void this.emitStatus();
      emitServerEvent({ serverId: this.id, type: "left", player: m[1], online: this.players.size });
      return;
    }
    // 게임 안에서 /stop 한 것도 일부러 끈 것
    if (/\]: Stopping the server/.test(line)) {
      this.intentionalStop = true;
      if (!this.stopping) {
        this.stopping = true;
        void this.emitStatus();
      }
    }
  }

  /** 일부러 끈 게 아닌데 꺼졌다: 크래시 사건 (원인 요약은 crash.ts) */
  private onCrash(code: number | null, startedAt?: string) {
    const uptimeSeconds = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : undefined;
    this.pushLine("system", "서버가 예기치 않게 꺼졌어요. 원인을 살펴보는 중…");
    const recent = this.history.slice(-200).map((l) => l.text);
    void analyzeCrash(this.dir, { startedAt, recent, exitCode: code, uptimeSeconds })
      .catch(() => undefined)
      .then((crash) => {
        if (crash) this.pushLine("system", `원인 추정: ${crash.title} — ${crash.hint}`);
        emitServerEvent({ serverId: this.id, type: "crashed", online: 0, crash });
      });
  }

  private pushLine(source: ConsoleLine["source"], text: string) {
    if (source !== "system" && Date.now() < this.silentUntil && TICK_LINE.test(text)) {
      this.emit("probe", text);
      return;
    }
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
    return portOpen(Number(props["server-port"] ?? 25565));
  }
}

function portOpen(port: number): Promise<boolean> {
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

/** BlockPilot 이 직접 띄운 게 아닌데 돌고 있는 서버 (외부 실행 또는 지난번에 남은 것) */
function isUnmanagedLive(st: ProcessStatus) {
  return st.state === "external" || st.state === "orphan";
}

/** 프로세스가 살아 있는지 (신호 0). 권한이 없어 못 보내도 살아 있는 것 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 실행 파일 이름 비교용: 경로·.exe 를 떼고 소문자로 ("/usr/bin/java" → "java", "cmd.exe" → "cmd") */
function exeKey(name: string) {
  return path.basename(name.trim()).toLowerCase().replace(/\.exe$/, "");
}

/**
 * 살아 있는 pid 가 기록에 적힌 '그 서버'인지 (같은 pid 를 다른 프로그램이 받았을 수 있다).
 * - 시작 시각을 알면 그것으로 판단: 기록과 ±120 초 안이어야 한다
 * - 모르면(권한 없음·조회 실패 등) 보수적으로: 서버 포트가 열려 있고, 이름을 아는 한 java 이거나 기록한 실행 파일(시작 스크립트의 셸 등)이어야 한다
 *   (시작 스크립트가 exec 로 java 가 됐을 수 있으니 둘 다 허용)
 */
export async function recordLooksLive(rec: RunningRecord, info: ProcessInfo, isPortOpen: () => Promise<boolean>): Promise<boolean> {
  const recorded = Date.parse(rec.startedAt);
  if (info.startedAt && !Number.isNaN(recorded)) return Math.abs(info.startedAt.getTime() - recorded) <= PID_REUSE_SLACK_MS;
  if (info.name) {
    const n = exeKey(info.name);
    if (!n.includes("java") && (!rec.exe || n !== exeKey(rec.exe))) return false;
  }
  return isPortOpen();
}

/** killTree 가 ChildProcess 의 pid·kill 만 쓰므로, 지난번에 남은 프로세스도 같은 모양으로 넘긴다 */
export function handleFor(pid: number): ChildProcess {
  return { pid, kill: (sig?: NodeJS.Signals | number) => process.kill(pid, sig) } as unknown as ChildProcess;
}

function waitUntil(check: () => boolean, ms: number, stepMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() >= end) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
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
