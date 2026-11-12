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

/** orphan: 지난번 BlockPilot 이 띄웠는데 BlockPilot 만 꺼져서 혼자 남은 서버 */
export const ProcessState = z.enum(["stopped", "starting", "running", "stopping", "external", "orphan"]);
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
  /** state 가 orphan 일 때: 지난번 BlockPilot 이 기록해 둔 프로세스 */
  orphan?: { pid: number; startedAt: string };
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
  /** 모드팩으로 만든 서버면 그 팩 (.blockpilot-modpack.json) */
  modpack?: { name: string; versionId: string; projectId?: string; modrinthVersionId?: string };
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

/** 새로 만들 수 있는 서버 종류. vanilla 는 로더 없이 Mojang server.jar 만 */
export const CreateLoader = z.enum(["vanilla", "fabric", "paper", "forge", "neoforge"]);
export type CreateLoader = z.infer<typeof CreateLoader>;

export const CREATE_LOADER_LABEL: Record<CreateLoader, string> = { vanilla: "순정", fabric: "Fabric", paper: "Paper", forge: "Forge", neoforge: "NeoForge" };

/**
 * 화면에 보여 줄 로더 버전. 값 자체는 설치기 경로에 그대로 쓰이므로 바꾸지 않고 표시만 다듬는다.
 * Forge "1.21.1-52.1.21" → "52.1.21" (Minecraft 칸에 이미 1.21.1 이 있음), Paper "133" → "빌드 133", 순정 "" → ""
 */
export function displayLoaderVersion(loader: CreateLoader, mc: string, version: string): string {
  if (!version) return "";
  const v = version.startsWith(`${mc}-`) ? version.slice(mc.length + 1) : version;
  return loader === "paper" ? `빌드 ${v}` : v;
}

export interface CreateLoaderInfo {
  id: CreateLoader;
  label: string;
  /** 한 줄 설명 (화면의 로더 고르기) */
  summary: string;
  /** 지원하는 가장 낮은 Minecraft 버전 (없으면 Mojang 정식 버전 전부) */
  minMc?: string;
  /** 로더 버전(또는 빌드)을 고르는 칸이 있는지. 순정은 없음 */
  hasVersions: boolean;
  /** 두 번째 선택 칸 이름: "Fabric 로더" / "Paper 빌드" / "Forge 버전" … */
  versionLabel: string;
}

// ---------- 모드팩 (.mrpack) ----------

/** 모드팩으로 만들 수 있는 로더. Paper·순정·Quilt 는 .mrpack 서버 설치 대상이 아니다 */
export const ModpackLoader = z.enum(["fabric", "forge", "neoforge"]);
export type ModpackLoader = z.infer<typeof ModpackLoader>;

/** modrinth.index.json (formatVersion 1). 모르는 키는 그대로 통과시킨다 (스펙: 새 키가 언제든 추가될 수 있음) */
export const MrpackEnvValue = z.enum(["required", "optional", "unsupported"]);
export const MrpackFile = z.object({
  path: z.string().min(1),
  hashes: z.object({ sha1: z.string().regex(/^[0-9a-f]{40}$/i), sha512: z.string().regex(/^[0-9a-f]{128}$/i) }).passthrough(),
  env: z.object({ client: MrpackEnvValue, server: MrpackEnvValue }).partial().optional(),
  downloads: z.array(z.string().url()).min(1),
  fileSize: z.number().int().nonnegative(),
});
export type MrpackFile = z.infer<typeof MrpackFile>;
export const MrpackIndex = z
  .object({
    formatVersion: z.literal(1),
    game: z.literal("minecraft"),
    versionId: z.string(),
    name: z.string().min(1),
    summary: z.string().optional(),
    files: z.array(MrpackFile).default([]),
    dependencies: z
      .object({
        minecraft: z.string().min(1),
        "fabric-loader": z.string().optional(),
        forge: z.string().optional(),
        neoforge: z.string().optional(),
        "quilt-loader": z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type MrpackIndex = z.infer<typeof MrpackIndex>;

/** 검사(inspect)·업로드 뒤 화면에 보여 주는 요약. loaderVersion 은 BlockPilot 표기 (Forge 는 "{mc}-{forge}") */
export interface ModpackSummary {
  name: string;
  summary?: string;
  versionId: string;
  mc: string;
  loader: ModpackLoader;
  loaderVersion: string;
  /** index.files 전체 수 */
  fileCount: number;
  /** env.server !== "unsupported" 인 파일 수 (실제로 받는 것) */
  serverFileCount: number;
  /** 받는 파일(fileSize 합) 바이트 */
  totalBytes: number;
  /** overrides/ + server-overrides/ 항목 수 */
  overrideCount: number;
  /** 팩 크기로 계산한 최대 메모리 추천값 (MB, 이 컴퓨터 메모리의 75% 로 자른 값) */
  suggestedMaxMb: number;
  /** 자르기 전 추천값 (MB) — 이 값이 suggestedMaxMb 보다 크면 메모리가 모자랄 수 있다 */
  idealMaxMb: number;
  /** 서버엔 필요 없어 받지 않는 파일 수 (클라이언트 전용 모드·리소스팩·셰이더 등) */
  clientOnlyCount: number;
  /** 서버에 꼭 필요한데 허용되지 않은 주소에만 있는 파일 수. 0 보다 크면 이 팩으로는 만들 수 없다 */
  blockedCount: number;
  /** 만들 수는 있지만 알아 둘 것 (꼭 없어도 되는 파일을 건너뜀, 팩 설정에서 뺀 위험한 값 등) */
  warnings: string[];
}

/** 검사 결과: 임시 보관 id + 요약. uploadId 는 1시간 뒤 만료 */
export interface ModpackInspectResult {
  uploadId: string;
  summary: ModpackSummary;
  /** 업로드한 파일 이름 또는 Modrinth 파일 이름 */
  fileName: string;
  expiresAt: string;
}

export const ModpackInspectInput = z.object({
  source: z.literal("modrinth"),
  projectId: z.string().regex(/^[\w-]{1,64}$/),
  versionId: z.string().regex(/^[\w-]{1,64}$/),
});
export type ModpackInspectInput = z.infer<typeof ModpackInspectInput>;

/** CreateServerInput.modpack — 어느 경로로 왔든 파이프라인은 uploadId 의 캐시 파일을 읽는다 */
export const CreateModpackRef = z.object({
  uploadId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  source: z.enum(["upload", "modrinth"]),
  projectId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  versionId: z.string().regex(/^[\w-]{1,64}$/).optional(),
});
export type CreateModpackRef = z.infer<typeof CreateModpackRef>;

/** Modrinth 모드팩 검색 (GET /api/create/modpack/search) */
export interface ModpackSearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  /** BlockPilot 이 지원하는 로더 중 이 팩이 쓰는 것 */
  loaders: ModpackLoader[];
  /** 지원 Minecraft 버전 (최신순, 최대 몇 개) */
  gameVersions: string[];
}
export interface ModpackSearchResult {
  hits: ModpackSearchHit[];
  total: number;
}
/** Modrinth 모드팩 버전 (GET /api/create/modpack/versions) */
export interface ModpackVersionEntry {
  id: string;
  name: string;
  versionNumber: string;
  versionType: "release" | "beta" | "alpha";
  loaders: ModpackLoader[];
  gameVersions: string[];
  datePublished: string;
  /** primary .mrpack 파일 */
  file: { filename: string; url: string; size: number; sha512: string };
}

/** 서버 폴더의 .blockpilot-modpack.json (만든 뒤 표시·내보내기용) */
export interface ModpackMarker {
  name: string;
  versionId: string;
  source: "upload" | "modrinth";
  projectId?: string;
  modrinthVersionId?: string;
  installedAt: string;
  serverFileCount: number;
  /** 받지 않은 파일과 이유 */
  skipped: { path: string; reason: string }[];
}

export const CreateServerInput = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(60),
  loader: CreateLoader,
  mcVersion: z.string().min(1),
  /** 로더 버전 (Paper 는 빌드 번호). 순정은 빈 문자열 */
  loaderVersion: z.string(),
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
  /** 모드팩으로 만들 때. loader/mcVersion/loaderVersion 은 검사 결과(ModpackSummary)의 값을 그대로 보낸다 — 파이프라인이 대조한다 */
  modpack: CreateModpackRef.optional(),
  /** 사용자가 직접 체크해야 한다. 자동으로 true 를 넣는 코드 경로는 없다 */
  eulaAccepted: z.literal(true, { errorMap: () => ({ message: "Minecraft EULA 에 동의해야 서버를 만들 수 있어요." }) }),
});
export type CreateServerInput = z.infer<typeof CreateServerInput>;

export type CreateStepId = "preflight" | "modpack-check" | "versions" | "java" | "server-jar" | "loader" | "modpack-install" | "config" | "first-run" | "register";
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
  input: { path: string; name: string; loader: CreateLoader; mcVersion: string; loaderVersion: string; modpack?: { name: string; versionId: string; source: "upload" | "modrinth" } };
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
  /** 만들 수 있는 서버 종류 (화면에 보여 줄 순서) */
  loaders: CreateLoaderInfo[];
  /** Fabric 이 지원하는 Mojang 정식 릴리스 (최신순). 다른 로더는 GET /api/create/releases?loader= */
  releases: CreateRelease[];
  defaults: { parentDir: string; memory: { minMb: number; maxMb: number } };
  /** BlockPilot 이 도중에 꺼져서 다음 시작 때 정리한 작업 */
  recovered: { target: string; cleaned: string[]; at: string }[];
  activeJobId?: string;
  /** 모드팩 업로드 상한 (바이트) — 화면에서 미리 막기 위해 */
  modpackUploadMaxBytes: number;
}

export interface CreateRelease {
  id: string;
  releaseTime: string;
}

export interface CreateLoaderVersion {
  version: string;
  /** 안정 빌드인지. 아니면 화면에 "(베타)" */
  stable: boolean;
}

export interface CreateVersionInfo {
  loader: CreateLoader;
  mcVersion: string;
  javaMajor: number;
  java: { source: "system" | "cached" | "download"; version?: string; downloadMb?: number };
  /** 받을 파일 크기 (MB): 순정·Fabric 은 server.jar, Paper 는 Paper jar, Forge·NeoForge 는 설치기 */
  downloadMb: number;
  /** 받는 것에 대한 짧은 설명 (예: "설치기가 라이브러리를 더 받아요") */
  downloadNote?: string;
  /** 로더 버전 목록 (최신순). 순정은 빈 배열 */
  loaders: CreateLoaderVersion[];
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
  /** server.properties 가 있어 마인크래프트 서버 폴더로 보이는지 */
  hasServerProperties: boolean;
  entries: { name: string; path: string; empty: boolean | null; isServer: boolean; hasServerProperties: boolean }[];
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
  /** BlockPilot 버전 */
  version: string;
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

// ---------- 로그인 때 자동 실행 ----------

export type AutostartMethod = "launchd" | "systemd" | "xdg" | "registry";

export interface AutostartInfo {
  /** 단일 실행 파일로 켰을 때만 등록할 수 있다 */
  supported: boolean;
  /** 지원하지 않는 이유 */
  reason?: string;
  method: AutostartMethod;
  /** 사람이 읽는 방식 이름 (예: "macOS 로그인 항목(launchd)") */
  methodLabel: string;
  enabled: boolean;
  /** 지금 실행 중인 실행 파일 */
  exePath?: string;
  /** 등록에 적힌 실행 파일 */
  registeredExe?: string;
  /** 등록된 실행 파일이 디스크에 없음 (옮겼거나 지움) */
  exeMissing?: boolean;
  /** 등록된 실행 파일이 지금 실행 중인 것과 다름 */
  stale?: boolean;
  /** 지금 프로세스가 자동 실행으로 켜진 것인지 */
  autostarted: boolean;
  /** OS 별 한 줄 안내 */
  hint?: string;
}

export const AutostartUpdate = z.object({ enabled: z.boolean() });
export type AutostartUpdate = z.infer<typeof AutostartUpdate>;

// ---------- 포트포워딩 없는 친구 초대 (P2P 터널) ----------

export interface P2pPeerView {
  publicKey: string;
  /** 화면용 앞 8자 */
  shortKey: string;
  state: "pending" | "connected";
  /** 상대 주소 (호스트에게만 보임) */
  remote?: string;
  since: string;
  /** 마크 클라이언트 연결 수 */
  connections: number;
  /** 승인할 때 붙인 이름 */
  name?: string;
}

export interface P2pApprovedPeer {
  publicKey: string;
  name?: string;
  approvedAt: string;
}

export interface P2pBlockedPeer {
  publicKey: string;
  name?: string;
  blockedAt: string;
}

export interface P2pHostInfo {
  /** 이 컴퓨터에서 P2P 를 쓸 수 있는지 (네이티브 모듈) */
  supported: boolean;
  reason?: string;
  /** 초대 켜짐 (서버가 켜져 있을 때 터널이 돈다) */
  enabled: boolean;
  state: "off" | "starting" | "listening" | "error";
  error?: string;
  /** 켜져 있을 때만 */
  inviteCode?: string;
  publicKey?: string;
  mcPort: number;
  maxPeers: number;
  peers: P2pPeerView[];
  approved: P2pApprovedPeer[];
  blocked: P2pBlockedPeer[];
  warnings: { serverStopped: boolean; whitelistOff: boolean; onlineModeOff: boolean };
  /** 최근 10분 인증 실패 수 */
  recentAuthFailures: number;
}

export const P2pHostUpdate = z.object({ enabled: z.boolean() });
export type P2pHostUpdate = z.infer<typeof P2pHostUpdate>;

export const P2pPeerKey = z.string().regex(/^[0-9a-f]{64}$/, "공개키 형식이 아니에요.");
export const P2pApproveInput = z.object({ name: z.string().trim().max(32).optional() });
export type P2pApproveInput = z.infer<typeof P2pApproveInput>;

export type P2pJoinState = "idle" | "connecting" | "pending" | "connected" | "failed";

/** 연결 실패 진단: 무슨 일 · 왜 · 해 볼 것 · 그래도 안 되면(대안 서비스, 안내만) */
export interface P2pDiagnosis {
  kind: "bad_code" | "host_off" | "rejected" | "timeout_approval" | "full" | "nat" | "network" | "version_mismatch" | "unknown";
  title: string;
  cause: string;
  hints: string[];
  alternatives: { label: string; url: string; note: string }[];
}

export interface P2pJoinInfo {
  supported: boolean;
  reason?: string;
  state: P2pJoinState;
  /** 상태 설명 (실패 원인, 접속 안내) */
  detail?: string;
  /** 연결됐을 때 마크 클라이언트가 접속할 로컬 포트 */
  localPort?: number;
  /** 지금 연결 중인 호스트 공개키 앞 8자 */
  hostShortKey?: string;
  since?: string;
  /** 실패했을 때 원인과 해 볼 것 */
  diagnosis?: P2pDiagnosis;
  /** 마지막으로 쓴 초대 (다시 접속용) */
  remembered?: { name?: string; hostShortKey: string; inviteCode: string; usedAt: string };
}

export const P2pJoinInput = z.object({
  inviteCode: z.string().trim().min(1, "초대코드를 입력해 주세요.").max(200),
  /** 이 초대에 붙일 이름 (예: "철수네 서버"). 비우면("") 지난 이름을 지우고, 보내지 않으면 같은 호스트의 지난 이름을 물려받는다 */
  name: z.string().trim().max(32).optional(),
});
export type P2pJoinInput = z.infer<typeof P2pJoinInput>;

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
export type ServerEventType = "started" | "stopped" | "crashed" | "auto-restart" | "auto-restart-failed" | "scheduled-restart" | "joined" | "left" | "backup" | "p2p_pending";

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

export const DISCORD_EVENTS = ["started", "stopped", "crashed", "restarted", "joined", "left", "backup", "p2p_pending"] as const;
export type DiscordEventKey = (typeof DISCORD_EVENTS)[number];
export const DISCORD_EVENT_LABEL: Record<DiscordEventKey, string> = {
  started: "서버 켜짐",
  stopped: "서버 꺼짐",
  crashed: "크래시",
  restarted: "자동·예약 재시작",
  joined: "입장",
  left: "퇴장",
  backup: "백업 완료",
  p2p_pending: "친구 접속 요청",
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
  /** 아무도 없으면 자동으로 끄기 */
  idleShutdown: z.object({
    enabled: z.boolean(),
    /** 접속자가 0명인 채로 이만큼 지나면 끈다 (분) */
    afterMinutes: z.number().int().min(5, "5분 이상으로 써 주세요.").max(720, "12시간(720분)까지만 돼요."),
  }),
});
export type AutomationSettings = z.infer<typeof AutomationSettings>;

export const DEFAULT_AUTOMATION: AutomationSettings = {
  discord: { webhookUrl: "", events: { started: true, stopped: true, crashed: true, restarted: true, joined: true, left: true, backup: false, p2p_pending: true } },
  autoRestart: { enabled: false, delaySeconds: 30 },
  scheduledRestart: { enabled: false, time: "05:00", days: [0, 1, 2, 3, 4, 5, 6], onlyWhenEmpty: true },
  idleShutdown: { enabled: false, afterMinutes: 30 },
};

/** 화면에 돌려주는 모양: 웹훅 주소 대신 설정 여부와 끝 네 글자만 */
export interface AutomationView {
  discord: { webhookSet: boolean; webhookHint?: string; events: AutomationSettings["discord"]["events"]; lastSentAt?: string; lastError?: string };
  autoRestart: AutomationSettings["autoRestart"] & { recentAttempts: number; gaveUp: boolean; pendingAt?: string };
  scheduledRestart: AutomationSettings["scheduledRestart"] & { nextAt?: string; skipNext: boolean };
  /** emptySince: 아무도 없어진 시각, willStopAt: 이대로면 꺼질 시각 (켜져 있고 비어 있을 때만) */
  /** warnedAt: "1분 뒤에 꺼요" 경고를 보낸 시각 (다음 틱에 접속자가 없으면 끈다) */
  idleShutdown: AutomationSettings["idleShutdown"] & { emptySince?: string; warnedAt?: string; willStopAt?: string };
  lastCrash?: CrashSummary;
}

/** 일부만 바꾸기. webhookUrl 은 "" 이면 지우고, 없으면 그대로 둔다 */
export const AutomationUpdate = z.object({
  discord: z.object({ webhookUrl: z.string().optional(), events: DiscordEvents.partial().optional() }).optional(),
  autoRestart: AutomationSettings.shape.autoRestart.partial().optional(),
  scheduledRestart: AutomationSettings.shape.scheduledRestart.partial().optional(),
  idleShutdown: AutomationSettings.shape.idleShutdown.partial().optional(),
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
