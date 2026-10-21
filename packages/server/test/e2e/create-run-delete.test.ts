import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listServers } from "../../src/config/store.js";
import { CreateJob } from "../../src/services/create/job.js";
import { createPipeline } from "../../src/services/create/pipeline.js";
import { listLoaders } from "../../src/services/create/sources.js";
import { systemInfo } from "../../src/services/platform/index.js";
import { getManaged } from "../../src/services/process.js";
import { deleteServerFolder } from "../../src/services/serverDelete.js";

/**
 * 실제 E2E: 새 서버 만들기 → BlockPilot 으로 켜기 → 끄기 → 폴더째 삭제.
 * 인터넷과 몇 분이 필요해서 BLOCKPILOT_E2E=1 일 때만, 그리고 그 OS 에서 새 서버 만들기를 켠 경우에만 돈다.
 *
 * 테스트용 서버를 띄우려면 eula=true 가 필요하다. 테스트를 돌리는 사람이 EULA 에 동의한다는 뜻으로
 * BLOCKPILOT_E2E_ACCEPT_EULA=1 을 켜야만 진행한다 (앱 화면에서는 여전히 사용자가 직접 체크해야 함).
 */
const enabled = process.env.BLOCKPILOT_E2E === "1" && process.env.BLOCKPILOT_E2E_ACCEPT_EULA === "1" && systemInfo().support.create;
const MC = "1.21.1";
const PORT = "25590";

async function waitFor(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`시간 초과: ${what}`);
}

describe.runIf(enabled)(`E2E (${systemInfo().osLabel}): 새 서버 만들기 → 켜기 → 끄기 → 삭제`, () => {
  it(
    "works end to end",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-e2e-"));
      const target = path.join(root, "e2e-server");
      const loader = (await listLoaders(MC)).find((l) => l.stable)!.version;

      // 1) 만들기
      const job = new CreateJob({
        path: target,
        name: "e2e",
        mcVersion: MC,
        loaderVersion: loader,
        memory: { minMb: 1024, maxMb: 2048 },
        properties: { "server-port": PORT, "max-players": "2" },
        eulaAccepted: true,
      });
      await job.run(createPipeline());
      const st = job.status();
      console.log(st.steps.map((s) => `[${s.state}] ${s.label}${s.note ? ` — ${s.note}` : ""}`).join("\n"));
      if (st.state !== "succeeded") console.log(st.log.slice(-40).join("\n"));
      expect(st.error, JSON.stringify(st.error)).toBeUndefined();
      expect(st.state).toBe("succeeded");

      // 2) BlockPilot 으로 켜기 (시작 스크립트 사용)
      const server = (await listServers()).find((s) => s.id === st.serverId)!;
      const managed = getManaged(server.id, server.path);
      await managed.start();
      await waitFor(async () => (await managed.status()).state === "running", 5 * 60_000, "서버가 Done 까지 켜지기");

      // 3) 끄기 (stop 명령 → 정상 종료)
      await managed.stop();
      expect((await managed.status()).state).toBe("stopped");
      const history = managed.getHistory().map((l) => l.text).join("\n");
      expect(history).toMatch(/All dimensions are saved|Saving worlds/);

      // 4) 폴더째 삭제
      await deleteServerFolder(server, managed, "e2e");
      expect(await fsp.stat(target).then(() => true, () => false)).toBe(false);
      await fsp.rm(root, { recursive: true, force: true });
    },
    20 * 60_000,
  );
});
