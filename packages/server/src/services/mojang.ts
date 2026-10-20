import type { MojangProfile } from "@blockpilot/shared";
import { notFound, badRequest } from "../lib/errors.js";

const cache = new Map<string, { profile: MojangProfile; at: number }>();
const TTL = 1000 * 60 * 60; // 1시간

/** 닉네임 → UUID (대시 포함 형식으로 변환) */
export async function lookupProfile(name: string): Promise<MojangProfile> {
  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.profile;

  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (res.status === 404 || res.status === 204) throw notFound(`'${name}' 닉네임을 Mojang에서 찾을 수 없습니다.`);
  if (res.status === 429) throw badRequest("Mojang API 요청 한도 초과. 잠시 후 다시 시도하세요.");
  if (!res.ok) throw badRequest(`Mojang API 오류 (${res.status})`);

  const data = (await res.json()) as { id: string; name: string };
  const profile = { id: dashify(data.id), name: data.name };
  cache.set(key, { profile, at: Date.now() });
  return profile;
}

export function dashify(id: string): string {
  const s = id.replace(/-/g, "");
  if (s.length !== 32) return id;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
