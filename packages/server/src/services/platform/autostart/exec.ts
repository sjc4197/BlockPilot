import { execFile } from "node:child_process";
import { platform } from "../index.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 명령을 실행하고 결과를 돌려준다. 실패해도 던지지 않는다 (호출자가 code 로 판단) */
export function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    // 한국어 Windows 의 reg.exe 출력은 CP949 라 OS 규칙(platform.decode)으로 읽는다
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: "buffer" }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null;
      const dec = (b: Buffer | string | undefined) => (b ? (Buffer.isBuffer(b) ? platform.decode(b) : String(b)) : "");
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: dec(stdout), stderr: dec(stderr) });
    });
  });
}

export class AutostartError extends Error {
  constructor(
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "AutostartError";
  }
}
