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

/** top 의 MEM 칸 ("1040M", "512K", "2G", "1040M+") → KB */
export function parseTopMem(v: string): number | null {
  const m = v.trim().match(/^([\d.]+)([KMGB])\+?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(n * ({ B: 1 / 1024, K: 1, M: 1024, G: 1024 * 1024 } as Record<string, number>)[m[2].toUpperCase()]);
}

/** 자손 프로세스 번호 목록 (root 포함) */
function treePids(rows: ProcRow[], root: number): number[] {
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    if (out.includes(p)) continue;
    out.push(p);
    for (const r of rows) if (r.ppid === p) stack.push(r.pid);
  }
  return out;
}

/**
 * macOS: ps 의 rss 는 압축된 메모리를 빼고 세서, 메모리가 빠듯한 맥에서는 자바가 실제보다 훨씬 적게 보인다.
 * 활동 모니터와 같은 값(top 의 MEM = phys_footprint)으로 잰다. 못 재면 rss 로.
 */
async function macTreeKb(root: number): Promise<number | null> {
  const rows = parsePs((await run("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 10_000, maxBuffer: 8 << 20 })).stdout);
  if (!rows.some((r) => r.pid === root)) return null;
  let total = 0;
  for (const pid of treePids(rows, root)) {
    let kb: number | null = null;
    try {
      const { stdout } = await run("top", ["-l", "1", "-stats", "pid,mem", "-pid", String(pid)], { timeout: 10_000 });
      const line = stdout.split("\n").find((l) => l.trim().startsWith(String(pid) + " "));
      kb = line ? parseTopMem(line.trim().split(/\s+/)[1] ?? "") : null;
    } catch {
      /* top 을 못 쓰면 아래 rss */
    }
    total += kb ?? rows.find((r) => r.pid === pid)?.kb ?? 0;
  }
  return total;
}

/** pid 와 자손이 쓰는 메모리 MB. 못 재면 null */
export async function treeMemoryMb(pid: number): Promise<number | null> {
  try {
    const kb = platform.id === "macos" ? await macTreeKb(pid) : sumTree(platform.id === "linux" ? await linuxRows() : await windowsRows(), pid);
    return kb === null ? null : Math.round(kb / 1024);
  } catch {
    return null;
  }
}
