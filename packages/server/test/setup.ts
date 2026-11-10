import os from "node:os";
import path from "node:path";

// 테스트가 실제 ~/.blockpilot 을 건드리지 않게, 그리고 병렬 워커끼리 같은 config.json 을 덮어쓰지 않게 워커마다 다른 앱 폴더
process.env.BLOCKPILOT_HOME = path.join(os.tmpdir(), `bp-test-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`);
