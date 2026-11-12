import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { CREATE_LOADER_LABEL, type CreateJobState, type CreateJobStatus, type CreateLoader, type CreateServerInput, type CreateStep, type CreateStepId } from "@blockpilot/shared";
import { BLOCKPILOT_HOME } from "../../config/store.js";
import { CreateError, toCreateError } from "./errors.js";
import { cleanupTarget, removeTempPath } from "./target.js";
import { platform } from "../platform/index.js";
import { getUpload } from "./modpackUpload.js";

/**
 * 새 서버 만들기 작업 하나.
 * - 진행 상황(단계·진행률·로그)을 메모리에 들고 API 로 보여 준다
 * - 시작하자마자 일지(~/.blockpilot/jobs/<id>.json)를 남겨, BlockPilot 이 도중에 꺼져도 다음 실행 때 정리할 수 있게 한다
 * - 실패·취소 시: 자식 프로세스 종료 → 대상 폴더에서 시작 시점에 없던 것만 삭제 → 임시 파일 삭제
 */

export const JOBS_DIR = path.join(BLOCKPILOT_HOME, "jobs");
const LOG_LIMIT = 400;

/** 단계 이름. "loader" 는 서버 종류에 따라 다르다 */
export function stepLabels(loader: CreateLoader): Record<CreateStepId, string> {
  const name = CREATE_LOADER_LABEL[loader];
  return {
    preflight: "사전 점검",
    "modpack-check": "모드팩 확인",
    versions: "버전 정보 확인",
    java: "Java 준비",
    "server-jar": "Minecraft 서버 받기",
    loader: loader === "paper" ? "Paper 받기" : loader === "vanilla" ? "로더 설치" : `${name} 설치`,
    "modpack-install": "모드팩 모드·설정 넣기",
    config: "설정 파일 작성",
    "first-run": "최초 실행",
    register: "서버 목록에 등록",
  };
}
const STEP_ORDER: CreateStepId[] = ["preflight", "versions", "java", "server-jar", "loader", "config", "first-run", "register"];
const MODPACK_STEP_ORDER: CreateStepId[] = ["preflight", "modpack-check", "versions", "java", "server-jar", "loader", "modpack-install", "config", "first-run", "register"];

/** 단계 순서. 모드팩이면 "모드팩 확인"(사전 점검 뒤)과 "모드팩 모드·설정 넣기"(로더 설치 뒤)가 끼어든다 */
export function stepOrder(input: Pick<CreateServerInput, "modpack">): CreateStepId[] {
  return input.modpack ? MODPACK_STEP_ORDER : STEP_ORDER;
}

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
  readonly steps: CreateStep[];
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
  /** 화면 표시용 모드팩 정보 (만들기 시작 시점의 검사 결과) */
  private readonly modpackInfo?: NonNullable<CreateJobStatus["input"]["modpack"]>;

  constructor(readonly input: CreateServerInput) {
    const labels = stepLabels(input.loader);
    this.steps = stepOrder(input).map((id) => ({ id, label: labels[id], state: "pending" }));
    if (input.modpack) {
      const s = getUpload(input.modpack.uploadId)?.summary;
      this.modpackInfo = { name: s?.name ?? "모드팩", versionId: s?.versionId ?? input.modpack.versionId ?? "", source: input.modpack.source };
    }
  }

  get signal() {
    return this.ctrl.signal;
  }

  /** 취소됐으면 즉시 멈춘다. 긴 단계 사이사이에 부른다 */
  throwIfCancelled() {
    if (this.ctrl.signal.aborted) throw new CreateError("cancelled", "만들기를 취소했어요.");
  }

  status(): CreateJobStatus {
    const { path: p, name, loader, mcVersion, loaderVersion } = this.input;
    return {
      id: this.id,
      state: this.state,
      input: { path: this.journal?.target ?? p, name, loader, mcVersion, loaderVersion, ...(this.modpackInfo ? { modpack: { ...this.modpackInfo } } : {}) },
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
  /** 내려받기 진행률 표시를 지운다 (다음 작업은 진행률을 알 수 없을 때) */
  clearProgress(id: CreateStepId) {
    this.stepOf(id).progress = undefined;
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
    // 취소 직후에 띄워진 프로세스(설치기 등)가 끝까지 도는 일이 없게
    if (this.ctrl.signal.aborted) platform.killTree(child, true);
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

function processAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
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
      // 다른 BlockPilot 인스턴스(예: 로그인 자동 실행으로 겹쳐 뜬 것)가 지금 만들고 있는 서버는 건드리지 않는다
      if (processAlive(j.pid)) continue;
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
