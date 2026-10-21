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
  /** 실행에 쓰는 시작 스크립트 이름 (start.sh / start.bat …) */
  startScript?: string;
  /** 다른 OS 용 시작 스크립트만 있을 때 (쓰지 않고 jar 를 직접 실행) */
  foreignScript?: string;
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
  /** 화면에 보여 줄 경로 조각 (OS 마다 구분자가 달라 서버가 계산) */
  crumbs: { label: string; path: string }[];
  /** 이 폴더가 비었는지 (.DS_Store 등 제외) */
  empty: boolean;
  isServer: boolean;
  entries: { name: string; path: string; empty: boolean | null; isServer: boolean }[];
  truncated: boolean;
  shortcuts: { label: string; path: string; kind: "home" | "folder" | "drive" }[];
}

// ---------- 공통 ----------

export interface ApiError {
  error: string;
  message: string;
}

// ---------- 이 컴퓨터 (자동 인식) ----------

export interface SystemInfo {
  os: "macos" | "linux" | "windows";
  /** 예: "macOS 26.6.2", "Ubuntu 24.04.1 LTS", "Windows 11 (빌드 22631)" */
  osLabel: string;
  arch: string;
  /** 예: "Apple Silicon", "x64", "ARM64" */
  archLabel: string;
  libc?: "glibc" | "musl";
  support: { manage: "ok" | "wip"; create: boolean };
  /** 지원하지 않거나 준비 중인 이유 */
  reason?: string;
  words: { thisComputer: string; fileManager: string; modKey: string };
  pathExample: string;
  sep: "/" | "\\";
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

// ---------- 서버 사건 · 알림 · 자동화 ----------

/** 서버에서 일어난 일. 디스코드 알림·자동 재시작·통계가 모두 이것을 듣는다 */
export type ServerEventType = "started" | "stopped" | "crashed" | "auto-restart" | "auto-restart-failed" | "scheduled-restart" | "joined" | "left" | "backup";

export interface CrashSuspect {
  id?: string;
  name: string;
  file?: string;
}

/** 크래시 원인 요약 */
export interface CrashSummary {
  kind: "mod" | "incompatible" | "memory" | "port" | "java" | "unknown";
  /** 한 줄 설명 (예: "Naturalist 모드에서 오류가 났어요") */
  title: string;
  /** 해결 방법 */
  hint: string;
  suspects: CrashSuspect[];
  /** crash-reports/ 안의 파일 이름 */
  reportFile?: string;
  at: string;
  exitCode?: number | null;
  uptimeSeconds?: number;
}

export interface ServerEvent {
  serverId: string;
  type: ServerEventType;
  at: string;
  player?: string;
  /** 사건 직후 접속자 수 */
  online?: number;
  crash?: CrashSummary;
  /** 사건마다 덧붙이는 짧은 설명 (백업 파일 이름, 재시작까지 남은 초 등) */
  detail?: string;
}

export const DISCORD_EVENTS = ["started", "stopped", "crashed", "restarted", "joined", "left", "backup"] as const;
export type DiscordEventKey = (typeof DISCORD_EVENTS)[number];
export const DISCORD_EVENT_LABEL: Record<DiscordEventKey, string> = {
  started: "서버 켜짐",
  stopped: "서버 꺼짐",
  crashed: "크래시",
  restarted: "자동·예약 재시작",
  joined: "입장",
  left: "퇴장",
  backup: "백업 완료",
};

const DiscordEvents = z.object(Object.fromEntries(DISCORD_EVENTS.map((k) => [k, z.boolean()])) as Record<DiscordEventKey, z.ZodBoolean>);
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각은 05:00 처럼 써 주세요.");

export const AutomationSettings = z.object({
  discord: z.object({
    /** 비밀값. API 로는 돌려주지 않는다 */
    webhookUrl: z.string(),
    events: DiscordEvents,
  }),
  autoRestart: z.object({
    enabled: z.boolean(),
    delaySeconds: z.number().int().min(5).max(600),
  }),
  scheduledRestart: z.object({
    enabled: z.boolean(),
    time: HHMM,
    /** 0=일요일 … 6=토요일 */
    days: z.array(z.number().int().min(0).max(6)).min(1, "요일을 하나 이상 골라 주세요."),
    onlyWhenEmpty: z.boolean(),
  }),
});
export type AutomationSettings = z.infer<typeof AutomationSettings>;

export const DEFAULT_AUTOMATION: AutomationSettings = {
  discord: { webhookUrl: "", events: { started: true, stopped: true, crashed: true, restarted: true, joined: true, left: true, backup: false } },
  autoRestart: { enabled: false, delaySeconds: 30 },
  scheduledRestart: { enabled: false, time: "05:00", days: [0, 1, 2, 3, 4, 5, 6], onlyWhenEmpty: true },
};

/** 화면에 돌려주는 모양: 웹훅 주소 대신 설정 여부와 끝 네 글자만 */
export interface AutomationView {
  discord: { webhookSet: boolean; webhookHint?: string; events: AutomationSettings["discord"]["events"]; lastSentAt?: string; lastError?: string };
  autoRestart: AutomationSettings["autoRestart"] & { recentAttempts: number; gaveUp: boolean; pendingAt?: string };
  scheduledRestart: AutomationSettings["scheduledRestart"] & { nextAt?: string; skipNext: boolean };
  lastCrash?: CrashSummary;
}

/** 일부만 바꾸기. webhookUrl 은 "" 이면 지우고, 없으면 그대로 둔다 */
export const AutomationUpdate = z.object({
  discord: z.object({ webhookUrl: z.string().optional(), events: DiscordEvents.partial().optional() }).optional(),
  autoRestart: AutomationSettings.shape.autoRestart.partial().optional(),
  scheduledRestart: AutomationSettings.shape.scheduledRestart.partial().optional(),
});
export type AutomationUpdate = z.infer<typeof AutomationUpdate>;

// ---------- 친구 접속 도우미 ----------

export interface LocalAddress {
  /** 네트워크 장치 이름 (en0, Wi-Fi 등) */
  iface: string;
  address: string;
  kind: "lan" | "vpn" | "other";
}

export interface NetworkInfo {
  port: number;
  /** server.properties 의 server-ip (비어 있으면 모든 주소에서 받음) */
  serverIp?: string;
  local: LocalAddress[];
}

export interface PublicIpResult {
  ip: string;
}

export interface ReachabilityResult {
  ip: string;
  port: number;
  reachable: boolean;
  version?: string;
  players?: { online: number; max: number };
  /** 검사 서비스가 결과를 잠깐 저장해 두므로 방금 바꾼 설정은 늦게 보일 수 있음 */
  cachedNote: string;
}

// ---------- 성능 모니터 ----------

export interface PerfSample {
  t: number;
  /** 서버 프로세스(자식 포함)가 실제로 쓰는 메모리 MB */
  memMb?: number;
  /** 한 틱에 걸린 평균 시간 ms (/tick query, 50ms 가 한계) */
  mspt?: number;
}

export interface PerfInfo {
  /** BlockPilot 이 켠 서버(또는 RCON 연결된 외부 서버)만 측정 */
  measuring: boolean;
  /** 시작 스크립트의 -Xmx (MB) */
  maxMemMb?: number;
  samples: PerfSample[];
  tick: "ok" | "unsupported" | "unknown";
  lag: { lastHour: number; worstMs?: number; lastAt?: string };
  advice?: string;
}

// ---------- 플레이어 통계 ----------

export interface StatCount {
  /** 예: "minecraft:stone" */
  id: string;
  n: number;
}

export interface PlayerStats {
  uuid: string;
  name?: string;
  playMinutes: number;
  deaths: number;
  mined: number;
  walkedKm: number;
  mobKills: number;
  playerKills: number;
  jumps: number;
  topMined: StatCount[];
  topKilled: StatCount[];
  killedBy: StatCount[];
  savedAt: string;
}

export interface StatsResponse {
  world: string;
  /** 통계 파일 중 가장 최근에 저장된 시각 */
  savedAt?: string;
  players: PlayerStats[];
  /** BlockPilot 이 지켜본 최근 7일 접속 시간 (분) */
  week: { name: string; minutes: number }[];
}

// ---------- Modrinth ----------

export interface ModrinthHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  /** "required" | "optional" | "unsupported" */
  serverSide: string;
  clientSide: string;
  /** 이 서버에 이미 깔려 있는지 */
  installed: boolean;
}

export interface ModrinthSearchResult {
  /** 이 서버에서 Modrinth 를 쓸 수 있는지 (바닐라·알 수 없는 로더면 false) */
  supported: boolean;
  reason?: string;
  loader?: string;
  mcVersion?: string;
  hits: ModrinthHit[];
  total: number;
}

export interface ModrinthInstallResult {
  installed: { title: string; file: string; version: string; dependency: boolean }[];
  skipped: { title: string; reason: string }[];
}

export interface ModUpdate {
  file: string;
  projectId: string;
  title: string;
  current: string;
  latest: string;
  latestVersionId: string;
}
