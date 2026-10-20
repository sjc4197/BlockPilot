import { getServer } from "../config/store.js";
import { getManaged, type ManagedServer } from "../services/process.js";
import type { RegisteredServer } from "@blockpilot/shared";

export interface ServerContext {
  server: RegisteredServer;
  dir: string;
  managed: ManagedServer;
}

/** 라우트에서 :id 를 받아 서버 경로와 프로세스 매니저를 한 번에 가져온다 */
export async function loadContext(id: string): Promise<ServerContext> {
  const server = await getServer(id);
  return { server, dir: server.path, managed: getManaged(server.id, server.path) };
}
