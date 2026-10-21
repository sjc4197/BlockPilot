import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { platform } from "../src/services/platform/index.js";
import { getManaged, forgetManaged } from "../src/services/process.js";

/**
 * 시작 스크립트 끝의 pause ("계속하려면 아무 키나…") 처리.
 * 안내는 줄바꿈 없이 먼저 보이고(조각) 키를 넘기면 줄로 완성돼 한 번 더 보인다 → 입력을 두 번 닫으려다
 * write after end 로 BlockPilot 이 죽던 문제(Windows CI)를 막는다. Windows 에선 진짜 pause 를 쓴다.
 */
describe("start script that ends with a pause prompt", () => {
  it("answers the prompt once, the script finishes, and BlockPilot keeps running", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-pause-"));
    const id = `pause-test-${Date.now()}`;
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onErr);
    try {
      await fsp.writeFile(path.join(dir, "eula.txt"), "eula=true\n");
      await fsp.writeFile(path.join(dir, "server.properties"), "server-port=25597\n");
      const name = platform.startScripts[0];
      const body = name.endsWith(".bat")
        ? ["@echo off", "echo before-pause", "pause", "echo after-pause", ""].join("\r\n")
        : "#!/bin/sh\necho before-pause\nprintf 'Press any key to continue . . . '\nread x\necho\necho after-pause\n";
      await fsp.writeFile(path.join(dir, name), body, { mode: 0o755 });

      const managed = getManaged(id, dir);
      await managed.start();
      const end = Date.now() + 15_000;
      while (Date.now() < end && !managed.getHistory().some((l) => /서버 프로세스 종료/.test(l.text))) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 300));
      const text = managed.getHistory().map((l) => l.text).join("\n");
      expect(text).toContain("after-pause");
      expect(text).toMatch(/서버 프로세스 종료/);
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onErr);
      forgetManaged(id);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
