import path from "node:path";
import type { LoaderProvider } from "./types.js";
import { listMojangReleases } from "./mojang.js";
import { downloadFile } from "../download.js";

/** 순정: 로더 없이 Mojang server.jar 만 */
export const vanilla: LoaderProvider = {
  info: {
    id: "vanilla",
    label: "순정",
    summary: "모드·플러그인 없이 Mojang 공식 서버 그대로. 가장 단순해요",
    hasVersions: false,
    versionLabel: "",
  },
  listReleases: (signal) => listMojangReleases(signal),
  listVersions: async () => ({ versions: [] }),
  javaMajor: async (_mc, mojangMajor) => mojangMajor,
  downloadEstimate: async (_mc, _v, serverJarBytes) => ({ mb: serverJarBytes / 1048576 }),
  assertVersion: async () => {},
  async install({ job, target, server }) {
    await downloadServerJar(job, target, server);
    job.skipStep("loader", "순정 서버라 설치할 로더가 없어요");
    return { kind: "jar", jar: "server.jar" };
  },
};

/** Mojang server.jar 를 받아 sha1 을 확인한다 (순정·Fabric 공용) */
export async function downloadServerJar(job: InstallJob, target: string, server: { url: string; sha1: string; size: number }) {
  job.startStep("server-jar", `${(server.size / 1048576).toFixed(1)} MB`);
  await downloadFile({
    url: server.url,
    dest: path.join(target, "server.jar"),
    hash: { algo: "sha1", expected: server.sha1 },
    expectedSize: server.size,
    signal: job.signal,
    onProgress: (d, t) => job.progress("server-jar", d, t),
  });
  job.finishStep("server-jar", "sha1 일치");
}

type InstallJob = Pick<import("../job.js").CreateJob, "startStep" | "finishStep" | "skipStep" | "progress" | "signal">;
