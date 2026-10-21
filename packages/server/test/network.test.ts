import { describe, it, expect, afterEach } from "vitest";
import { checkReachable, fetchPublicIp, pickLocalAddresses, setNetworkFetch } from "../src/services/network.js";

const iface = (address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4") => ({ address, internal, family, netmask: "", mac: "", cidr: null }) as any;

afterEach(() => setNetworkFetch((...a) => fetch(...a)));

describe("friend connect helper", () => {
  it("lists LAN addresses first and skips loopback, IPv6 and link-local", () => {
    const r = pickLocalAddresses({
      lo0: [iface("127.0.0.1", true)],
      utun3: [iface("100.101.102.103")],
      en0: [iface("192.168.0.12"), iface("fe80::1", false, "IPv6")],
      bridge0: [iface("169.254.3.4")],
    });
    expect(r.map((a) => [a.address, a.kind])).toEqual([
      ["192.168.0.12", "lan"],
      ["100.101.102.103", "vpn"],
    ]);
  });

  it("reads the public IP and the outside check result, and explains failures in Korean", async () => {
    const seen: string[] = [];
    setNetworkFetch((async (url: string) => {
      seen.push(String(url));
      if (String(url).includes("ipify")) return new Response(JSON.stringify({ ip: "203.0.113.7" }));
      return new Response(JSON.stringify({ online: true, version: "1.21.1", players: { online: 2, max: 8 } }));
    }) as typeof fetch);
    expect(await fetchPublicIp()).toBe("203.0.113.7");
    const r = await checkReachable("203.0.113.7", 25565);
    expect(r).toMatchObject({ reachable: true, version: "1.21.1", players: { online: 2, max: 8 } });
    expect(seen[1]).toMatch(/mcsrvstat\.us\/3\/203\.0\.113\.7:25565$/);

    setNetworkFetch((async () => new Response(JSON.stringify({ online: false }))) as typeof fetch);
    expect((await checkReachable("203.0.113.7", 25565)).reachable).toBe(false);

    setNetworkFetch((async () => {
      throw new Error("offline");
    }) as typeof fetch);
    await expect(fetchPublicIp()).rejects.toThrow(/공인 IP/);
    await expect(checkReachable("203.0.113.7", 25565)).rejects.toThrow(/mcsrvstat/);
    await expect(checkReachable("evil.com/x", 25565)).rejects.toThrow(/IP 주소 형식/);
  });
});
