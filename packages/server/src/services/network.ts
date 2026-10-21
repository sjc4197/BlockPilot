import os from "node:os";
import type { LocalAddress, ReachabilityResult } from "@blockpilot/shared";
import { HttpError } from "../lib/errors.js";

/**
 * 친구 접속 도우미.
 * - 같은 와이파이 주소: 이 컴퓨터의 네트워크 정보만 읽는다 (밖으로 보내는 것 없음)
 * - 공인 IP·밖에서 접속 검사: 사용자가 버튼을 누를 때만 외부 서비스(ipify, mcsrvstat.us)에 묻는다
 */

const isPrivate = (a: string) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
const isCgnat = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);

/** 친구가 같은 공유기에서 접속할 주소 후보 (사설 IPv4 먼저) */
export function pickLocalAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [iface, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== "IPv4" || i.address.startsWith("169.254.")) continue;
      out.push({ iface, address: i.address, kind: isPrivate(i.address) ? "lan" : isCgnat(i.address) ? "vpn" : "other" });
    }
  }
  const rank = (a: LocalAddress) => (a.kind === "lan" ? 0 : a.kind === "vpn" ? 1 : 2) + (/^(en0|eth0|wlan0|wlp|Wi-Fi|이더넷)/i.test(a.iface) ? 0 : 0.5);
  return out.sort((a, b) => rank(a) - rank(b));
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** 테스트용 */
export function setNetworkFetch(f: Fetch) {
  fetchImpl = f;
}
// 테스트할 때만 이 컴퓨터 안의 가짜 서비스로 돌린다 (진짜 공인 IP 를 밖에 보내지 않게)
const IPIFY = () => process.env.BLOCKPILOT_PUBLIC_IP_URL ?? "https://api.ipify.org?format=json";
const MCSRV = () => process.env.BLOCKPILOT_SERVER_CHECK_URL ?? "https://api.mcsrvstat.us/3/";
const UA = { "user-agent": "BlockPilot (Minecraft server dashboard; https://github.com/sjc4197/BlockPilot)" };

export async function fetchPublicIp(): Promise<string> {
  try {
    const res = await fetchImpl(IPIFY(), { headers: UA, signal: AbortSignal.timeout(6000) });
    const j = (await res.json()) as { ip?: string };
    if (!res.ok || !j.ip || !/^[\d.:a-f]+$/i.test(j.ip)) throw new Error("bad");
    return j.ip;
  } catch {
    throw new HttpError(502, "public_ip_failed", "공인 IP 를 확인하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
}

export async function checkReachable(ip: string, port: number): Promise<ReachabilityResult> {
  if (!/^[\d.]+$|^[\da-f:]+$/i.test(ip)) throw new HttpError(400, "bad_ip", "IP 주소 형식이 아니에요.");
  let j: { online?: boolean; version?: string; players?: { online: number; max: number }; debug?: { cachetime?: number } };
  try {
    const host = ip.includes(":") ? `[${ip}]` : ip;
    const res = await fetchImpl(`${MCSRV()}${host}:${port}`, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    j = (await res.json()) as typeof j;
  } catch {
    throw new HttpError(502, "check_failed", "접속 검사 서비스(mcsrvstat.us)에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
  return {
    ip,
    port,
    reachable: j.online === true,
    version: j.online ? j.version : undefined,
    players: j.online ? j.players : undefined,
    cachedNote: "검사 서비스가 결과를 몇 분 동안 저장해 둬서, 방금 바꾼 공유기 설정은 조금 뒤에 반영돼요.",
  };
}
