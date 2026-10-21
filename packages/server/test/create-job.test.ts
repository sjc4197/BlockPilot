import { describe, it, expect, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CreateServerInput } from "@blockpilot/shared";
import { prepareTarget, cleanupTarget, assertDeletableTarget } from "../src/services/create/target.js";
import { CreateJob, JOBS_DIR, recoverInterruptedJobs, recovered } from "../src/services/create/job.js";
import { CreateError } from "../src/services/create/errors.js";
import { platform } from "../src/services/platform/index.js";

const exists = (p: string) => fsp.access(p).then(() => true, () => false);
let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-job-"));
});

const input = (p: string): CreateServerInput => ({
  path: p,
  name: "test",
  mcVersion: "1.21.1",
  loaderVersion: "0.19.5",
  memory: { minMb: 1024, maxMb: 2048 },
  properties: {},
  eulaAccepted: true,
});

describe("prepareTarget", () => {
  it("accepts a path that does not exist yet when its parent exists", async () => {
    const r = await prepareTarget(path.join(root, "new-server"));
    expect(r).toMatchObject({ existed: false, preexisting: [] });
  });

  it("accepts an empty folder, ignoring this OS's metadata files (.DS_Store / desktop.ini …)", async () => {
    const d = path.join(root, "empty");
    await fsp.mkdir(d);
    const meta = [...platform.ignorable][0];
    await fsp.writeFile(path.join(d, meta), "x");
    const r = await prepareTarget(d);
    expect(r).toMatchObject({ existed: true, preexisting: [meta] });
  });

  it("rejects a folder with files in it, explaining in Korean", async () => {
    const d = path.join(root, "full");
    await fsp.mkdir(d);
    await fsp.writeFile(path.join(d, "world.txt"), "x");
    const err = (await prepareTarget(d).catch((e) => e)) as CreateError;
    expect(err.code).toBe("folder_not_empty");
    expect(err.detail).toMatch(/world\.txt/);
  });

  it("rejects relative paths, missing parents and system folders", async () => {
    expect(((await prepareTarget("servers/x").catch((e) => e)) as CreateError).code).toBe("invalid_path");
    expect(((await prepareTarget(path.join(root, "a", "b")).catch((e) => e)) as CreateError).code).toBe("invalid_path");
    expect(() => assertDeletableTarget(path.parse(process.cwd()).root)).toThrow(CreateError);
    expect(() => assertDeletableTarget(os.homedir())).toThrow(CreateError);
    const system = process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : process.platform === "darwin" ? "/Applications" : "/usr";
    expect(() => assertDeletableTarget(system)).toThrow(CreateError);
  });
});

describe("cleanupTarget", () => {
  it("removes only what was not there at the start", async () => {
    const d = path.join(root, "srv");
    await fsp.mkdir(d);
    await fsp.writeFile(path.join(d, ".DS_Store"), "keep");
    await fsp.mkdir(path.join(d, "world", "region"), { recursive: true });
    await fsp.writeFile(path.join(d, "server.jar"), "x");
    const removed = await cleanupTarget({ target: d, targetCreated: false, preexisting: [".DS_Store"] });
    expect(removed.sort()).toEqual(["server.jar", "world"]);
    expect(await fsp.readdir(d)).toEqual([".DS_Store"]);
  });

  it("removes the folder itself when the job created it", async () => {
    const d = path.join(root, "made-by-us");
    await fsp.mkdir(d);
    await fsp.writeFile(path.join(d, "eula.txt"), "x");
    await cleanupTarget({ target: d, targetCreated: true, preexisting: [] });
    expect(await exists(d)).toBe(false);
  });
});

describe("CreateJob", () => {
  it("cleans up and reports a Korean error when a step fails", async () => {
    const target = path.join(root, "fail");
    const job = new CreateJob(input(target));
    await job.run(async (j) => {
      j.startStep("preflight");
      await j.openJournal({ target, targetCreated: true, preexisting: [] });
      await fsp.mkdir(target);
      await fsp.writeFile(path.join(target, "server.jar"), "partial");
      j.finishStep("preflight");
      j.startStep("server-jar");
      throw new CreateError("hash_mismatch", "받은 파일이 공식 해시와 달라요 (server.jar).");
    });
    expect(job.state).toBe("failed");
    expect(job.error?.message).toMatch(/공식 해시와 달라요/);
    expect(job.steps.find((s) => s.id === "server-jar")?.state).toBe("failed");
    expect(await exists(target)).toBe(false);
    expect(await exists(path.join(JOBS_DIR, `${job.id}.json`))).toBe(false);
  });

  it("keeps everything and drops the journal on success", async () => {
    const target = path.join(root, "ok");
    const job = new CreateJob(input(target));
    await job.run(async (j) => {
      await j.openJournal({ target, targetCreated: true, preexisting: [] });
      await fsp.mkdir(target);
      await fsp.writeFile(path.join(target, "start.sh"), "#!/bin/bash");
      return "server-id";
    });
    expect(job.state).toBe("succeeded");
    expect(job.serverId).toBe("server-id");
    expect(await exists(path.join(target, "start.sh"))).toBe(true);
    expect(await exists(path.join(JOBS_DIR, `${job.id}.json`))).toBe(false);
  });

  it("cancels: kills the child process and cleans up", async () => {
    const target = path.join(root, "cancel");
    const job = new CreateJob(input(target));
    let childPid = 0;
    const done = job.run(async (j) => {
      await j.openJournal({ target, targetCreated: true, preexisting: [] });
      await fsp.mkdir(target);
      await fsp.writeFile(path.join(target, "fabric-server-launch.jar"), "x");
      j.startStep("first-run");
      // sleep 은 Windows 에 없으니 Node 로 30초 기다리는 프로세스
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
      childPid = child.pid!;
      j.trackChild(child);
      await new Promise((resolve, reject) => child.once("exit", () => reject(new Error("exited"))));
      return "never";
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(job.cancel()).toBe(true);
    await done;
    expect(job.state).toBe("cancelled");
    expect(job.error?.message).toBe("만들기를 취소했어요.");
    expect(() => process.kill(childPid, 0)).toThrow(); // 프로세스가 죽었음
    expect(await exists(target)).toBe(false);
  });
});

describe("recoverInterruptedJobs", () => {
  it("cleans up a job left behind by a previous BlockPilot process", async () => {
    const target = path.join(root, "orphan");
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, ".DS_Store"), "keep");
    await fsp.writeFile(path.join(target, "server.jar"), "x");
    await fsp.mkdir(JOBS_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(JOBS_DIR, "dead.json"),
      JSON.stringify({ id: "dead", pid: 999999, target, targetCreated: false, preexisting: [".DS_Store"], tempPaths: [], startedAt: "" }),
    );
    await recoverInterruptedJobs();
    expect(await fsp.readdir(target)).toEqual([".DS_Store"]);
    expect(await exists(path.join(JOBS_DIR, "dead.json"))).toBe(false);
    expect(recovered.at(-1)).toMatchObject({ target, cleaned: ["server.jar"] });
  });
});
