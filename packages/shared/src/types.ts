import { z } from "zod";

// ---------- 서버 등록 ----------

export const ServerLoader = z.enum(["fabric", "forge", "neoforge", "paper", "vanilla", "unknown"]);
export type ServerLoader = z.infer<typeof ServerLoader>;

export const RegisteredServer = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
});
export type RegisteredServer = z.infer<typeof RegisteredServer>;

export const RegisterServerInput = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(60).optional(),
});
export type RegisterServerInput = z.infer<typeof RegisterServerInput>;

export const ProcessState = z.enum(["stopped", "starting", "running", "stopping", "external"]);
export type ProcessState = z.infer<typeof ProcessState>;

export interface ProcessStatus {
  state: ProcessState;
  pid?: number;
  startedAt?: string;
  /** 서버가 "Done" 로그를 출력했는지 */
  ready: boolean;
  onlinePlayers: string[];
}

export interface ServerSummary extends RegisteredServer {
  exists: boolean;
  loader: ServerLoader;
  loaderVersion?: string;
  mcVersion?: string;
  levelName: string;
  eulaAccepted: boolean;
  hasStartScript: boolean;
  javaVersion?: string;
  modCount: number;
  process: ProcessStatus;
  properties: {
    motd: string;
    port: number;
    difficulty: string;
    gamemode: string;
    maxPlayers: number;
    whitelist: boolean;
  };
}

// ---------- server.properties ----------

export interface PropertyEntry {
  key: string;
  value: string;
}

export interface PropertiesResponse {
  entries: PropertyEntry[];
  /** 파일 수정 시각 */
  mtime: string;
}

export const UpdatePropertiesInput = z.object({
  changes: z.record(z.string(), z.string()),
});
export type UpdatePropertiesInput = z.infer<typeof UpdatePropertiesInput>;

export interface UpdatePropertiesResult {
  /** 파일에 저장된 키 */
  saved: string[];
  /** 실행 중 콘솔 명령으로 즉시 반영된 키 */
  appliedLive: string[];
  /** 재시작해야 반영되는 키 */
  needsRestart: string[];
}

// ---------- 플레이어 목록 ----------

export const PlayerListKind = z.enum(["whitelist", "ops", "banned-players", "banned-ips"]);
export type PlayerListKind = z.infer<typeof PlayerListKind>;

export interface WhitelistEntry {
  uuid: string;
  name: string;
}

export interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

export interface BannedPlayerEntry {
  uuid: string;
  name: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

export interface BannedIpEntry {
  ip: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

export const AddPlayerInput = z.object({
  name: z.string().min(1).max(16).optional(),
  uuid: z.string().optional(),
  ip: z.string().optional(),
  level: z.number().int().min(1).max(4).optional(),
  bypassesPlayerLimit: z.boolean().optional(),
  reason: z.string().max(200).optional(),
});
export type AddPlayerInput = z.infer<typeof AddPlayerInput>;

export interface MojangProfile {
  id: string;
  name: string;
}

// ---------- 모드 ----------

export interface ModDependency {
  id: string;
  version: string;
  satisfied: boolean | null;
}

export interface ModInfo {
  file: string;
  enabled: boolean;
  sizeBytes: number;
  loader: "fabric" | "forge" | "neoforge" | "unknown";
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  authors: string[];
  environment?: "*" | "client" | "server";
  depends: ModDependency[];
  iconDataUrl?: string;
  missingDeps: string[];
}

export const UpdateModInput = z.object({
  enabled: z.boolean(),
});

// ---------- 콘솔 ----------

export interface ConsoleLine {
  ts: number;
  text: string;
  source: "stdout" | "stderr" | "system" | "input";
}

export type ConsoleServerMessage =
  | { type: "history"; lines: ConsoleLine[] }
  | { type: "line"; line: ConsoleLine }
  | { type: "status"; status: ProcessStatus };

export type ConsoleClientMessage = { type: "command"; command: string };

// ---------- 공통 ----------

export interface ApiError {
  error: string;
  message: string;
}
