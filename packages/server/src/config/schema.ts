import { z } from "zod";

/**
 * config.json 의 모양. "깨진 파일" 과 "멀쩡한 파일" 을 가르는 용도라 일부러 느슨하다:
 * 모르는 키는 그대로 보존하고(passthrough), 선택 하위 객체는 세부 필드를 검사하지 않는다.
 */

/** 지금 버전이 저장하는 schemaVersion. 파일 모양이 바뀌면 올리고 store.ts 의 MIGRATIONS 에 그 버전의 변환을 추가한다 */
export const CURRENT_SCHEMA_VERSION = 1;
/**
 * schemaVersion 이 없는 파일(1.3.x 이전이 쓴 것)에 붙이는 버전. CURRENT 와 같은 값이어도 상수는 따로 둔다:
 * 여기에 CURRENT 를 쓰면 나중에 CURRENT 를 2 로 올렸을 때 옛 파일이 "이미 2" 로 읽혀 마이그레이션을 건너뛰게 된다.
 */
export const LEGACY_SCHEMA_VERSION = 1;

const keyPairSchema = z.object({ publicKey: z.string(), secretKey: z.string() }).passthrough();

const serverSettingsSchema = z
  .object({
    backup: z.object({}).passthrough().optional(),
    automation: z.object({}).passthrough().optional(),
    p2p: z
      .object({
        enabled: z.boolean().optional(),
        keyPair: keyPairSchema.optional(),
        secret: z.string().optional(),
        approved: z.array(z.object({}).passthrough()).optional(),
        blocked: z.array(z.object({}).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const configFileSchema = z
  .object({
    schemaVersion: z.number().int().nonnegative().default(LEGACY_SCHEMA_VERSION),
    servers: z.array(z.object({ id: z.string(), name: z.string(), path: z.string(), createdAt: z.string() }).passthrough()).default([]),
    settings: z.record(serverSettingsSchema).optional(),
    auth: z.object({ token: z.string().optional() }).passthrough().optional(),
    p2pJoin: z
      .object({
        keyPair: keyPairSchema.optional(),
        remembered: z.object({ name: z.string().optional(), inviteCode: z.string(), usedAt: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ConfigFileShape = z.infer<typeof configFileSchema>;
