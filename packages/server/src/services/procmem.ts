import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { platform } from "./platform/index.js";

const run = promisify(execFile);

export interface ProcRow {
  pid: number;
  ppid: number;
  kb: number;
}

/** root 와 그 자손 프로세스가 쓰는 메모리 합 (KB). 시작 스크립트(sh/cmd) 아래의 java 까지 센다 */
export function sumTree(rows: ProcRow[], root: number): number | null {
  if (!rows.some((r) => r.pid === root)) return null;
  const kids = new Map<number, ProcRow[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  let total = 0;
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    total += rows.find((r) => r.pid === p)?.kb ?? 0;
    for (const c of kids.get(p) ?? []) stack.push(c.pid);
  }
  return total;
}

/** `ps -A -o pid=,ppid=,rss=` 출력 → 행 */
export function parsePs(text: string): ProcRow[] {
  return text
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((a) => a.length >= 3 && a.every((n) => Number.isFinite(n)))
    .map(([pid, ppid, kb]) => ({ pid, ppid, kb }));
}

async function linuxRows(): Promise<ProcRow[]> {
  const rows: ProcRow[] = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const st = await fs.readFile(`/proc/${name}/status`, "utf8");
      const ppid = Number(st.match(/^PPid:\s+(\d+)/m)?.[1] ?? 0);
      const kb = Number(st.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
      rows.push({ pid: Number(name), ppid, kb });
    } catch {
      /* 그새 끝난 프로세스 */
    }
  }
  return rows;
}

async function windowsRows(): Promise<ProcRow[]> {
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([math]::Round($_.WorkingSetSize / 1KB))\" }"],
    { windowsHide: true, timeout: 15_000, maxBuffer: 8 << 20 },
  );
  return parsePs(stdout);
}

/** pid 와 자손이 쓰는 메모리 MB. 못 재면 null */
export async function treeMemoryMb(pid: number): Promise<number | null> {
  try {
    const rows = platform.id === "linux" ? await linuxRows() : platform.id === "windows" ? await windowsRows() : parsePs((await run("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 10_000, maxBuffer: 8 << 20 })).stdout);
    const kb = sumTree(rows, pid);
    return kb === null ? null : Math.round(kb / 1024);
  } catch {
    return null;
  }
}
