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
  /** 외부 실행 중일 때 RCON으로 제어 가능한지 */
  rcon?: "connected" | "disabled" | "failed";
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
  loader: "fabric" | "forge" | "neoforge" | "paper" | "unknown";
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

// ---------- 설정 파일 편집기 (config/ 등) ----------

export interface ConfigFileEntry {
  /** 서버 폴더 기준 상대 경로 */
  path: string;
  sizeBytes: number;
  mtime: string;
  format: "toml" | "json" | "json5" | "properties" | "yaml" | "text";
}

export interface ConfigFileContent extends ConfigFileEntry {
  content: string;
}

export const SaveConfigFileInput = z.object({
  path: z.string().min(1),
  content: z.string().max(5 * 1024 * 1024),
});

export interface ConfigValidationResult {
  ok: boolean;
  message?: string;
  line?: number;
}

// ---------- 로그 ----------

export interface LogFileEntry {
  name: string;
  kind: "log" | "crash";
  sizeBytes: number;
  mtime: string;
  compressed: boolean;
}

export interface LogFileContent {
  name: string;
  /** 전체 줄 수 (잘렸으면 lines.length 보다 큼) */
  totalLines: number;
  truncated: boolean;
  lines: string[];
}

// ---------- 백업 ----------

export interface BackupEntry {
  file: string;
  sizeBytes: number;
  createdAt: string;
  /** 자동 백업이면 true */
  scheduled: boolean;
}

export const BackupSettings = z.object({
  /** 0이면 자동 백업 끔 */
  intervalMinutes: z.number().int().min(0).max(24 * 60 * 7),
  /** 보관할 자동 백업 개수 */
  keep: z.number().int().min(1).max(500),
  /** 서버가 중지 상태여도 자동 백업할지 */
  whenStopped: z.boolean(),
});
export type BackupSettings = z.infer<typeof BackupSettings>;

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { intervalMinutes: 0, keep: 10, whenStopped: false };

export interface BackupStatus {
  settings: BackupSettings;
  running: boolean;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

// ---------- 인증 ----------

export interface AuthInfo {
  /** 토큰이 필요한지 */
  required: boolean;
  /** 현재 요청이 인증된 상태인지 */
  authenticated: boolean;
}

// ---------- 공통 ----------

export interface ApiError {
  error: string;
  message: string;
}
