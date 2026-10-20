import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "@blockpilot/shared";
import { api } from "./client";

export const keys = {
  servers: ["servers"] as const,
  server: (id: string) => ["server", id] as const,
  properties: (id: string) => ["server", id, "properties"] as const,
  players: (id: string, kind: PlayerListKind) => ["server", id, "players", kind] as const,
  mods: (id: string) => ["server", id, "mods"] as const,
  process: (id: string) => ["server", id, "process"] as const,
};

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
