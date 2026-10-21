// 만든 단일 실행 파일을 실제로 켜서 확인한다 (릴리스 전 검사)
//   node scripts/smoke-sea.mjs out/sea/macos-arm64/blockpilot
// - 임시 앱 폴더·빈 포트, 브라우저는 열지 않음
// - /api/system 이 같은 버전을 돌려주는지, 대시보드 화면이 뜨는지, 웹 파일이 풀렸는지
// - 종료 신호에 정상 종료되는지
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const exe = path.resolve(process.argv[2] ?? "");
if (!fs.existsSync(exe)) throw new Error(`실행 파일이 없어요: ${exe}`);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const port = await freePort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bp-smoke-"));
const child = spawn(exe, [], { env: { ...process.env, BLOCKPILOT_PORT: String(port), BLOCKPILOT_HOME: home, BLOCKPILOT_NO_BROWSER: "1", LOG_LEVEL: "warn" }, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const fail = (msg) => {
  console.error(`✖ ${msg}\n--- 실행 파일 출력 ---\n${out}`);
  child.kill("SIGKILL");
  process.exit(1);
};
child.on("exit", (code) => code !== null && code !== 0 && fail(`실행 파일이 code ${code} 로 꺼졌어요`));

const base = `http://127.0.0.1:${port}`;
let sys;
for (let i = 0; i < 60 && !sys; i++) {
  await new Promise((r) => setTimeout(r, 500));
  sys = await fetch(`${base}/api/system`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}
if (!sys) fail("30초 안에 /api/system 이 응답하지 않았어요");
if (sys.version !== VERSION) fail(`버전이 달라요: ${sys.version} (기대 ${VERSION})`);
console.log(`✔ /api/system: BlockPilot ${sys.version} · ${sys.osLabel} · ${sys.archLabel}`);

const html = await fetch(`${base}/`).then((r) => r.text());
if (!html.includes('<div id="root">')) fail("대시보드 화면(index.html)이 안 떠요");
const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
if (!js || !(await fetch(base + js)).ok) fail("화면 스크립트를 못 받았어요");
console.log("✔ 대시보드 화면과 스크립트");
if (!fs.existsSync(path.join(home, "app", VERSION, "web", ".complete"))) fail("웹 파일이 앱 폴더에 풀리지 않았어요");
console.log("✔ 웹 파일을 앱 폴더에 풂");

const servers = await fetch(`${base}/api/servers`).then((r) => r.json());
if (!Array.isArray(servers)) fail("/api/servers 가 목록을 돌려주지 않아요");
console.log("✔ API (/api/servers)");

// 정상 종료 (Windows 는 신호 대신 프로세스 종료만 확인)
child.removeAllListeners("exit");
const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
child.kill(process.platform === "win32" ? undefined : "SIGTERM");
const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15000))]);
if (!res) fail("15초 안에 꺼지지 않았어요");
if (process.platform !== "win32" && res.code !== 0) fail(`종료 코드가 0 이 아니에요: ${JSON.stringify(res)}`);
console.log("✔ 정상 종료");
fs.rmSync(home, { recursive: true, force: true });
console.log("통과");
