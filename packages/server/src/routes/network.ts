import type { FastifyInstance } from "fastify";
import type { NetworkInfo } from "@blockpilot/shared";
import { loadContext } from "../lib/context.js";
import { badRequest, conflict } from "../lib/errors.js";
import { readPropertiesFile, toRecord } from "../services/properties.js";
import { checkReachable, fetchPublicIp, pickLocalAddresses } from "../services/network.js";

export async function networkRoutes(app: FastifyInstance) {
  // 밖으로 아무것도 보내지 않는 정보만
  app.get("/api/servers/:id/network", async (req): Promise<NetworkInfo> => {
    const { id } = req.params as { id: string };
    const { dir } = await loadContext(id);
    const props = toRecord((await readPropertiesFile(dir)).lines);
    return { port: Number(props["server-port"] ?? 25565), serverIp: props["server-ip"] || undefined, local: pickLocalAddresses() };
  });

  // 사용자가 버튼을 눌렀을 때만 (ipify)
  app.post("/api/network/public-ip", async () => ({ ip: await fetchPublicIp() }));

  // 사용자가 버튼을 눌렀을 때만 (mcsrvstat.us 가 밖에서 이 서버에 접속해 본다)
  app.post("/api/servers/:id/network/check", async (req) => {
    const { id } = req.params as { id: string };
    const { dir, managed } = await loadContext(id);
    const st = await managed.status();
    if (st.state !== "running" && st.state !== "external") throw conflict("서버를 켠 뒤에 검사할 수 있어요.");
    const { ip } = (req.body ?? {}) as { ip?: string };
    if (ip !== undefined && typeof ip !== "string") throw badRequest("IP 가 올바르지 않아요.");
    const props = toRecord((await readPropertiesFile(dir)).lines);
    return checkReachable(ip || (await fetchPublicIp()), Number(props["server-port"] ?? 25565));
  });
}
