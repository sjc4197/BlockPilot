import type { FastifyInstance } from "fastify";
import { lookupProfile } from "../services/mojang.js";
import { badRequest } from "../lib/errors.js";

export async function mojangRoutes(app: FastifyInstance) {
  app.get("/api/mojang/profile", async (req) => {
    const { name } = req.query as { name?: string };
    if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw badRequest("닉네임은 영문/숫자/밑줄 1~16자입니다.");
    return lookupProfile(name);
  });
}
