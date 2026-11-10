import type DHT from "hyperdht";
import type { DHTOptions } from "hyperdht";

/**
 * hyperdht 불러오기. 네이티브 모듈(udx-native · sodium-native)이 필요하다.
 * - npm start: node_modules 에서 그대로
 * - 단일 실행 파일: build-sea 가 require-addon 을 shim 으로 바꿔, 실행 파일 안에 든 .node 를 앱 폴더에 풀어 불러온다
 * - 못 불러오면(Alpine 등 prebuild 없음) 기능을 끄고 이유를 보여 준다
 */

export interface P2pSupport {
  supported: boolean;
  reason?: string;
}

let loaded: { ctor: typeof DHT } | { error: string } | undefined;

export async function loadHyperdht(): Promise<typeof DHT | null> {
  if (!loaded) {
    try {
      const m = (await import("hyperdht")) as unknown as { default?: typeof DHT } & typeof DHT;
      loaded = { ctor: (m.default ?? m) as typeof DHT };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      loaded = { error: msg };
    }
  }
  return "ctor" in loaded ? loaded.ctor : null;
}

export async function p2pSupport(): Promise<P2pSupport> {
  const ctor = await loadHyperdht();
  if (ctor) return { supported: true };
  const err = loaded && "error" in loaded ? loaded.error : "";
  const musl = process.platform === "linux" && !(process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  const reason = musl
    ? "이 컴퓨터용 P2P 네트워크 모듈이 없어요 (Alpine Linux 처럼 musl 을 쓰는 배포판은 지원하지 않아요)."
    : `P2P 네트워크 모듈을 불러오지 못했어요: ${err.split("\n")[0]}`;
  return { supported: false, reason };
}

/** 부트스트랩 노드 교체 (BLOCKPILOT_DHT_BOOTSTRAP="host:port,host:port"). 비우면 hyperdht 기본(공개) 노드 */
export function bootstrapFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.BLOCKPILOT_DHT_BOOTSTRAP?.trim();
  if (!raw) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function createDht(opts: DHTOptions = {}): Promise<DHT> {
  const ctor = await loadHyperdht();
  if (!ctor) throw new Error((await p2pSupport()).reason);
  const bootstrap = opts.bootstrap ?? bootstrapFromEnv();
  return new ctor({ ...opts, ...(bootstrap ? { bootstrap } : {}) });
}
