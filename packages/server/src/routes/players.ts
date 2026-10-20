import type { FastifyInstance } from "fastify";
import { AddPlayerInput, PlayerListKind } from "@blockpilot/shared";
import { readList, writeList, mcTimestamp } from "../services/playerLists.js";
import { lookupProfile } from "../services/mojang.js";
import { loadContext } from "../lib/context.js";
import { badRequest } from "../lib/errors.js";

/**
 * 화이트리스트 / OP / 밴 관리.
 * 서버가 실행 중이면 콘솔 명령으로 처리 (서버가 파일을 다시 쓰므로), 아니면 파일을 직접 수정.
 */
export async function playersRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/players/:kind", async (req) => {
    const { id, kind: rawKind } = req.params as { id: string; kind: string };
    const kind = PlayerListKind.parse(rawKind);
    const { dir } = await loadContext(id);
    return readList(dir, kind);
  });

  app.post("/api/servers/:id/players/:kind", async (req, reply) => {
    const { id, kind: rawKind } = req.params as { id: string; kind: string };
    const kind = PlayerListKind.parse(rawKind);
    const input = AddPlayerInput.parse(req.body);
    const { dir, managed } = await loadContext(id);
    const live = (await managed.status()).state === "running";

    if (kind === "banned-ips") {
      if (!input.ip) throw badRequest("IP를 입력하세요.");
      if (live) {
        managed.sendCommand(`ban-ip ${input.ip}${input.reason ? " " + input.reason : ""}`);
        return { applied: "live" };
      }
      const list = await readList<any>(dir, kind);
      if (!list.some((e) => e.ip === input.ip)) {
        list.push({ ip: input.ip, created: mcTimestamp(), source: "BlockPilot", expires: "forever", reason: input.reason ?? "Banned by an operator." });
        await writeList(dir, kind, list);
      }
      reply.code(201);
      return { applied: "file" };
    }

    if (!input.name) throw badRequest("닉네임을 입력하세요.");
    const profile = input.uuid ? { id: input.uuid, name: input.name } : await lookupProfile(input.name);

    if (live) {
      const cmd =
        kind === "whitelist" ? `whitelist add ${profile.name}`
        : kind === "ops" ? `op ${profile.name}`
        : `ban ${profile.name}${input.reason ? " " + input.reason : ""}`;
      managed.sendCommand(cmd);
      return { applied: "live", profile };
    }

    const list = await readList<any>(dir, kind);
    const idx = list.findIndex((e) => e.uuid === profile.id);
    let entry: any;
    if (kind === "whitelist") entry = { uuid: profile.id, name: profile.name };
    else if (kind === "ops") entry = { uuid: profile.id, name: profile.name, level: input.level ?? 4, bypassesPlayerLimit: input.bypassesPlayerLimit ?? false };
    else entry = { uuid: profile.id, name: profile.name, created: mcTimestamp(), source: "BlockPilot", expires: "forever", reason: input.reason ?? "Banned by an operator." };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    await writeList(dir, kind, list);
    reply.code(201);
    return { applied: "file", profile };
  });

  app.delete("/api/servers/:id/players/:kind/:key", async (req) => {
    const { id, kind: rawKind, key } = req.params as { id: string; kind: string; key: string };
    const kind = PlayerListKind.parse(rawKind);
    const { dir, managed } = await loadContext(id);
    const list = await readList<any>(dir, kind);
    const entry = kind === "banned-ips" ? list.find((e) => e.ip === key) : list.find((e) => e.uuid === key || e.name === key);
    if (!entry) return { applied: "none" };

    if ((await managed.status()).state === "running") {
      const cmd =
        kind === "whitelist" ? `whitelist remove ${entry.name}`
        : kind === "ops" ? `deop ${entry.name}`
        : kind === "banned-players" ? `pardon ${entry.name}`
        : `pardon-ip ${entry.ip}`;
      managed.sendCommand(cmd);
      return { applied: "live" };
    }
    await writeList(dir, kind, list.filter((e) => e !== entry));
    return { applied: "file" };
  });
}
