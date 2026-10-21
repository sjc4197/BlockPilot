import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { CreateJobState, CreateJobStatus, CreateServerInput, CreateStep, CreateStepId } from "@blockpilot/shared";
import { BLOCKPILOT_HOME } from "../../config/store.js";
import { CreateError, toCreateError } from "./errors.js";
import { cleanupTarget, removeTempPath } from "./target.js";
import { platform } from "../platform/index.js";

/**
 * 새 서버 만들기 작업 하나.
 * - 진행 상황(단계·진행률·로그)을 메모리에 들고 API 로 보여 준다
 * - 시작하자마자 일지(~/.blockpilot/jobs/<id>.json)를 남겨, BlockPilot 이 도중에 꺼져도 다음 실행 때 정리할 수 있게 한다
 * - 실패·취소 시: 자식 프로세스 종료 → 대상 폴더에서 시작 시점에 없던 것만 삭제 → 임시 파일 삭제
 */

export const JOBS_DIR = path.join(BLOCKPILOT_HOME, "jobs");
const LOG_LIMIT = 400;

export const STEP_LABELS: Record<CreateStepId, string> = {
  preflight: "사전 점검",
  versions: "버전 정보 확인",
  java: "Java 준비",
  "server-jar": "Minecraft 서버 받기",
  fabric: "Fabric 설치",
  config: "설정 파일 작성",
  "first-run": "최초 실행",
  register: "서버 목록에 등록",
};
const STEP_ORDER = Object.keys(STEP_LABELS) as CreateStepId[];

export interface Journal {
  id: string;
  pid: number;
  target: string;
  /** 대상 폴더를 이 작업이 만들었는지 */
  targetCreated: boolean;
  /** 시작 시점에 폴더 안에 있던 항목 (지우지 않음) */
  preexisting: string[];
  /** 앱 폴더 안의 임시 경로 */
  tempPaths: string[];
  startedAt: string;
}

export class CreateJob {
  readonly id = randomUUID().slice(0, 8);
  state: CreateJobState = "running";
  readonly steps: CreateStep[] = STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], state: "pending" }));
  readonly log: string[] = [];
  error?: CreateError;
  cleaned?: string[];
  kept: string[] = [];
  serverId?: string;
  readonly startedAt = new Date().toISOString();
  finishedAt?: string;
  journal?: Journal;

  private ctrl = new AbortController();
  private children = new Set<ChildProcess>();

  constructor(readonly input: CreateServerInput) {}

  get signal() {
    return this.ctrl.signal;
  }

  /** 취소됐으면 즉시 멈춘다. 긴 단계 사이사이에 부른다 */
  throwIfCancelled() {
    if (this.ctrl.signal.aborted) throw new CreateError("cancelled", "만들기를 취소했어요.");
  }

  status(): CreateJobStatus {
    const { path: p, name, mcVersion, loaderVersion } = this.input;
    return {
      id: this.id,
      state: this.state,
      input: { path: this.journal?.target ?? p, name, mcVersion, loaderVersion },
      steps: this.steps.map((s) => ({ ...s, progress: s.progress && { ...s.progress } })),
      log: [...this.log],
      error: this.error?.toJSON(),
      cleaned: this.cleaned,
      kept: this.kept.length ? this.kept : undefined,
      serverId: this.serverId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  appendLog(line: string) {
    for (const l of line.split(/\r?\n/)) {
      if (!l) continue;
      this.log.push(l);
    }
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  private stepOf(id: CreateStepId) {
    return this.steps.find((s) => s.id === id)!;
  }
  startStep(id: CreateStepId, note?: string) {
    this.throwIfCancelled();
    const s = this.stepOf(id);
    s.state = "running";
    s.note = note;
    s.progress = undefined;
    this.appendLog(`▶ ${s.label}${note ? ` — ${note}` : ""}`);
  }
  progress(id: CreateStepId, done: number, total?: number) {
    this.stepOf(id).progress = { done, total };
  }
  note(id: CreateStepId, note: string) {
    this.stepOf(id).note = note;
  }
  finishStep(id: CreateStepId, note?: string) {
    const s = this.stepOf(id);
    s.state = "done";
    if (note !== undefined) s.note = note;
  }
  skipStep(id: CreateStepId, note: string) {
    const s = this.stepOf(id);
    s.state = "skipped";
    s.note = note;
  }

  /** 취소·실패 시 함께 종료할 자식 프로세스 (설치기, 최초 실행 서버) */
  trackChild(child: ChildProcess) {
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
  }

  cancel() {
    if (this.state !== "running") return false;
    this.appendLog("취소 요청을 받았어요. 진행 중인 작업을 멈추는 중…");
    this.ctrl.abort();
    this.killChildren();
    return true;
  }

  private killChildren() {
    for (const c of this.children) {
      if (c.exitCode !== null || c.signalCode !== null) continue;
      // 설치기·시작 스크립트의 자식(java)까지 함께
      platform.killTree(c, false);
      setTimeout(() => {
        if (c.exitCode === null && c.signalCode === null) platform.killTree(c, true);
      }, 5000).unref();
    }
  }

  private async waitChildren(ms: number) {
    const deadline = Date.now() + ms;
    while (this.children.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  // ---------- 일지 ----------

  async openJournal(j: Omit<Journal, "id" | "pid" | "startedAt" | "tempPaths">) {
    this.journal = { ...j, id: this.id, pid: process.pid, startedAt: this.startedAt, tempPaths: [] };
    await this.saveJournal();
  }

  async addTempPath(p: string) {
    if (!this.journal) return;
    this.journal.tempPaths.push(p);
    await this.saveJournal();
  }

  private async saveJournal() {
    await fsp.mkdir(JOBS_DIR, { recursive: true });
    await fsp.writeFile(path.join(JOBS_DIR, `${this.id}.json`), JSON.stringify(this.journal, null, 2));
  }

  private async removeJournal() {
    await fsp.rm(path.join(JOBS_DIR, `${this.id}.json`), { force: true });
  }

  // ---------- 실행 ----------

  /** 단계들을 실행한다. 성공 시 serverId, 실패·취소 시 정리 후 상태만 남긴다 (예외를 밖으로 던지지 않음) */
  async run(pipeline: (job: CreateJob) => Promise<string>): Promise<void> {
    try {
      this.serverId = await pipeline(this);
      this.state = "succeeded";
      this.appendLog("✔ 서버를 만들었어요.");
      await this.removeJournal();
    } catch (e) {
      const err = this.ctrl.signal.aborted ? new CreateError("cancelled", "만들기를 취소했어요.", "만들던 파일은 모두 정리했어요.") : toCreateError(e, { path: this.journal?.target });
      this.error = err;
      this.state = err.code === "cancelled" ? "cancelled" : "failed";
      const running = this.steps.find((s) => s.state === "running");
      if (running) running.state = "failed";
      this.appendLog(`✖ ${err.message}${err.detail ? `\n${err.detail}` : ""}`);

      this.killChildren();
      await this.waitChildren(10_000);
      await this.cleanup();
    } finally {
      this.finishedAt = new Date().toISOString();
    }
  }

  private async cleanup() {
    if (!this.journal) {
      this.cleaned = [];
      return;
    }
    try {
      this.cleaned = await cleanupTarget(this.journal);
      for (const t of this.journal.tempPaths) await removeTempPath(t);
      if (this.cleaned.length) this.appendLog(`정리: 이번에 만든 항목 ${this.cleaned.length}개를 지웠어요.`);
      await this.removeJournal();
    } catch (e) {
      // 정리 자체가 실패하면 일지를 남겨 다음 실행 때 다시 시도
      this.kept.push(`정리 중 오류가 나서 일부 파일이 남았을 수 있어요: ${(e as Error).message}`);
    }
  }
}

// ---------- 작업 관리 (한 번에 하나) ----------

let current: CreateJob | null = null;
const finished = new Map<string, CreateJob>();

export function getJob(id: string): CreateJob | undefined {
  if (current?.id === id) return current;
  return finished.get(id);
}

export function activeJob(): CreateJob | null {
  return current && current.state === "running" ? current : null;
}

/** 작업을 시작하고 바로 돌려준다. 진행은 백그라운드 */
export function startJob(input: CreateServerInput, pipeline: (job: CreateJob) => Promise<string>): CreateJob {
  if (activeJob()) throw new CreateError("busy", "이미 다른 서버를 만들고 있어요.", "진행 중인 작업이 끝난 뒤 다시 시도해 주세요.");
  const job = new CreateJob(input);
  current = job;
  void job.run(pipeline).then(() => {
    finished.set(job.id, job);
    if (finished.size > 20) finished.delete(finished.keys().next().value!);
  });
  return job;
}

export async function cancelAllJobs() {
  if (current?.state === "running") {
    current.cancel();
    const deadline = Date.now() + 15_000;
    while (current.state === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }
}

export interface RecoveredJob {
  target: string;
  cleaned: string[];
  at: string;
}
export const recovered: RecoveredJob[] = [];

/**
 * BlockPilot 이 만들기 도중 꺼졌다면 일지가 남아 있다. 시작할 때 같은 규칙으로 정리한다.
 */
export async function recoverInterruptedJobs(log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  let files: string[];
  try {
    files = await fsp.readdir(JOBS_DIR);
  } catch {
    return;
  }
  for (const f of files.filter((n) => n.endsWith(".json"))) {
    const file = path.join(JOBS_DIR, f);
    try {
      const j = JSON.parse(await fsp.readFile(file, "utf8")) as Journal;
      if (j.pid === process.pid) continue;
      const cleaned = await cleanupTarget(j);
      for (const t of j.tempPaths ?? []) await removeTempPath(t);
      await fsp.rm(file, { force: true });
      recovered.push({ target: j.target, cleaned, at: new Date().toISOString() });
      log?.info({ target: j.target, cleaned: cleaned.length }, "중단된 서버 만들기를 정리했어요");
    } catch (e) {
      log?.warn({ file, err: (e as Error).message }, "중단된 작업 일지를 정리하지 못했어요");
    }
  }
}
