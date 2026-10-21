// 개발 모드: 백엔드(4800)와 프론트(4801)를 함께 띄운다. macOS·Linux·Windows 공통.
import { spawn } from "node:child_process";

const win = process.platform === "win32";
const procs = ["packages/server", "packages/web"].map((ws) =>
  // Windows 의 npm 은 npm.cmd 라 shell 로 실행해야 한다
  spawn("npm", ["run", "dev", `--workspace=${ws}`], { stdio: "inherit", shell: win }),
);

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill();
  process.exitCode = code;
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
for (const p of procs) p.on("exit", (code) => stop(code ?? 0));
