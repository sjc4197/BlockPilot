import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import type { ProcessStatus } from "@blockpilot/shared";
import { useProcessAction } from "../api/hooks";
import { ConfirmButton, useToast } from "../lib/ui";
import { Lever, type LeverVisual } from "./Lever";

/**
 * 서버 전원 레버 + 재시작. 상단바와 대시보드에서 공용.
 * - 꺼져 있을 때: 한 번 당기면 시작
 * - 켜져 있을 때: 한 번 당기면 레버가 흔들리며 확인, 3초 안에 한 번 더 당기면 중지
 */
export function ProcessControls({ serverId, status, size = "md" }: { serverId: string; status: ProcessStatus; size?: "sm" | "md" | "lg" }) {
  const action = useProcessAction(serverId);
  const toast = useToast();
  const [armed, setArmed] = useState(false);
  // 요청을 보낸 직후 서버 상태가 갱신되기 전까지 레버를 먼저 넘겨 두기 위한 값
  const [intent, setIntent] = useState<"on" | "off" | null>(null);
  const { state, rcon } = status;

  useEffect(() => {
    setIntent(null);
    setArmed(false);
  }, [state]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  const visual: LeverVisual =
    intent === "on" && state === "stopped" ? "starting"
    : intent === "off" && state !== "stopped" ? "stopping"
    : state === "starting" ? "starting"
    : state === "stopping" ? "stopping"
    : state === "stopped" ? "off"
    : "on";

  const externalLocked = state === "external" && rcon !== "connected";
  const busy = action.isPending || visual === "starting" || visual === "stopping";

  const run = (a: "start" | "stop" | "restart") =>
    action.mutate(a, {
      onSuccess: () => toast("ok", a === "start" ? "서버를 시작합니다." : a === "stop" ? "서버를 중지했습니다." : "서버를 재시작합니다."),
      onError: (e) => {
        setIntent(null);
        toast("err", (e as Error).message);
      },
    });

  const pull = () => {
    if (busy || externalLocked) return;
    if (visual === "off") {
      setIntent("on");
      run("start");
    } else if (!armed) {
      setArmed(true);
    } else {
      setArmed(false);
      setIntent("off");
      run("stop");
    }
  };

  const label = armed
    ? "한 번 더 당기면 꺼져요"
    : visual === "off" ? "꺼짐"
    : visual === "starting" ? "켜는 중…"
    : visual === "stopping" ? "끄는 중…"
    : state === "external" ? "외부 실행 중"
    : "켜짐";
  const title = externalLocked
    ? "BlockPilot 밖에서 실행 중이에요. RCON을 켜야 여기서 끌 수 있어요."
    : visual === "off" ? "레버를 당겨 서버 시작"
    : visual === "on" ? "레버를 두 번 당기면 서버 중지"
    : label;

  return (
    <div className="flex items-center gap-2">
      <Lever
        visual={visual}
        armed={armed}
        disabled={externalLocked}
        busy={busy}
        size={size === "lg" ? "lg" : "sm"}
        label={label}
        hint={visual === "off" ? "당겨서 시작" : visual === "on" && !armed ? "두 번 당기면 중지" : undefined}
        title={title}
        onClick={pull}
      />
      {state === "running" && !armed && (
        <ConfirmButton size={size === "lg" ? "md" : "sm"} variant="ghost" icon={RotateCw} label="재시작" confirmLabel="정말 재시작?" disabled={busy} onConfirm={() => run("restart")} />
      )}
    </div>
  );
}
