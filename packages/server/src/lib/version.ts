/**
 * 버전 문자열 비교. 모드 의존성 검사(mods.ts)와 새 서버 만들기의 버전 목록 정렬·하한 비교가 함께 쓴다.
 * 문자열 정렬은 "61.0.8" 뒤에 "61.0.10" 이 못 오므로 반드시 세그먼트를 숫자로 비교한다.
 */

export interface Version {
  core: number[];
  /** 프리릴리즈 식별자. "1.21.1-Fabric-5.1.3" → ["Fabric-5","1","3"]. 없으면 null */
  pre: string[] | null;
}

/**
 * "1.21.1" → core [1,21,1], "0.116.15+1.21.1" → 빌드 메타데이터 제거,
 * "1.21.1-Fabric-5.1.3" → core [1,21,1] + pre ["Fabric-5","1","3"]
 * YUNG 계열처럼 core 가 전부 같고 '-' 뒤에만 실제 버전이 있는 모드가 있어서 프리릴리즈를 버리면 안 된다.
 */
export function parseVersion(s: string): Version | null {
  const noBuild = s.trim().replace(/^v/i, "").split("+")[0];
  const dash = noBuild.indexOf("-");
  const coreStr = dash < 0 ? noBuild : noBuild.slice(0, dash);
  if (!/^\d+(\.\d+)*$/.test(coreStr)) return null;
  const preStr = dash < 0 ? "" : noBuild.slice(dash + 1);
  return { core: coreStr.split(".").map(Number), pre: preStr ? preStr.split(".") : null };
}

/** semver 규칙: core 비교 → 프리릴리즈 없는 쪽이 큼 → 식별자별로 숫자는 수치, 그 외는 문자열 비교 */
export function compareVersions(a: Version, b: Version): number {
  const len = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < len; i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 문자열끼리 비교. 파싱이 안 되는 쪽은 뒤로 보낸다 (둘 다 안 되면 문자열 비교) */
export function compareVersionStrings(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va && vb) return compareVersions(va, vb);
  if (va) return 1;
  if (vb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 최신순 정렬 (원본은 건드리지 않음) */
export function sortVersionsDesc<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((x, y) => compareVersionStrings(key(y), key(x)));
}

/** v 가 floor 이상인가 (예: "26.3" ≥ "1.18" 참, "1.17.1" ≥ "1.18" 거짓). 파싱 안 되면 거짓 */
export function versionAtLeast(v: string, floor: string): boolean {
  const a = parseVersion(v);
  const b = parseVersion(floor);
  if (!a || !b) return false;
  return compareVersions({ core: a.core, pre: null }, { core: b.core, pre: null }) >= 0;
}
