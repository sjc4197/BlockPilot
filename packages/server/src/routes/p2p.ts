import type { FastifyInstance } from "fastify";
import { P2pApproveInput, P2pHostUpdate, P2pPeerKey } from "@blockpilot/shared";
import { loadContext } from "../lib/context.js";
import { badRequest } from "../lib/errors.js";
import { p2pSupport } from "../services/p2p/native.js";
import { p2pHostView, peerAction, rotateInvite, setP2pEnabled, type PeerAction } from "../services/p2p/host.js";

const ACTIONS: PeerAction[] = ["approve", "reject", "block", "unblock", "kick", "forget"];

/** 포트포워딩 없는 친구 초대 (P2P 터널) — 호스트 쪽 */
export async function p2pRoutes(app: FastifyInstance) {
  app.get("/api/p2p/support", async () => p2pSupport());

  app.get("/api/servers/:id/p2p", async (req) => {
    const { id } = req.params as { id: string };
    await loadContext(id);
    return p2pHostView(id);
  });

  app.put("/api/servers/:id/p2p", async (req) => {
    const { id } = req.params as { id: string };
    await loadContext(id);
    const { enabled } = P2pHostUpdate.parse(req.body ?? {});
    const view = await setP2pEnabled(id, enabled);
    req.log.info({ server: id, enabled }, enabled ? "P2P 초대를 켰어요" : "P2P 초대를 껐어요");
    return view;
  });

  /** 초대코드 재발급 (코드 자체는 로그에 남기지 않는다) */
  app.post("/api/servers/:id/p2p/invite/rotate", async (req) => {
    const { id } = req.params as { id: string };
    await loadContext(id);
    req.log.info({ server: id }, "P2P 초대코드를 다시 만들었어요");
    return rotateInvite(id);
  });

  app.post("/api/servers/:id/p2p/peers/:key/:action", async (req) => {
    const { id, key, action } = req.params as { id: string; key: string; action: string };
    await loadContext(id);
    const k = P2pPeerKey.parse(key);
    if (!ACTIONS.includes(action as PeerAction)) throw badRequest("알 수 없는 동작이에요.");
    const { name } = P2pApproveInput.parse(req.body ?? {});
    req.log.info({ server: id, peer: k.slice(0, 8), action }, "P2P 친구 관리");
    return peerAction(id, k, action as PeerAction, name);
  });
}
