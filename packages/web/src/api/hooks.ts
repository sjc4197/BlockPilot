import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RegisteredServer,
  ServerSummary,
  PropertiesResponse,
  UpdatePropertiesResult,
  PlayerListKind,
  AddPlayerInput,
  ModInfo,
  ProcessStatus,
  MojangProfile,
  ConfigFileEntry,
  ConfigFileContent,
  ConfigValidationResult,
  LogFileEntry,
  LogFileContent,
  BackupEntry,
  BackupStatus,
  BackupSettings,
  AuthInfo,
  AutostartInfo,
  P2pHostInfo,
  P2pJoinInfo,
  CreateLoader,
  CreateOptions,
  CreateRelease,
  CreateVersionInfo,
  CreateServerInput,
  CreateJobStatus,
  FsListing,
  DeleteServerResult,
  SystemInfo,
  AutomationView,
  AutomationUpdate,
  NetworkInfo,
  PublicIpResult,
  ReachabilityResult,
  PerfInfo,
  StatsResponse,
  ModrinthSearchResult,
  ModrinthInstallResult,
  ModUpdate,
  ModpackSearchResult,
  ModpackVersionEntry,
  ModpackInspectInput,
  ModpackInspectResult,
} from "@blockpilot/shared";
import { api } from "./client";

export const keys = {
  auth: ["auth"] as const,
  servers: ["servers"] as const,
  server: (id: string) => ["server", id] as const,
  properties: (id: string) => ["server", id, "properties"] as const,
  players: (id: string, kind: PlayerListKind) => ["server", id, "players", kind] as const,
  mods: (id: string) => ["server", id, "mods"] as const,
  process: (id: string) => ["server", id, "process"] as const,
  configs: (id: string) => ["server", id, "configs"] as const,
  configFile: (id: string, path: string) => ["server", id, "configs", path] as const,
  logs: (id: string) => ["server", id, "logs"] as const,
  logFile: (id: string, kind: string, name: string) => ["server", id, "logs", kind, name] as const,
  backups: (id: string) => ["server", id, "backups"] as const,
  automation: (id: string) => ["server", id, "automation"] as const,
};

// ---------- 인증 ----------

export const useAuthInfo = () => useQuery({ queryKey: keys.auth, queryFn: () => api<AuthInfo>("/api/auth"), staleTime: Infinity });

// ---------- 서버 ----------

export const useServers = () => useQuery({ queryKey: keys.servers, queryFn: () => api<RegisteredServer[]>("/api/servers") });

export const useServer = (id: string) =>
  useQuery({
    queryKey: keys.server(id),
    queryFn: () => api<ServerSummary>(`/api/servers/${id}`),
    refetchInterval: 5000,
  });

export function useRegisterServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; name?: string }) => api<RegisteredServer>("/api/servers", { method: "POST", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.servers }),
  });
}

export function useRemoveServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/servers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.servers }),
  });
}

// ---------- server.properties ----------

export const useProperties = (id: string) =>
  useQuery({ queryKey: keys.properties(id), queryFn: () => api<PropertiesResponse>(`/api/servers/${id}/properties`) });

export function useUpdateProperties(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changes: Record<string, string>) =>
      api<UpdatePropertiesResult>(`/api/servers/${id}/properties`, { method: "PUT", json: { changes } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.properties(id) });
      qc.invalidateQueries({ queryKey: keys.server(id) });
    },
  });
}

// ---------- 플레이어 ----------

export const usePlayerList = <T,>(id: string, kind: PlayerListKind) =>
  useQuery({ queryKey: keys.players(id, kind), queryFn: () => api<T[]>(`/api/servers/${id}/players/${kind}`) });

export function useAddPlayer(id: string, kind: PlayerListKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddPlayerInput) =>
      api<{ applied: "live" | "file"; profile?: MojangProfile }>(`/api/servers/${id}/players/${kind}`, { method: "POST", json: input }),
    // 실행 중이면 서버가 파일을 쓰는 데 약간 걸리므로 잠시 뒤 다시 읽는다
    onSuccess: (r) => setTimeout(() => qc.invalidateQueries({ queryKey: keys.players(id, kind) }), r.applied === "live" ? 800 : 0),
  });
}

export function useRemovePlayer(id: string, kind: PlayerListKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api<{ applied: string }>(`/api/servers/${id}/players/${kind}/${encodeURIComponent(key)}`, { method: "DELETE" }),
    onSuccess: (r) => setTimeout(() => qc.invalidateQueries({ queryKey: keys.players(id, kind) }), r.applied === "live" ? 800 : 0),
  });
}

export const lookupMojang = (name: string) => api<MojangProfile>(`/api/mojang/profile?name=${encodeURIComponent(name)}`);

// ---------- 모드 ----------

export const useMods = (id: string) => useQuery({ queryKey: keys.mods(id), queryFn: () => api<ModInfo[]>(`/api/servers/${id}/mods`) });

export function useToggleMod(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, enabled }: { file: string; enabled: boolean }) =>
      api(`/api/servers/${id}/mods/${encodeURIComponent(file)}`, { method: "PATCH", json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.mods(id) }),
  });
}

export function useDeleteMod(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: string) => api(`/api/servers/${id}/mods/${encodeURIComponent(file)}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mods(id) });
      qc.invalidateQueries({ queryKey: keys.server(id) });
    },
  });
}

export function useUploadMods(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f, f.name);
      return api<{ saved: string[] }>(`/api/servers/${id}/mods`, { method: "POST", body: fd });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mods(id) });
      qc.invalidateQueries({ queryKey: keys.server(id) });
    },
  });
}

// ---------- 프로세스 ----------

export function useProcessAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => api<ProcessStatus>(`/api/servers/${id}/process/${action}`, { method: "POST" }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.server(id) });
      qc.invalidateQueries({ queryKey: keys.process(id) });
    },
  });
}

export function useSendCommand(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (command: string) => api(`/api/servers/${id}/process/command`, { method: "POST", json: { command } }),
    onSettled: () => setTimeout(() => qc.invalidateQueries({ queryKey: keys.server(id) }), 800),
  });
}

// ---------- 설정 파일 ----------

export const useConfigFiles = (id: string) => useQuery({ queryKey: keys.configs(id), queryFn: () => api<ConfigFileEntry[]>(`/api/servers/${id}/configs`) });

export const useConfigFile = (id: string, path: string | null) =>
  useQuery({
    queryKey: keys.configFile(id, path ?? ""),
    queryFn: () => api<ConfigFileContent>(`/api/servers/${id}/configs/file?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
  });

export function useSaveConfigFile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; content: string }) => api<ConfigFileContent>(`/api/servers/${id}/configs/file`, { method: "PUT", json: input }),
    onSuccess: (data) => {
      qc.setQueryData(keys.configFile(id, data.path), data);
      qc.invalidateQueries({ queryKey: keys.configs(id) });
    },
  });
}

export const validateConfig = (id: string, input: { path: string; content: string }) =>
  api<ConfigValidationResult>(`/api/servers/${id}/configs/validate`, { method: "POST", json: input });

// ---------- 로그 ----------

export const useLogs = (id: string) => useQuery({ queryKey: keys.logs(id), queryFn: () => api<LogFileEntry[]>(`/api/servers/${id}/logs`) });

export const useLogFile = (id: string, kind: string | null, name: string | null, tail = 2000) =>
  useQuery({
    queryKey: [...keys.logFile(id, kind ?? "", name ?? ""), tail],
    queryFn: () => api<LogFileContent>(`/api/servers/${id}/logs/${kind}/${encodeURIComponent(name!)}?tail=${tail}`),
    enabled: !!kind && !!name,
    refetchInterval: name === "latest.log" ? 5000 : false,
  });

// ---------- 백업 ----------

export interface BackupsResponse {
  backups: BackupEntry[];
  status: BackupStatus;
  worlds: string[];
}

export const useBackups = (id: string) =>
  useQuery({ queryKey: keys.backups(id), queryFn: () => api<BackupsResponse>(`/api/servers/${id}/backups`), refetchInterval: 15000 });

export function useCreateBackup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label?: string) => api<BackupEntry>(`/api/servers/${id}/backups`, { method: "POST", json: { label } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.backups(id) }),
  });
}

export function useDeleteBackup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: string) => api(`/api/servers/${id}/backups/${encodeURIComponent(file)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.backups(id) }),
  });
}

export function useRestoreBackup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: string) => api<{ restored: string[]; previousMovedTo: string }>(`/api/servers/${id}/backups/${encodeURIComponent(file)}/restore`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.server(id) }),
  });
}

export function useSaveBackupSettings(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: BackupSettings) => api<BackupStatus>(`/api/servers/${id}/backups/settings`, { method: "PUT", json: settings }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.backups(id) }),
  });
}

// ---------- 새 서버 만들기 ----------

export const useCreateOptions = () => useQuery({ queryKey: ["create", "options"], queryFn: () => api<CreateOptions>("/api/create/options"), staleTime: 60_000 });

/** 서버 종류(로더)별 Minecraft 정식 버전 목록 */
export const useCreateReleases = (loader: CreateLoader) =>
  useQuery({ queryKey: ["create", "releases", loader], queryFn: () => api<CreateRelease[]>(`/api/create/releases?loader=${loader}`), staleTime: 60_000 });

export const useVersionInfo = (mc: string | undefined, loader: CreateLoader) =>
  useQuery({
    queryKey: ["create", "version", loader, mc],
    queryFn: () => api<CreateVersionInfo>(`/api/create/version-info?mc=${encodeURIComponent(mc!)}&loader=${loader}`),
    enabled: !!mc,
    staleTime: 60_000,
  });

/** nearest: 아직 없는 경로면 있는 상위 폴더를 연다 (처음 열 때) */
export const useFsList = (path: string | null, nearest = false) =>
  useQuery({
    queryKey: ["fs", path, nearest],
    queryFn: () => api<FsListing>(`/api/fs/list?${new URLSearchParams({ ...(path ? { path } : {}), ...(nearest ? { nearest: "1" } : {}) })}`),
    retry: false,
  });

/** BlockPilot 이 돌고 있는 컴퓨터 (OS 는 자동 인식, 바뀌지 않으므로 한 번만 받음) */
export const useSystem = () => useQuery({ queryKey: ["system"], queryFn: () => api<SystemInfo>("/api/system"), staleTime: Infinity });

export function useStartCreate() {
  return useMutation({ mutationFn: (input: CreateServerInput) => api<{ jobId: string }>("/api/create", { method: "POST", json: input }) });
}

export const useCreateJob = (id: string | null) =>
  useQuery({
    queryKey: ["create", "job", id],
    queryFn: () => api<CreateJobStatus>(`/api/create/jobs/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && q.state.data.state !== "running" ? false : 1000),
  });

export function useCancelCreate() {
  return useMutation({ mutationFn: (id: string) => api<{ cancelled: boolean }>(`/api/create/jobs/${id}/cancel`, { method: "POST" }) });
}

// ---------- 서버 삭제 (폴더째) ----------

export function useDeleteServer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirmName: string) => api<DeleteServerResult>(`/api/servers/${id}/delete`, { method: "POST", json: { confirmName } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.servers });
      qc.removeQueries({ queryKey: keys.server(id) });
    },
  });
}

// ---------- 알림·자동화 ----------

export const useAutomation = (id: string) =>
  useQuery({ queryKey: keys.automation(id), queryFn: () => api<AutomationView>(`/api/servers/${id}/automation`), refetchInterval: 10_000 });

export function useUpdateAutomation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (u: AutomationUpdate) => api<AutomationView>(`/api/servers/${id}/automation`, { method: "PUT", json: u }),
    onSuccess: (v) => qc.setQueryData(keys.automation(id), v),
  });
}

export function useDiscordTest(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/servers/${id}/automation/discord/test`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.automation(id) }),
  });
}

export function useSkipScheduledRestart(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skip: boolean) => api<AutomationView>(`/api/servers/${id}/automation/scheduled-restart/skip`, { method: "POST", json: { skip } }),
    onSuccess: (v) => qc.setQueryData(keys.automation(id), v),
  });
}

// ---------- 친구 접속 도우미 ----------

export const useNetwork = (id: string) => useQuery({ queryKey: ["server", id, "network"], queryFn: () => api<NetworkInfo>(`/api/servers/${id}/network`), staleTime: 60_000 });

/** 버튼을 눌렀을 때만 외부 서비스(ipify)에 묻는다 */
export const usePublicIp = () => useMutation({ mutationFn: () => api<PublicIpResult>("/api/network/public-ip", { method: "POST" }) });

/** 버튼을 눌렀을 때만 외부 서비스(mcsrvstat.us)가 밖에서 접속해 본다 */
export const useReachCheck = (id: string) => useMutation({ mutationFn: (ip: string) => api<ReachabilityResult>(`/api/servers/${id}/network/check`, { method: "POST", json: { ip } }) });

/** 대시보드를 보는 동안만 5초마다 (서버도 조회가 있을 때만 측정한다) */
export const usePerf = (id: string) => useQuery({ queryKey: ["server", id, "perf"], queryFn: () => api<PerfInfo>(`/api/servers/${id}/perf`), refetchInterval: 5000 });

export const useStats = (id: string) => useQuery({ queryKey: ["server", id, "stats"], queryFn: () => api<StatsResponse>(`/api/servers/${id}/stats`), refetchInterval: 60_000 });

// ---------- Modrinth ----------

export const useModrinthSearch = (id: string, q: string, enabled: boolean) =>
  useQuery({ queryKey: ["server", id, "modrinth", "search", q], queryFn: () => api<ModrinthSearchResult>(`/api/servers/${id}/modrinth/search?q=${encodeURIComponent(q)}`), enabled, staleTime: 5 * 60_000 });

export const useModUpdates = (id: string) => useQuery({ queryKey: ["server", id, "modrinth", "updates"], queryFn: () => api<ModUpdate[]>(`/api/servers/${id}/modrinth/updates`), staleTime: 10 * 60_000, retry: false });

export function useModrinthInstall(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: string; allowClientOnly?: boolean }) => api<ModrinthInstallResult>(`/api/servers/${id}/modrinth/install`, { method: "POST", json: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mods(id) });
      qc.invalidateQueries({ queryKey: ["server", id, "modrinth"] });
      qc.invalidateQueries({ queryKey: keys.server(id) });
    },
  });
}

export function useApplyModUpdates(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: string[]) => api<{ updated: { file: string; to: string }[]; backupDir: string }>(`/api/servers/${id}/modrinth/update`, { method: "POST", json: { files } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mods(id) });
      qc.invalidateQueries({ queryKey: ["server", id, "modrinth"] });
    },
  });
}

// ---------- 업데이트 확인 (누를 때만 GitHub 에 묻는다) ----------

export interface UpdateCheck {
  current: string;
  latest?: string;
  newer: boolean;
  url: string;
  note?: string;
}
/**
 * 포트포워딩 없는 친구 초대 (P2P) — 호스트 쪽. 켜져 있을 때만 2초마다 승인 대기·접속자를 갱신하고,
 * 꺼져 있으면 60초 (토글은 응답으로 캐시를 바로 바꾸므로 켜는 즉시 2초 주기로 넘어간다)
 */
export const useP2pHost = (id: string) =>
  useQuery({
    queryKey: ["server", id, "p2p"],
    queryFn: () => api<P2pHostInfo>(`/api/servers/${id}/p2p`),
    refetchInterval: (q) => (q.state.data?.enabled ? 2000 : 60_000),
  });
export function useP2pHostUpdate(id: string) {
  const qc = useQueryClient();
  const set = (info: P2pHostInfo) => qc.setQueryData(["server", id, "p2p"], info);
  return {
    setEnabled: useMutation({ mutationFn: (enabled: boolean) => api<P2pHostInfo>(`/api/servers/${id}/p2p`, { method: "PUT", json: { enabled } }), onSuccess: set }),
    rotate: useMutation({ mutationFn: () => api<P2pHostInfo>(`/api/servers/${id}/p2p/invite/rotate`, { method: "POST" }), onSuccess: set }),
    peer: useMutation({
      mutationFn: ({ key, action, name }: { key: string; action: "approve" | "reject" | "block" | "unblock" | "kick" | "forget"; name?: string }) =>
        api<P2pHostInfo>(`/api/servers/${id}/p2p/peers/${key}/${action}`, { method: "POST", json: name ? { name } : {} }),
      onSuccess: set,
    }),
  };
}

/** 이 컴퓨터에서 P2P 초대를 쓸 수 있는지 (네이티브 모듈) */
export const useP2pSupport = () => useQuery({ queryKey: ["p2p", "support"], queryFn: () => api<{ supported: boolean; reason?: string }>("/api/p2p/support"), staleTime: Infinity });

/** 친구 서버에 접속 (참가 모드). 연결 중·대기 중엔 1초, 아니면 5초마다 */
export const useP2pJoin = () =>
  useQuery({
    queryKey: ["join"],
    queryFn: () => api<P2pJoinInfo>("/api/join"),
    refetchInterval: (q) => (q.state.data && (q.state.data.state === "connecting" || q.state.data.state === "pending") ? 1000 : 5000),
  });
export function useP2pJoinActions() {
  const qc = useQueryClient();
  const set = (info: P2pJoinInfo) => qc.setQueryData(["join"], info);
  return {
    start: useMutation({ mutationFn: (input: { inviteCode: string; name?: string }) => api<P2pJoinInfo>("/api/join", { method: "POST", json: input }), onSuccess: set }),
    stop: useMutation({ mutationFn: () => api<P2pJoinInfo>("/api/join/stop", { method: "POST" }), onSuccess: set }),
    forget: useMutation({ mutationFn: () => api<P2pJoinInfo>("/api/join/remembered", { method: "DELETE" }), onSuccess: set }),
  };
}

/** 로그인 때 BlockPilot 자동 실행 (이 컴퓨터의 로그인 항목) */
export const useAutostart = () => useQuery({ queryKey: ["autostart"], queryFn: () => api<AutostartInfo>("/api/autostart"), staleTime: 60_000 });
export function useSetAutostart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api<AutostartInfo>("/api/autostart", { method: "PUT", json: { enabled } }),
    onSuccess: (info) => qc.setQueryData(["autostart"], info),
  });
}

export const useUpdateCheck = () => useMutation({ mutationFn: () => api<UpdateCheck>("/api/update-check", { method: "POST" }) });

// ---------- 지난번 BlockPilot 이 띄우고 남은 서버 (orphan) ----------

/** "안전하게 끄기"(stop) 또는 "그냥 두기"(ignore: 이제부터 외부 실행 중으로 본다) */
export function useOrphanAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "stop" | "ignore") => api<ProcessStatus>(`/api/servers/${id}/process/orphan/${action}`, { method: "POST" }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.server(id) });
      qc.invalidateQueries({ queryKey: keys.process(id) });
    },
  });
}

// ---------- 문제 신고 파일 ----------

export interface DebugBundleResult {
  fileName: string;
  sizeBytes: number;
  /** GET 으로 내려받는 경로. <a href> 로 열어야 하니 withToken() 을 붙인다 */
  downloadPath: string;
}
/** 로그·설정·서버 정보를 비밀은 가린 채 zip 하나로 모은다 (깃허브 이슈 첨부용) */
export const useDebugBundle = () => useMutation({ mutationFn: () => api<DebugBundleResult>("/api/debug/bundle", { method: "POST" }) });

// ---------- EULA 동의 ----------

/** eula.txt 에 eula=true 를 쓴다. 서버가 명시적 동의(accepted: true)만 받으니 본문은 고정 */
export function useAcceptEula(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/servers/${id}/eula`, { method: "POST", json: { accepted: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.server(id) }),
  });
}

// ---------- 모드팩 (.mrpack) ----------

/** Modrinth 모드팩 검색. 빈 검색어면 인기순. 서버가 한 번에 20개씩 주므로 "더 보기" 는 다음 쪽(offset)을 받아 온다 */
export const MODPACK_SEARCH_PAGE = 20;
export const useModpackSearch = (q: string, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: ["create", "modpack", "search", q],
    queryFn: ({ pageParam }) => api<ModpackSearchResult>(`/api/create/modpack/search?${new URLSearchParams({ q, offset: String(pageParam) })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.length * MODPACK_SEARCH_PAGE;
      return last.hits.length >= MODPACK_SEARCH_PAGE && loaded < last.total ? loaded : undefined;
    },
    enabled,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

export const useModpackVersions = (projectId: string | null) =>
  useQuery({
    queryKey: ["create", "modpack", "versions", projectId],
    queryFn: () => api<ModpackVersionEntry[]>(`/api/create/modpack/versions?project=${encodeURIComponent(projectId!)}`),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
  });

/** 서버가 Modrinth 에서 팩을 받아 검사한다 (큰 팩은 수십 초) */
export const useInspectModpack = () =>
  useMutation({ mutationFn: (input: ModpackInspectInput) => api<ModpackInspectResult>("/api/create/modpack/inspect", { method: "POST", json: input }) });

/** .mrpack(.zip) 파일을 올려 검사한다 */
export const useUploadModpack = () =>
  useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      return api<ModpackInspectResult>("/api/create/modpack/upload", { method: "POST", body: fd });
    },
  });
