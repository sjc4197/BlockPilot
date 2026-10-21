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

// ---------- 새 서버 만들기 ----------

export const CreateServerInput = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(60),
  mcVersion: z.string().min(1),
  loaderVersion: z.string().min(1),
  memory: z
    .object({ minMb: z.number().int().min(512).max(65536), maxMb: z.number().int().min(1024).max(65536) })
    .refine((m) => m.minMb <= m.maxMb, { message: "최소 메모리는 최대 메모리보다 클 수 없어요." }),
  /** server.properties 에 미리 써 둘 값 */
  properties: z.record(z.string(), z.string()).default({}),
  /** 입력하면 OP(레벨 4) + 화이트리스트에 추가 */
  ownerName: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,16}$/, "닉네임은 영문·숫자·밑줄 1~16자예요.")
    .optional(),
  /** 사용자가 직접 체크해야 한다. 자동으로 true 를 넣는 코드 경로는 없다 */
  eulaAccepted: z.literal(true, { errorMap: () => ({ message: "Minecraft EULA 에 동의해야 서버를 만들 수 있어요." }) }),
});
export type CreateServerInput = z.infer<typeof CreateServerInput>;

export type CreateStepId = "preflight" | "versions" | "java" | "server-jar" | "fabric" | "config" | "first-run" | "register";
export type CreateStepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface CreateStep {
  id: CreateStepId;
  label: string;
  state: CreateStepState;
  note?: string;
  progress?: { done: number; total?: number };
}

export type CreateJobState = "running" | "succeeded" | "failed" | "cancelled";

export interface CreateJobError {
  code: string;
  message: string;
  hint?: string;
  detail?: string;
}

export interface CreateJobStatus {
  id: string;
  state: CreateJobState;
  input: { path: string; name: string; mcVersion: string; loaderVersion: string };
  steps: CreateStep[];
  log: string[];
  error?: CreateJobError;
  /** 실패·취소 후 지운 항목 (대상 폴더 기준 상대 경로) */
  cleaned?: string[];
  /** 지우지 않고 남긴 것과 이유 */
  kept?: string[];
  serverId?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface CreateOptions {
  supported: boolean;
  platform: "macos" | "linux" | "windows" | "other";
  unsupportedMessage?: string;
  totalMemMb: number;
  /** Mojang 정식 릴리스 ∩ Fabric 안정 지원 (최신순) */
  releases: { id: string; releaseTime: string }[];
  defaults: { parentDir: string; memory: { minMb: number; maxMb: number } };
  /** BlockPilot 이 도중에 꺼져서 다음 시작 때 정리한 작업 */
  recovered: { target: string; cleaned: string[]; at: string }[];
  activeJobId?: string;
}

export interface CreateVersionInfo {
  mcVersion: string;
  javaMajor: number;
  java: { source: "system" | "cached" | "download"; version?: string; downloadMb?: number };
  serverJarMb: number;
  loaders: { version: string; stable: boolean }[];
  recommendedLoader?: string;
}

export interface FsListing {
  path: string;
  parent: string | null;
  home: string;
  /** 이 폴더가 비었는지 (.DS_Store 등 제외) */
  empty: boolean;
  isServer: boolean;
  entries: { name: string; path: string; empty: boolean | null; isServer: boolean }[];
  truncated: boolean;
  shortcuts: { label: string; path: string }[];
}

// ---------- 공통 ----------

export interface ApiError {
  error: string;
  message: string;
}

// ---------- 서버 삭제 ----------

export const DeleteServerInput = z.object({
  /** 실수 방지: 서버 이름을 그대로 입력해야 지운다 */
  confirmName: z.string(),
});
export type DeleteServerInput = z.infer<typeof DeleteServerInput>;

export interface DeleteServerResult {
  /** 실제로 지운 폴더 (심볼릭 링크로 등록됐다면 링크가 가리키던 폴더) */
  deletedPath: string;
  /** 등록 경로가 심볼릭 링크였다면 그 링크도 지움 */
  removedLink?: string;
}
