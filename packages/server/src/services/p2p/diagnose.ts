import type { P2pDiagnosis } from "@blockpilot/shared";
import { ProtocolError } from "./protocol.js";

/**
 * 연결 실패를 사용자 말로. hyperdht 오류 코드(HOLEPUNCH_*, PEER_NOT_FOUND …)와 우리 프로토콜 오류를
 * "무슨 일이 있었나 · 왜 그런가 · 해 볼 것 · 그래도 안 되면" 으로 바꾼다.
 */

const ALTERNATIVES: P2pDiagnosis["alternatives"] = [
  { label: "playit.gg", url: "https://playit.gg", note: "호스트 PC 에 작은 프로그램을 깔면 중계 서버를 통해 주소를 하나 줘요. 포트포워딩·P2P 둘 다 안 될 때 가장 쉬워요 (무료 플랜 있음)." },
  { label: "Tailscale", url: "https://tailscale.com", note: "호스트와 친구 모두 설치해 같은 가상 네트워크에 들어가는 VPN. 무료 플랜으로 친구 몇 명까지 충분해요." },
];

export type DiagnosisKind = "bad_code" | "host_off" | "rejected" | "timeout_approval" | "full" | "nat" | "network" | "unknown";

export function diagnoseJoinFailure(err: unknown): P2pDiagnosis {
  const e = err as { code?: string; message?: string } | undefined;
  const code = e instanceof ProtocolError ? `PROTO_${e.code.toUpperCase()}` : (e?.code ?? "");
  const msg = e?.message ?? String(err);

  const base = (kind: DiagnosisKind, title: string, cause: string, hints: string[], withAlternatives = false): P2pDiagnosis => ({ kind, title, cause, hints, alternatives: withAlternatives ? ALTERNATIVES : [] });

  if (code === "PROTO_BAD_MAC") return base("bad_code", "초대코드가 맞지 않아요.", "친구가 초대코드를 다시 만들었거나, 글자가 바뀌었어요.", ["친구에게 지금 보이는 초대코드를 다시 받아 통째로 붙여 넣으세요."]);
  if (code === "PROTO_CLOSED") return base("host_off", "호스트가 연결을 끊었어요.", "친구의 BlockPilot 에서 초대가 꺼져 있거나 서버가 꺼져 있을 수 있어요.", ["친구에게 대시보드의 '포트포워딩 없이 초대' 가 켜져 있고 서버가 켜져 있는지 물어보세요."]);
  if (code === "PEER_NOT_FOUND" || /PEER_NOT_FOUND/.test(msg)) return base("host_off", "호스트를 찾지 못했어요.", "친구의 BlockPilot 이 꺼져 있거나 초대가 꺼져 있어요. 켠 지 얼마 안 됐다면 네트워크에 알려지는 데 몇 초 걸려요.", ["친구에게 초대가 켜져 있는지(초대 중 표시) 확인하고 10초 뒤 다시 접속하세요.", "초대코드를 다시 받아 보세요 (코드 앞부분이 호스트 주소예요)."]);
  if (/HOLEPUNCH_DOUBLE_RANDOMIZED_NATS|REMOTE_NOT_HOLEPUNCHABLE|CANNOT_HOLEPUNCH/.test(code + msg)) {
    return base(
      "nat",
      "두 쪽 네트워크가 직접 연결을 허용하지 않아요.",
      "둘 중 한 쪽(또는 둘 다)이 대칭형 NAT 뒤에 있어요. 휴대폰 핫스팟, 일부 통신사(CGNAT), 회사·학교 네트워크에서 흔해요.",
      ["휴대폰 핫스팟이라면 집 와이파이로 바꿔 보세요.", "회사·학교 네트워크라면 집에서 다시 시도해 보세요.", "호스트가 공유기에서 UPnP 를 켜 두면 될 때가 있어요."],
      true,
    );
  }
  if (/HOLEPUNCH|HANDSHAKE_UNFINISHED|PEER_CONNECTION_FAILED|REMOTE_ABORTED|PROTO_TIMEOUT|시간 초과/.test(code + msg)) {
    return base(
      "network",
      "호스트와 연결되지 않았어요.",
      "홀 펀칭이 제때 끝나지 않았어요. 방화벽이 막고 있거나, 네트워크가 불안정하거나, 한쪽이 대칭형 NAT 일 수 있어요.",
      ["한 번 더 시도해 보세요. 처음엔 종종 두 번째에 돼요.", "양쪽 다 방화벽에서 BlockPilot 을 허용했는지 확인하세요 (Windows 는 처음 뜨는 창에서 '액세스 허용').", "VPN 을 켜 두었다면 끄고 다시 시도하세요."],
      true,
    );
  }
  if (/ENETUNREACH|ENOTFOUND|EAI_AGAIN|bootstrap/i.test(code + msg)) return base("network", "인터넷에 연결되지 않았어요.", "P2P 네트워크(부트스트랩 노드)에 닿지 못했어요.", ["인터넷 연결을 확인한 뒤 다시 시도하세요."]);
  return base("unknown", "연결하지 못했어요.", msg.split("\n")[0], ["한 번 더 시도해 보세요. 계속되면 친구에게 초대코드를 다시 받아 보세요."], true);
}

/** 승인·자리 같은 호스트 쪽 결정은 상태 코드로 오므로 따로 */
export function diagnoseStatus(kind: "rejected" | "timeout_approval" | "full"): P2pDiagnosis {
  if (kind === "rejected") return { kind, title: "호스트가 접속을 거절했어요.", cause: "친구가 승인 요청에서 '거절'을 눌렀어요.", hints: ["친구에게 이야기한 뒤 다시 접속하세요. 다음엔 바로 승인될 거예요."], alternatives: [] };
  if (kind === "timeout_approval") return { kind, title: "호스트가 제때 승인하지 않았어요.", cause: "승인 요청이 떠 있는 동안 친구가 자리에 없었어요.", hints: ["친구에게 BlockPilot 대시보드를 봐 달라고 한 뒤 다시 접속하세요."], alternatives: [] };
  return { kind, title: "호스트 서버에 자리가 없어요.", cause: "동시에 들어갈 수 있는 인원이 다 찼어요.", hints: ["잠시 후 다시 시도하세요."], alternatives: [] };
}
