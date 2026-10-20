import type { FastifyInstance } from "fastify";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { CreateServerInput, type CreateOptions, type CreateVersionInfo } from "@blockpilot/shared";
import { CreateError } from "../services/create/errors.js";
import { activeJob, getJob, recovered, startJob } from "../services/create/job.js";
import { createPipeline } from "../services/create/pipeline.js";
import { currentArch, findCachedRuntime, findSystemJava } from "../services/create/java.js";
import { getJdkPackage, getVersionInfo, listLoaders, listReleases } from "../services/create/sources.js";
import { prepareTarget } from "../services/create/target.js";
import { notFound } from "../lib/errors.js";

const MB = 1024 * 1024;

function platformName(): CreateOptions["platform"] {
  return process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : "other";
}

/** 이 Mac 메모리에 맞춘 기본값: 최대는 RAM 의 절반(2~8GB), 시작은 그 절반 */
function defaultMemory(totalMb: number) {
  const maxMb = Math.min(8192, Math.max(2048, Math.floor(totalMb / 2 / 512) * 512));
  return { minMb: Math.max(1024, Math.floor(maxMb / 2 / 512) * 512), maxMb };
}

export async function createRoutes(app: FastifyInstance) {
  app.get("/api/create/options", async (): Promise<CreateOptions> => {
    const platform = platformName();
    const totalMemMb = Math.floor(os.totalmem() / MB);
    const base: CreateOptions = {
      supported: platform === "macos" && currentArch() !== null,
      platform,
      totalMemMb,
      releases: [],
      defaults: { parentDir: path.join(os.homedir(), "Minecraft", "servers"), memory: defaultMemory(totalMemMb) },
      recovered: recovered.slice(-3),
      activeJobId: activeJob()?.id,
    };
    if (!base.supported) {
      base.unsupportedMessage = platform === "linux" || platform === "windows" ? `${platform === "linux" ? "Linux" : "Windows"} 지원은 아직 준비 중이에요. 지금은 macOS 에서만 새 서버를 만들 수 있어요.` : "이 컴퓨터에서는 새 서버 만들기를 지원하지 않아요.";
      return base;
    }
    base.releases = (await listReleases()).map((r) => ({ id: r.id, releaseTime: r.releaseTime }));
    return base;
  });

  app.get("/api/create/version-info", async (req): Promise<CreateVersionInfo> => {
    const { mc } = req.query as { mc?: string };
    if (!mc) throw new CreateError("not_found", "Minecraft 버전을 골라 주세요.");
    const [info, loaders] = await Promise.all([getVersionInfo(mc), listLoaders(mc)]);
    const arch = currentArch();
    let java: CreateVersionInfo["java"];
    const sys = await findSystemJava(info.javaMajor);
    const cached = sys || !arch ? null : await findCachedRuntime(info.javaMajor, arch);
    if (sys) java = { source: "system", version: sys.version };
    else if (cached) java = { source: "cached", version: cached.version };
    else {
      const pkg = arch ? await getJdkPackage(info.javaMajor, arch).catch(() => null) : null;
      java = { source: "download", downloadMb: pkg ? Math.round(pkg.size / MB) : undefined };
    }
    return {
      mcVersion: mc,
      javaMajor: info.javaMajor,
      java,
      serverJarMb: Math.round((info.server.size / MB) * 10) / 10,
      loaders,
      recommendedLoader: loaders.find((l) => l.stable)?.version ?? loaders[0]?.version,
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
    if (platformName() !== "macos") throw new CreateError("unsupported_platform", "새 서버 만들기는 아직 macOS 에서만 할 수 있어요.", "Linux·Windows 지원은 준비 중이에요.");
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
