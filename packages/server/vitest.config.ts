import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 테스트가 실제 ~/.blockpilot (등록된 서버, 받아 둔 JDK) 을 건드리지 않도록
    env: { BLOCKPILOT_HOME: path.join(os.tmpdir(), `bp-test-home-${process.pid}`) },
  },
});
