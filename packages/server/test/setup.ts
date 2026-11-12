import os from "node:os";
import path from "node:path";

// 테스트가 실제 ~/.blockpilot 을 건드리지 않게, 그리고 병렬 워커끼리 같은 config.json 을 덮어쓰지 않게 워커마다 다른 앱 폴더
// 테스트 중엔 실제 OS 알림(osascript 등)을 띄우지 않는다
process.env.BLOCKPILOT_NO_NOTIFY = "1";
process.env.BLOCKPILOT_HOME = path.join(os.tmpdir(), `bp-test-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`);
