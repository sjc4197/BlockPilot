import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreateLoader } from "@blockpilot/shared";
import { listServers } from "../../src/config/store.js";
import { CreateJob } from "../../src/services/create/job.js";
import { createPipeline, defaultDeps } from "../../src/services/create/pipeline.js";
import { providers } from "../../src/services/create/loaders/index.js";
import { platform, systemInfo } from "../../src/services/platform/index.js";
import { getManaged } from "../../src/services/process.js";
import { deleteServerFolder } from "../../src/services/serverDelete.js";
import { detectServer } from "../../src/services/serverInfo.js";

/**
 * 실제 E2E: 새 서버 만들기 → BlockPilot 으로 켜기 → 끄기 → 폴더째 삭제. 서버 종류(로더)마다 한 번씩.
 * 인터넷과 몇 분이 필요해서 BLOCKPILOT_E2E=1 일 때만, 그리고 그 OS 에서 새 서버 만들기를 켠 경우에만 돈다.
 * BLOCKPILOT_E2E_LOADERS=fabric,paper 처럼 로더를 고를 수 있다 (기본: 구현된 로더 전부).
 *
 * 테스트용 서버를 띄우려면 eula=true 가 필요하다. 테스트를 돌리는 사람이 EULA 에 동의한다는 뜻으로
 * BLOCKPILOT_E2E_ACCEPT_EULA=1 을 켜야만 진행한다 (앱 화면에서는 여전히 사용자가 직접 체크해야 함).
 */
const enabled = process.env.BLOCKPILOT_E2E === "1" && process.env.BLOCKPILOT_E2E_ACCEPT_EULA === "1" && systemInfo().support.create;
const MC = "1.21.1";
const PORT = "25590";
const available = Object.keys(providers) as CreateLoader[];
const picked = (process.env.BLOCKPILOT_E2E_LOADERS ?? "").split(",").map((s) => s.trim()).filter(Boolean) as CreateLoader[];
const loaders = picked.length ? picked : available;

async function waitFor(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`시간 초과: ${what}`);
}

/**
 * jdkDownload=true 면 시스템 Java 를 못 찾은 것처럼 해서, JDK 를 앱 폴더에 받아 쓰는 경로까지 확인한다.
 * (제품 코드는 그대로, 파이프라인에 넘기는 Java 찾기 함수만 바꿈). 시간이 오래 걸려 Fabric 에서만.
 */
const cases: { name: string; loader: CreateLoader; jdkDownload: boolean }[] = loaders.filter((l) => available.includes(l)).map((loader) => ({ name: `${loader} · 시스템 Java`, loader, jdkDownload: false }));
if (process.env.BLOCKPILOT_E2E_JDK_DOWNLOAD === "1" && loaders.includes("fabric")) cases.push({ name: "fabric · JDK 를 앱 폴더에 받아서", loader: "fabric", jdkDownload: true });

describe.runIf(enabled && cases.length > 0)(`E2E (${systemInfo().osLabel}): 새 서버 만들기 → 켜기 → 끄기 → 삭제`, () => {
  it.each(cases)(
    "$name",
    async ({ loader, jdkDownload }) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-e2e-"));
      const target = path.join(root, `e2e-${loader}${jdkDownload ? "-jdk" : ""}`);
      const provider = providers[loader];
      const loaderVersion = provider.info.hasVersions ? (await provider.listVersions(MC)).recommended! : "";

      // 1) 만들기
      const job = new CreateJob({
        path: target,
        name: `e2e-${loader}`,
        loader,
        mcVersion: MC,
        loaderVersion,
        memory: { minMb: 1024, maxMb: 2048 },
        properties: { "server-port": PORT, "max-players": "2" },
        eulaAccepted: true,
      });
      await job.run(createPipeline(jdkDownload ? { ...defaultDeps, findSystemJava: async () => null, findCachedRuntime: async () => null } : defaultDeps));
      const st = job.status();
      console.log(st.steps.map((s) => `[${s.state}] ${s.label}${s.note ? ` — ${s.note}` : ""}`).join("\n"));
      if (st.state !== "succeeded") console.log(st.log.slice(-40).join("\n"));
      expect(st.error, JSON.stringify(st.error)).toBeUndefined();
      expect(st.state).toBe("succeeded");

      // 1-1) 폴더만 보고도 종류·버전을 알아보는지 (대시보드 표시)
      const info = await detectServer(target);
      expect(info.loader).toBe(loader);
      expect(info.mcVersion).toBe(MC);
      if (provider.info.hasVersions) expect(info.loaderVersion).toBe(loaderVersion);

      // 2) BlockPilot 으로 켜기 (시작 스크립트 사용)
      const server = (await listServers()).find((s) => s.id === st.serverId)!;
      const managed = getManaged(server.id, server.path);
      await managed.start();
      await waitFor(async () => (await managed.status()).state === "running", 5 * 60_000, "서버가 Done 까지 켜지기");

      // 3) 끄기 (stop 명령 → 정상 종료)
      await managed.stop();
      expect((await managed.status()).state).toBe("stopped");
      const history = managed.getHistory().map((l) => l.text).join("\n");
      expect(history).toMatch(/All dimensions are saved|Saving worlds|Saving chunks|Stopping server/);
      expect(history).not.toMatch(/강제 종료/);

      // 3-1) Windows: 사용자가 직접 만든 것처럼 끝에 pause 가 있는 start.bat 으로도 켜고 끌 수 있는지
      if (platform.id === "windows" && !jdkDownload) {
        const bat = path.join(server.path, "start.bat");
        const ours = (await fsp.readFile(bat, "utf8")).split("\r\n").filter((l) => !/BP_EXIT|^rem /.test(l));
        await fsp.writeFile(bat, [...ours.filter(Boolean), "pause", ""].join("\r\n"));
        await managed.start();
        await waitFor(async () => (await managed.status()).state === "running", 5 * 60_000, "pause 있는 start.bat 으로 켜기");
        await managed.stop();
        await waitFor(async () => (await managed.status()).state === "stopped", 60_000, "pause 있는 start.bat 이 끝나기");
        expect(managed.getHistory().map((l) => l.text).join("\n")).not.toMatch(/강제 종료/);
      }

      // 4) 폴더째 삭제
      await deleteServerFolder(server, managed, `e2e-${loader}`);
      expect(await fsp.stat(target).then(() => true, () => false)).toBe(false);

      // CI 에서 로그인 없이 볼 수 있는 요약 (GitHub Actions 알림)
      if (process.env.GITHUB_ACTIONS) {
        const java = st.steps.find((s) => s.id === "java")?.note ?? "";
        console.log(`::notice title=E2E ${systemInfo().osLabel} ${loader} (${jdkDownload ? "앱 폴더 JDK" : "시스템 Java"})::만들기·켜기·끄기·삭제 통과 — ${java}${platform.id === "windows" && !jdkDownload ? " · pause 있는 start.bat 정상 종료" : ""}`);
      }
      await fsp.rm(root, { recursive: true, force: true });
    },
    30 * 60_000,
  );
});
