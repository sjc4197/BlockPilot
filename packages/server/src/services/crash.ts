import fs from "node:fs/promises";
import path from "node:path";
import type { CrashSummary, CrashSuspect, ModInfo } from "@blockpilot/shared";
import { listMods } from "./mods.js";

/**
 * 크래시 원인 요약. crash-reports/ 의 최신 리포트와 마지막 로그 줄을 읽어
 * 흔한 원인(모드 충돌·빠진 모드·메모리·포트·Java 버전)을 알아보고, 아니면 오류에 가장 많이 나온 모드를 고른다.
 * 확실하지 않으면 "추정"이라고만 말한다.
 */

// 원인으로 고르지 않을 것 (로더·기본 라이브러리)
const NOT_SUSPECTS = /^(minecraft|java|fabricloader|fabric-loader|mixinextras|forge|neoforge|fml|mixin)$/;

export async function latestCrashReport(dir: string, sinceMs?: number): Promise<{ file: string; text: string } | null> {
  const cdir = path.join(dir, "crash-reports");
  let names: string[];
  try {
    names = (await fs.readdir(cdir)).filter((n) => n.endsWith(".txt"));
  } catch {
    return null;
  }
  const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(cdir, n))).mtimeMs })));
  const newest = withTime.filter((x) => sinceMs === undefined || x.t >= sinceMs - 5000).sort((a, b) => b.t - a.t)[0];
  if (!newest) return null;
  const fh = await fs.open(path.join(cdir, newest.n), "r");
  try {
    const buf = Buffer.alloc(300_000);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { file: newest.n, text: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await fh.close();
  }
}

function suspectFromMods(mods: ModInfo[]) {
  const byId = new Map<string, ModInfo>();
  const byFile = new Map<string, ModInfo>();
  for (const m of mods) {
    if (m.id) byId.set(m.id.toLowerCase(), m);
    byFile.set(m.file.toLowerCase().replace(/\.disabled$/, ""), m);
  }
  const toSuspect = (m: ModInfo): CrashSuspect => ({ id: m.id, name: m.name ?? m.id ?? m.file, file: m.file });
  return { byId, byFile, toSuspect };
}

/** 리포트·로그 글에서 원인을 읽는다 (파일을 읽지 않는 순수 함수: 테스트용) */
export function explainCrash(text: string, mods: ModInfo[]): Omit<CrashSummary, "at"> {
  const { byId, byFile, toSuspect } = suspectFromMods(mods);

  if (/Incompatible mods found|Some of your mods are incompatible|Mod resolution failed/i.test(text)) {
    const names = new Set<string>();
    for (const m of text.matchAll(/(?:Mod|모드) '([^']+)' \(([\w.-]+)\)/g)) names.add(m[1]);
    const missing = new Set<string>();
    for (const m of text.matchAll(/requires (?:any version of |version [^ ]+ of |[^ ]+ of )?'?([\w.-]+)'?(?:,|\s|\(| which)/g)) missing.add(m[1]);
    for (const m of text.matchAll(/[-–] ([\w.-]+)\(.*?\)을\(를\) 설치하세요|([\w.-]+)\([^)]*\)이 필요하지만/g)) missing.add(m[1] ?? m[2]);
    for (const m of text.matchAll(/HARD_DEP_NO_CANDIDATE [\w.-]+ [\w.+-]+ \{depends ([\w.-]+)/g)) missing.add(m[1]);
    const miss = [...missing].filter((x) => !names.has(x) && !NOT_SUSPECTS.test(x));
    return {
      kind: "incompatible",
      title: names.size ? `모드끼리 맞지 않아요: ${[...names].slice(0, 3).join(", ")}` : "모드끼리 맞지 않아요",
      hint: miss.length ? `${miss.slice(0, 3).join(", ")} 모드가 빠져 있어요. 설치하거나, 이 모드가 필요한 모드를 꺼 주세요.` : "로그에 적힌 모드를 맞는 버전으로 바꾸거나 꺼 주세요.",
      suspects: [...names].map((n) => [...byId.values()].find((m) => m.name === n)).filter(Boolean).map((m) => toSuspect(m!)),
    };
  }
  if (/OutOfMemoryError/.test(text)) {
    return { kind: "memory", title: "서버 메모리가 모자랐어요", hint: "시작 스크립트의 최대 메모리(-Xmx)를 늘려 주세요. 예: -Xmx6G. 컴퓨터 메모리의 절반을 넘기지 않는 게 좋아요.", suspects: [] };
  }
  if (/FAILED TO BIND TO PORT/i.test(text)) {
    return { kind: "port", title: "서버 포트를 다른 프로그램이 쓰고 있어요", hint: "켜져 있는 다른 마인크래프트 서버를 끄거나, 서버 설정에서 포트를 바꿔 주세요.", suspects: [] };
  }
  if (/UnsupportedClassVersionError|requires running the game with Java|compiled by a more recent version of the Java Runtime/i.test(text)) {
    return { kind: "java", title: "이 서버에 맞지 않는 Java 로 실행됐어요", hint: "시작 스크립트의 Java 경로를 이 Minecraft 버전에 맞는 Java 로 바꿔 주세요.", suspects: [] };
  }

  // 오류에 가장 많이 나온 모드
  const score = new Map<string, number>();
  const bump = (m: ModInfo | undefined, w: number) => {
    if (!m || (m.id && NOT_SUSPECTS.test(m.id)) || (m.id?.startsWith("fabric-") && m.id !== "fabric-api")) return;
    const k = m.file;
    score.set(k, (score.get(k) ?? 0) + w);
  };
  for (const m of text.matchAll(/(?:Mixin apply for mod|from mod|Mod ID: '?|Suspected Mods?:\s*[^\n(]*\()\s*([a-z][\w-]{1,63})/gi)) bump(byId.get(m[1].toLowerCase()), 5);
  for (const m of text.matchAll(/\[([^\]\s:]+\.jar)[:\]]/g)) bump(byFile.get(m[1].toLowerCase()), 1);
  for (const m of text.matchAll(/\$([a-z][a-z0-9_]{1,63})\$/g)) bump(byId.get(m[1]), 2);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    const top = ranked.slice(0, 2).map(([file]) => mods.find((m) => m.file === file)!);
    const name = top[0].name ?? top[0].id ?? top[0].file;
    return {
      kind: "mod",
      title: `${name} 모드에서 문제가 생긴 것 같아요 (추정)`,
      hint: "이 모드를 업데이트하거나 모드 화면에서 잠깐 꺼 둔 뒤 다시 켜 보세요.",
      suspects: top.map(toSuspect),
    };
  }
  return { kind: "unknown", title: "서버가 갑자기 꺼졌어요", hint: "로그 화면에서 마지막 오류 줄과 크래시 리포트를 확인해 주세요.", suspects: [] };
}

export async function analyzeCrash(dir: string, opts: { startedAt?: string; recent: string[]; exitCode?: number | null; uptimeSeconds?: number }): Promise<CrashSummary> {
  const report = await latestCrashReport(dir, opts.startedAt ? new Date(opts.startedAt).getTime() : undefined).catch(() => null);
  const mods = await listMods(dir).catch(() => [] as ModInfo[]);
  const text = [report?.text ?? "", opts.recent.join("\n")].join("\n");
  return { ...explainCrash(text, mods), reportFile: report?.file, at: new Date().toISOString(), exitCode: opts.exitCode, uptimeSeconds: opts.uptimeSeconds };
}
