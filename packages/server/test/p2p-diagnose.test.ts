import { describe, it, expect } from "vitest";
import { diagnoseJoinFailure, diagnoseStatus } from "../src/services/p2p/diagnose.js";
import { ProtocolError, VERSION_MISMATCH_MESSAGE } from "../src/services/p2p/protocol.js";

const dhtErr = (code: string) => Object.assign(new Error(`${code}: x`), { code });

describe("diagnoseJoinFailure", () => {
  it("maps hyperdht and protocol errors to Korean causes, hints and (only when useful) alternatives", () => {
    expect(diagnoseJoinFailure(new ProtocolError("x", "bad_mac"))).toMatchObject({ kind: "bad_code", alternatives: [] });
    expect(diagnoseJoinFailure(dhtErr("PEER_NOT_FOUND")).kind).toBe("host_off");
    const nat = diagnoseJoinFailure(dhtErr("HOLEPUNCH_DOUBLE_RANDOMIZED_NATS"));
    expect(nat.kind).toBe("nat");
    expect(nat.cause).toMatch(/대칭형 NAT|핫스팟/);
    expect(nat.alternatives.map((a) => a.label)).toEqual(["playit.gg", "Tailscale"]);
    expect(diagnoseJoinFailure(dhtErr("HOLEPUNCH_PROBE_TIMEOUT")).kind).toBe("network");
    expect(diagnoseJoinFailure(new ProtocolError("호스트와 연결되지 않았어요 (시간 초과).", "timeout")).kind).toBe("network");
    expect(diagnoseJoinFailure(new ProtocolError("closed", "closed")).kind).toBe("host_off");
    const unknown = diagnoseJoinFailure(new Error("weird thing"));
    expect(unknown.kind).toBe("unknown");
    expect(unknown.cause).toBe("weird thing");
    expect(unknown.hints.length).toBeGreaterThan(0);
  });

  it("tells both sides to update when the protocol version differs, with the releases link and no third-party alternatives", () => {
    const d = diagnoseJoinFailure(new ProtocolError(VERSION_MISMATCH_MESSAGE, "version_mismatch"));
    expect(d.title).toMatch(/BlockPilot 버전이 달라요/);
    expect(d.hints.some((h) => /최신 버전/.test(h))).toBe(true);
    expect(d.hints.some((h) => h.includes("https://github.com/sjc4197/BlockPilot/releases"))).toBe(true);
    expect(d.alternatives).toEqual([]);
  });

  it("explains host decisions without pointing at other services", () => {
    expect(diagnoseStatus("rejected")).toMatchObject({ kind: "rejected", alternatives: [] });
    expect(diagnoseStatus("timeout_approval").title).toMatch(/제때 승인/);
    expect(diagnoseStatus("full").title).toMatch(/자리가 없어요/);
  });
});
