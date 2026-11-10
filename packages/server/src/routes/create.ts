import type { FastifyInstance } from "fastify";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { CreateLoader, CreateServerInput, type CreateOptions, type CreateRelease, type CreateVersionInfo, type SystemInfo } from "@blockpilot/shared";
import { CreateError } from "../services/create/errors.js";
import { activeJob, getJob, recovered, startJob } from "../services/create/job.js";
import { createPipeline } from "../services/create/pipeline.js";
import { currentArch, findCachedRuntime, findSystemJava } from "../services/create/java.js";
import { getJdkPackage } from "../services/create/sources.js";
import { getVersionInfo } from "../services/create/loaders/mojang.js";
import { loaderInfos, providerOf } from "../services/create/loaders/index.js";
import { prepareTarget } from "../services/create/target.js";
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

export async function createRoutes(app: FastifyInstance) {
  /** BlockPilot 이 돌고 있는 컴퓨터 (자동 인식) */
  app.get("/api/system", async (): Promise<SystemInfo> => systemInfo());

  app.get("/api/create/options", async (): Promise<CreateOptions> => {
    const sys = systemInfo();
    const totalMemMb = Math.floor(os.totalmem() / MB);
    const base: CreateOptions = {
      supported: sys.support.create,
      platform: sys.os,
      totalMemMb,
      loaders: loaderInfos(),
      releases: [],
      defaults: { parentDir: path.join(os.homedir(), "Minecraft", "servers"), memory: defaultMemory(totalMemMb) },
      recovered: recovered.slice(-3),
      activeJobId: activeJob()?.id,
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
