import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleLine, ConsoleServerMessage, ProcessStatus } from "@blockpilot/shared";
import { withToken } from "../api/client";

const MAX_LINES = 2000;

/** 콘솔 WebSocket. 끊기면 2초 후 재접속. */
export function useConsole(serverId: string) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [status, setStatus] = useState<ProcessStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(withToken(`${proto}://${location.host}/api/servers/${serverId}/console`));
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ConsoleServerMessage;
        if (msg.type === "history") setLines(msg.lines);
        else if (msg.type === "line") setLines((prev) => (prev.length >= MAX_LINES ? [...prev.slice(-MAX_LINES + 1), msg.line] : [...prev, msg.line]));
        else if (msg.type === "status") setStatus(msg.status);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [serverId]);

  const send = useCallback((command: string) => {
    wsRef.current?.send(JSON.stringify({ type: "command", command }));
  }, []);

  return { lines, status, connected, send };
}
