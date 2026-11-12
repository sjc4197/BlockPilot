import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import { getManaged, forgetManaged, handleFor, pidAlive, recordLooksLive, runningFilePath, type ManagedServer, type RunningRecord } from "../src/services/process.js";
import { platform } from "../src/services/platform/index.js";
import { installCrashGuard } from "../src/lib/crashGuard.js";
import { makeFakeServer, waitFor } from "./helpers/fakeServer.js";

/**
 * BlockPilot 만 죽고 서버가 남는 경우(orphan).
 * - 서버를 띄우면 <서버 폴더>/.blockpilot/running.json 에 기록을 남긴다
 * - BlockPilot 을 다시 켠 것처럼 레지스트리에서 잊은 뒤 새 ManagedServer 로 보면 orphan 으로 알아본다
 * - 안전하게 끄기 → 프로세스가 끝나고 기록이 지워진다 / 그냥 두기 → 기록만 지우고 외부 실행으로 본다
 */

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
const readRecord = async (dir: string) => JSON.parse(await fsp.readFile(runningFilePath(dir), "utf8")) as RunningRecord;

/** 포트를 실제로 여는 가짜 서버 (status() 가 포트로 켜짐을 판단하므로) */
const listening = (port: number, extra = "") => `
require("node:net").createServer().listen(${port}, "127.0.0.1", () => log("Done (0.1s)! For help, type \\"help\\""));
${extra}
`;

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
});

/** 가짜 서버를 실제 start() 로 띄우고, 테스트가 끝나면 어떻게든 끈다 */
async function startFake(tag: string, extra = "") {
  const port = 26000 + Math.floor(Math.random() * 2000);
  const fake = await makeFakeServer(listening(port, extra), { port });
  const id = `orphan-${tag}-${Date.now()}`;
  const managed = getManaged(id, fake.dir);
  await managed.start();
  const pid = managed.childPid()!;
  cleanups.push(async () => {
    // 어느 OS 에서든 남은 프로세스(스크립트 + node)를 끝낸다: 레지스트리에서 잊은 뒤(orphan 시나리오)라도 pid 로 트리째
    if (pidAlive(pid)) platform.killTree(handleFor(pid), true);
    forgetManaged(id);
    await waitFor(() => !pidAlive(pid), 5_000, "가짜 서버 종료").catch(() => {});
    await fake.cleanup();
  });
  await waitFor(async () => (await managed.status()).state === "running", 10_000, "서버 Done");
  return { id, dir: fake.dir, port: fake.port, managed, pid };
}

/** BlockPilot 을 다시 켠 것처럼: 레지스트리에서 잊고 새 객체로 본다 */
function restarted(id: string, dir: string): ManagedServer {
  forgetManaged(id);
  const fresh = getManaged(id, dir);
  expect(fresh.isManaged()).toBe(false);
  return fresh;
}

describe("running.json and orphan detection", () => {
  it("writes running.json on start, reports orphan after a restart, and stops it safely", async () => {
    const { id, dir, port, pid } = await startFake("stop");
    const file = runningFilePath(dir);
    expect(await exists(file)).toBe(true);
    const rec = await readRecord(dir);
    expect(rec.pid).toBe(pid);
    expect(rec.blockpilotPid).toBe(process.pid);
    expect(typeof rec.startedAt).toBe("string");
    expect(rec.port).toBe(port);
    expect(rec.cmd).toContain("start");
    expect(rec.exe).toBeTruthy();

    const fresh = restarted(id, dir);
    const st = await fresh.status();
    expect(st.state).toBe("orphan");
    expect(st.pid).toBe(pid);
    expect(st.orphan).toEqual({ pid, startedAt: rec.startedAt });
    expect(st.ready).toBe(true);

    // orphan 이 살아 있는 동안은 새로 켤 수 없다
    await expect(fresh.start()).rejects.toThrow(/지난번 BlockPilot 이 띄운 서버/);

    if (!platform.canStopGracefully) {
      // Windows: RCON 이 없는 고아 서버는 강제 종료 대신 안내만 한다 (월드 저장 없이 죽이지 않기 위해)
      await expect(fresh.stopOrphan()).rejects.toThrow(/RCON/);
      expect(pidAlive(pid)).toBe(true);
      expect(await exists(file)).toBe(true);
      return;
    }
    await fresh.stopOrphan();
    expect(pidAlive(pid)).toBe(false);
    expect(await exists(file)).toBe(false);
    expect(fresh.getHistory().some((l) => /껐어요/.test(l.text))).toBe(true);
    await waitFor(async () => (await fresh.status()).state === "stopped", 5_000, "stopped");
  }, 30_000);

  it("ignore removes running.json and the server is then just external", async () => {
    const { id, dir, pid } = await startFake("ignore");
    const fresh = restarted(id, dir);
    expect((await fresh.status()).state).toBe("orphan");

    await fresh.ignoreOrphan();
    expect(await exists(runningFilePath(dir))).toBe(false);
    expect(pidAlive(pid)).toBe(true);
    const st = await fresh.status();
    expect(st.state).toBe("external");
    expect(st.orphan).toBeUndefined();
  }, 30_000);

  it("running.json disappears after a clean stop", async () => {
    const { dir, managed } = await startFake("clean");
    await managed.stop();
    await waitFor(() => exists(runningFilePath(dir)).then((v) => !v), 5_000, "running.json 삭제");
    expect((await managed.status()).state).toBe("stopped");
  }, 30_000);

  it("a stale record (dead pid) is dropped and the server counts as stopped", async () => {
    const fake = await makeFakeServer("");
    cleanups.push(fake.cleanup);
    const file = runningFilePath(fake.dir);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ pid: 2_000_000_000, startedAt: new Date().toISOString(), port: fake.port, blockpilotPid: 1, cmd: "x" }));
    const managed = getManaged(`orphan-stale-${Date.now()}`, fake.dir);
    expect((await managed.status()).state).toBe("stopped");
    expect(await exists(file)).toBe(false);
    expect(await managed.stopOrphan().catch((e) => e.message)).toMatch(/더 이상 돌고 있지 않아요/);
  });

  it("a record whose pid now belongs to another program (start time far off) is dropped", async () => {
    const fake = await makeFakeServer("");
    cleanups.push(fake.cleanup);
    const file = runningFilePath(fake.dir);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 살아 있는 pid(이 테스트 프로세스)지만 기록된 시작 시각은 한참 전 → 같은 pid 를 다른 프로그램이 받은 것으로 본다
    const longAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
    await fsp.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: longAgo, port: fake.port, blockpilotPid: 1, cmd: "x", exe: "java" }));
    const managed = getManaged(`orphan-reused-${Date.now()}`, fake.dir);
    const info = await platform.processInfo(process.pid);
    // 이 OS 에서 시작 시각을 읽을 수 있어야 의미 있는 검사 (못 읽으면 아래 recordLooksLive 단위 검사가 대신한다)
    if (info.startedAt) {
      expect(Math.abs(info.startedAt.getTime() - Date.now())).toBeLessThan(3600_000);
      expect((await managed.status()).state).toBe("stopped");
      expect(await exists(file)).toBe(false);
      expect(pidAlive(process.pid)).toBe(true);
    }
    expect(info.name).toBeTruthy();
    expect(info.name!.toLowerCase()).toContain("node");
  });

  it("recordLooksLive: time decides when known, otherwise port + image name", async () => {
    const now = new Date();
    const rec: RunningRecord = { pid: 1, startedAt: now.toISOString(), port: 25565, blockpilotPid: 1, cmd: "/bin/bash start.sh", exe: "bash" };
    const open = async () => true;
    const closed = async () => false;
    // 시작 시각을 알면 그것만으로 판단 (포트는 보지 않는다)
    expect(await recordLooksLive(rec, { startedAt: new Date(now.getTime() + 60_000), name: null }, closed)).toBe(true);
    expect(await recordLooksLive(rec, { startedAt: new Date(now.getTime() + 10 * 60_000), name: "java" }, open)).toBe(false);
    // 모르면: 포트가 열려 있고 이름이 java 이거나 기록한 실행 파일이어야 한다
    expect(await recordLooksLive(rec, { startedAt: null, name: null }, open)).toBe(true);
    expect(await recordLooksLive(rec, { startedAt: null, name: null }, closed)).toBe(false);
    expect(await recordLooksLive(rec, { startedAt: null, name: "/usr/bin/java" }, open)).toBe(true);
    expect(await recordLooksLive(rec, { startedAt: null, name: "bash" }, open)).toBe(true);
    expect(await recordLooksLive(rec, { startedAt: null, name: "chrome" }, open)).toBe(false);
    // Windows: ProcessName 은 확장자가 없고 기록은 cmd.exe 일 수 있다
    expect(await recordLooksLive({ ...rec, exe: "cmd.exe" }, { startedAt: null, name: "cmd" }, open)).toBe(true);
    expect(await recordLooksLive({ ...rec, exe: "cmd.exe" }, { startedAt: null, name: "notepad" }, open)).toBe(false);
    // 옛 기록(exe 없음)은 java 만 허용
    expect(await recordLooksLive({ ...rec, exe: undefined }, { startedAt: null, name: "bash" }, open)).toBe(false);
  });
});

describe("console command input", () => {
  it("sends a command with embedded newlines as one line", async () => {
    const { managed } = await startFake("newline", 'onCommand((c) => { if (c !== "stop") log("CMD:" + c); });');
    await managed.sendCommand("say hello\r\nstop\nsay again");
    await waitFor(() => managed.getHistory().some((l) => /CMD:/.test(l.text)), 5_000, "명령 수신");
    await new Promise((r) => setTimeout(r, 300));
    const got = managed.getHistory().filter((l) => /CMD:/.test(l.text)).map((l) => l.text.replace(/.*CMD:/, ""));
    expect(got).toEqual(["say hello stop say again"]);
    expect(managed.getHistory().some((l) => /Stopping the server/.test(l.text))).toBe(false);
    expect((await managed.status()).state).toBe("running");
  }, 20_000);
});

describe("crash guard", () => {
  it("runs the shutdown path once and then exits with 1", async () => {
    const target = new EventEmitter();
    const calls: unknown[] = [];
    const exits: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const off = installCrashGuard(
      async (err) => {
        calls.push(err);
        await gate;
      },
      { target, exit: (c) => exits.push(c), capMs: 5_000 },
    );
    try {
      const boom = new Error("boom");
      target.emit("uncaughtException", boom);
      target.emit("unhandledRejection", new Error("again"));
      expect(calls).toEqual([boom]);
      expect(exits).toEqual([]);
      release();
      await waitFor(() => exits.length > 0, 2_000, "exit");
      expect(exits).toEqual([1]);
    } finally {
      off();
    }
  });

  it("exits anyway when the shutdown path hangs past the cap", async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    const off = installCrashGuard(() => new Promise(() => {}), { target, exit: (c) => exits.push(c), capMs: 200 });
    try {
      target.emit("uncaughtException", new Error("hang"));
      await waitFor(() => exits.length > 0, 2_000, "exit");
      expect(exits).toEqual([1]);
    } finally {
      off();
    }
  });
});
