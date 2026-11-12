import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { CreateLoader, CreateServerInput, ModpackInspectInput, ModpackLoader, type CreateOptions, type CreateRelease, type CreateVersionInfo, type ModpackInspectResult, type SystemInfo } from "@blockpilot/shared";
import { CreateError } from "../services/create/errors.js";
import { activeJob, getJob, recovered, startJob } from "../services/create/job.js";
import { createPipeline } from "../services/create/pipeline.js";
import { currentArch, findCachedRuntime, findSystemJava } from "../services/create/java.js";
import { getJdkPackage } from "../services/create/sources.js";
import { getVersionInfo } from "../services/create/loaders/mojang.js";
import { loaderInfos, providerOf } from "../services/create/loaders/index.js";
import { prepareTarget } from "../services/create/target.js";
import { analyzeMrpack, assertMatchesInput, precheckLoader } from "../services/create/modpack.js";
import { MODPACK_UPLOAD_MAX_BYTES, ModpackBusyError, ModpackTooLargeError, dropUpload, getUpload, releaseUpload, rememberSummary, storeFromUrl, storeUpload, sweepUploads, type StoredUpload } from "../services/create/modpackUpload.js";
import { getModpackVersionFile } from "../services/modrinthModpack.js";
import { notFound } from "../lib/errors.js";
import { platform, systemInfo } from "../services/platform/index.js";

const MB = 1024 * 1024;

/** 이 컴퓨터 메모리에 맞춘 기본값: 최대는 RAM 의 절반(2~8GB), 시작은 그 절반 */
function defaultMemory(totalMb: number) {
  const maxMb = Math.min(8192, Math.max(2048, Math.floor(totalMb / 2 / 512) * 512));
  return { minMb: Math.max(1024, Math.floor(maxMb / 2 / 512) * 512), maxMb };
}

function loaderParam(q: { loader?: string }) {
  const parsed = CreateLoader.safeParse(q.loader ?? "fabric");
  if (!parsed.success) throw new CreateError("invalid_setting", `'${q.loader}' 는 만들 수 없는 서버 종류예요.`, "목록에 있는 종류를 골라 주세요.");
  return providerOf(parsed.data);
}

const toRelease = (r: { id: string; releaseTime: string }): CreateRelease => ({ id: r.id, releaseTime: r.releaseTime });

const totalMemMb = () => Math.floor(os.totalmem() / MB);

/**
 * 보관한 팩을 검사해 요약과 판별(클라이언트 전용 등)을 붙인다. 검사에 실패하면 보관 파일을 지운다.
 * 보관할 때 잡아 둔 busy 는 끝나면 푼다 (검사 중에 다른 업로드가 밀어내지 못하게)
 */
async function inspectStored(up: StoredUpload, fileName: string, signal?: AbortSignal): Promise<ModpackInspectResult> {
  try {
    const { summary, plan } = await analyzeMrpack(up.file, totalMemMb(), { signal });
    // 팩이 정한 로더 버전을 실제로 설치할 수 있는지 (없으면 modpack_unsupported, 확인 못 하면 경고만)
    await precheckLoader(summary, providerOf(summary.loader), signal);
    return rememberSummary(up.id, fileName, summary, plan);
  } catch (e) {
    await dropUpload(up.id).catch(() => {});
    throw e;
  } finally {
    releaseUpload(up.id);
  }
}

function tooLarge(reply: FastifyReply, e: ModpackTooLargeError) {
  return reply.code(413).send({ error: e.code, message: e.message, hint: e.hint });
}

function busy(reply: FastifyReply, e: ModpackBusyError) {
  return reply.code(429).send({ error: e.code, message: e.message, hint: e.hint });
}

/**
 * 화면이 요청을 끊으면(창 닫기·다른 팩 고르기) 받던 팩을 멈추는 신호.
 * 요청(IncomingMessage)의 close 는 본문을 다 읽으면 바로 오기 때문에, 응답을 보내기 전에 연결이 닫힐 때로 판단한다
 */
function clientGone(req: FastifyRequest, reply: FastifyReply): AbortSignal {
  const ctrl = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) ctrl.abort();
  };
  reply.raw.once("close", onClose);
  // 본문을 읽는 도중에 끊긴 경우 (req.raw 의 aborted 는 이때만 true)
  req.raw.once("close", () => {
    if (req.raw.readableAborted) ctrl.abort();
  });
  return ctrl.signal;
}

export async function createRoutes(app: FastifyInstance) {
  // 지난 실행이 남긴 모드팩 임시 파일 정리 + 10분마다 만료 정리
  void sweepUploads().catch((e) => app.log.warn({ err: (e as Error).message }, "모드팩 임시 파일을 정리하지 못했어요"));

  /** BlockPilot 이 돌고 있는 컴퓨터 (자동 인식) */
  app.get("/api/system", async (): Promise<SystemInfo> => systemInfo());

  app.get("/api/create/options", async (): Promise<CreateOptions> => {
    const sys = systemInfo();
    const memMb = totalMemMb();
    const base: CreateOptions = {
      supported: sys.support.create,
      platform: sys.os,
      totalMemMb: memMb,
      loaders: loaderInfos(),
      releases: [],
      defaults: { parentDir: path.join(os.homedir(), "Minecraft", "servers"), memory: defaultMemory(memMb) },
      recovered: recovered.slice(-3),
      activeJobId: activeJob()?.id,
      modpackUploadMaxBytes: MODPACK_UPLOAD_MAX_BYTES,
    };
    if (!base.supported) {
      base.unsupportedMessage = sys.reason ?? "이 컴퓨터에서는 새 서버 만들기를 지원하지 않아요.";
      return base;
    }
    // Fabric 메타가 잠시 죽어도 화면(종류 목록·기본값)은 떠야 한다. 버전 목록은 화면이 releases API 로 따로 받는다
    base.releases = await providerOf("fabric")
      .listReleases()
      .then((r) => r.map(toRelease))
      .catch(() => []);
    return base;
  });

  /** 로더별 Minecraft 정식 버전 목록 (최신순) */
  app.get("/api/create/releases", async (req): Promise<CreateRelease[]> => {
    const provider = loaderParam(req.query as { loader?: string });
    return (await provider.listReleases()).map(toRelease);
  });

  app.get("/api/create/version-info", async (req): Promise<CreateVersionInfo> => {
    const q = req.query as { mc?: string; loader?: string };
    if (!q.mc) throw new CreateError("invalid_setting", "Minecraft 버전을 골라 주세요.", "버전 칸에서 하나를 고른 뒤 다시 시도해 주세요.");
    const provider = loaderParam(q);
    const mc = q.mc;
    const [info, versions] = await Promise.all([getVersionInfo(mc), provider.listVersions(mc)]);
    const javaMajor = await provider.javaMajor(mc, info.javaMajor);
    const estimate = await provider.downloadEstimate(mc, versions.recommended, info.server.size);
    const arch = currentArch();
    let java: CreateVersionInfo["java"];
    const sys = await findSystemJava(javaMajor);
    const cached = sys || !arch ? null : await findCachedRuntime(javaMajor, arch);
    if (sys) java = { source: "system", version: sys.version };
    else if (cached) java = { source: "cached", version: cached.version };
    else {
      const pkg = arch ? await getJdkPackage(javaMajor, arch, platform.jdk().os).catch(() => null) : null;
      java = { source: "download", downloadMb: pkg ? Math.round(pkg.size / MB) : undefined };
    }
    return {
      loader: provider.info.id,
      mcVersion: mc,
      javaMajor,
      java,
      downloadMb: Math.round(estimate.mb * 10) / 10,
      downloadNote: estimate.note,
      loaders: versions.versions,
      recommendedLoader: versions.recommended,
    };
  });

  /** .mrpack 올리기 → 임시 보관 → 검사. 파일은 메모리에 올리지 않고 바로 디스크로 흘려 쓴다 */
  app.post("/api/create/modpack/upload", async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MODPACK_UPLOAD_MAX_BYTES, files: 1 } });
    if (!part) throw new CreateError("modpack_invalid", "올린 파일이 없어요.", "모드팩(.mrpack) 파일을 골라 주세요.");
    if (!/\.(mrpack|zip)$/i.test(part.filename ?? "")) {
      part.file.resume();
      throw new CreateError("modpack_invalid", "모드팩(.mrpack) 파일만 올릴 수 있어요.", "Modrinth 에서 받은 .mrpack 파일을 골라 주세요.", part.filename);
    }
    let up: StoredUpload;
    try {
      up = await storeUpload(part.file, part.filename, MODPACK_UPLOAD_MAX_BYTES, { hold: true });
    } catch (e) {
      if (e instanceof ModpackTooLargeError) return tooLarge(reply, e);
      if (e instanceof ModpackBusyError) {
        part.file.resume();
        return busy(reply, e);
      }
      throw e;
    }
    // multipart 의 fileSize 제한에 걸리면 스트림이 잘린 채 끝난다
    if (part.file.truncated) {
      await dropUpload(up.id);
      return tooLarge(reply, new ModpackTooLargeError(MODPACK_UPLOAD_MAX_BYTES));
    }
    return inspectStored(up, part.filename, clientGone(req, reply));
  });

  /** Modrinth 의 모드팩 버전을 받아 임시 보관 → 검사 */
  app.post("/api/create/modpack/inspect", async (req, reply) => {
    const inp = ModpackInspectInput.parse(req.body);
    // 고른 팩(projectId)의 버전인지까지 확인
    const version = await getModpackVersionFile(inp.versionId, inp.projectId);
    const signal = clientGone(req, reply);
    let up: StoredUpload;
    try {
      up = await storeFromUrl(version.file.url, version.file.sha512, version.file.size, version.file.filename, { hold: true, signal });
    } catch (e) {
      if (e instanceof ModpackTooLargeError) return tooLarge(reply, e);
      if (e instanceof ModpackBusyError) return busy(reply, e);
      throw e;
    }
    return inspectStored(up, version.file.filename, signal);
  });

  app.post("/api/create", async (req, reply) => {
    let input: CreateServerInput;
    try {
      input = CreateServerInput.parse(req.body);
    } catch (e) {
      if (e instanceof ZodError) {
        const issue = e.issues[0];
        throw new CreateError(issue.path[0] === "eulaAccepted" ? "eula_required" : "invalid_setting", issue.message, issue.path[0] === "eulaAccepted" ? "EULA 를 읽고 동의 체크박스를 직접 체크해 주세요." : "입력한 값을 확인해 주세요.");
      }
      throw e;
    }
    const sys = systemInfo();
    if (!sys.support.create) throw new CreateError("unsupported_platform", sys.reason ?? "이 컴퓨터에서는 새 서버 만들기를 지원하지 않아요.", "이미 만든 서버 폴더는 '이미 있는 서버 폴더 추가'로 연결할 수 있어요.");
    providerOf(input.loader);
    if (input.modpack) {
      const up = getUpload(input.modpack.uploadId);
      if (!up?.summary) throw new CreateError("modpack_expired", "고른 모드팩의 임시 파일이 사라졌어요.", "모드팩을 다시 골라 주세요.");
      if (!ModpackLoader.safeParse(input.loader).success) throw new CreateError("invalid_setting", "모드팩은 Fabric·Forge·NeoForge 서버로만 만들 수 있어요.", "모드팩을 다시 골라 주세요.");
      assertMatchesInput(up.summary, input);
    }
    // 폴더 문제는 작업을 시작하기 전에 바로 알려 준다 (파이프라인에서도 다시 확인)
    await prepareTarget(input.path);
    const job = startJob(input, createPipeline());
    reply.code(202);
    return { jobId: job.id };
  });

  app.get("/api/create/jobs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) throw notFound("만들기 작업을 찾을 수 없어요. BlockPilot 을 다시 켰다면 작업 기록이 사라졌어요.");
    return job.status();
  });

  app.post("/api/create/jobs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) throw notFound("만들기 작업을 찾을 수 없어요.");
    return { cancelled: job.cancel() };
  });
}
