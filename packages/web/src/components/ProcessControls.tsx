import { Play, RotateCw, Square } from "lucide-react";
import type { ProcessStatus } from "@blockpilot/shared";
import { useProcessAction } from "../api/hooks";
import { Button, ConfirmButton, useToast } from "../lib/ui";

/** 시작 / 중지 / 재시작 버튼 묶음. 상단바와 대시보드에서 공용. */
export function ProcessControls({ serverId, status, size = "md" }: { serverId: string; status: ProcessStatus; size?: "sm" | "md" | "lg" }) {
  const action = useProcessAction(serverId);
  const toast = useToast();
  const { state, rcon } = status;
  const busy = action.isPending || state === "starting" || state === "stopping";

  const run = (a: "start" | "stop" | "restart") =>
    action.mutate(a, {
      onSuccess: () => toast("ok", a === "start" ? "서버를 시작합니다." : a === "stop" ? "서버를 중지했습니다." : "서버를 재시작합니다."),
      onError: (e) => toast("err", (e as Error).message),
    });

  if (state === "stopped") {
    return (
      <Button variant="primary" size={size} icon={Play} loading={action.isPending} onClick={() => run("start")}>
        시작
      </Button>
    );
  }
  if (state === "external") {
    if (rcon !== "connected") return null;
    return <ConfirmButton size={size} icon={Square} label="중지 (RCON)" confirmLabel="정말 중지?" disabled={busy} onConfirm={() => run("stop")} />;
  }
  return (
    <div className="flex items-center gap-1.5">
      <ConfirmButton size={size} icon={Square} label="중지" confirmLabel="정말 중지?" disabled={busy} onConfirm={() => run("stop")} />
      <ConfirmButton size={size} icon={RotateCw} variant="ghost" label="재시작" confirmLabel="정말 재시작?" disabled={busy} onConfirm={() => run("restart")} />
    </div>
  );
}
