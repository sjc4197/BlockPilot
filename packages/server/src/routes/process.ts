import type { FastifyInstance } from "fastify";
import type { ConsoleLine, ConsoleServerMessage, ConsoleClientMessage, ProcessStatus } from "@blockpilot/shared";
import { loadContext } from "../lib/context.js";

export async function processRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/process", async (req): Promise<ProcessStatus> => {
    const { id } = req.params as { id: string };
    const { managed } = await loadContext(id);
    return managed.status();
  });

  app.post("/api/servers/:id/process/start", async (req) => {
    const { id } = req.params as { id: string };
    const { managed } = await loadContext(id);
    await managed.start();
    return managed.status();
  });

  app.post("/api/servers/:id/process/stop", async (req) => {
    const { id } = req.params as { id: string };
    const { managed } = await loadContext(id);
    await managed.stop();
    return managed.status();
  });

  app.post("/api/servers/:id/process/restart", async (req) => {
    const { id } = req.params as { id: string };
    const { managed } = await loadContext(id);
    await managed.restart();
    return managed.status();
  });

  app.post("/api/servers/:id/process/command", async (req) => {
    const { id } = req.params as { id: string };
    const { command } = (req.body ?? {}) as { command?: string };
    const { managed } = await loadContext(id);
    await managed.sendCommand(String(command ?? ""));
    return { ok: true };
  });

  // 콘솔 스트림: 접속 시 히스토리 + 현재 상태, 이후 줄 단위 push, 클라이언트는 명령어 전송
  app.get("/api/servers/:id/console", { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    let managed;
    try {
      ({ managed } = await loadContext(id));
    } catch {
      socket.close(4004, "unknown server");
      return;
    }
    const send = (msg: ConsoleServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    send({ type: "history", lines: managed.getHistory() });
    send({ type: "status", status: await managed.status() });

    const onLine = (line: ConsoleLine) => send({ type: "line", line });
    const onStatus = (status: ProcessStatus) => send({ type: "status", status });
    managed.on("line", onLine);
    managed.on("status", onStatus);

    socket.on("message", async (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(String(raw)) as ConsoleClientMessage;
        if (msg.type === "command") await managed.sendCommand(msg.command);
      } catch (e: any) {
        send({ type: "line", line: { ts: Date.now(), source: "system", text: `오류: ${e?.message ?? e}` } });
      }
    });
    socket.on("close", () => {
      managed.off("line", onLine);
      managed.off("status", onStatus);
    });
  });
}
