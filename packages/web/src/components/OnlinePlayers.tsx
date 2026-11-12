import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import type { OpEntry, WhitelistEntry } from "@blockpilot/shared";
import { keys, usePlayerList, useSendCommand } from "../api/hooks";
import { Avatar, Badge, Button, ConfirmButton, Divider, cx, useToast } from "../lib/ui";

const GAMEMODES: { id: string; label: string }[] = [
  { id: "survival", label: "서바이벌" },
  { id: "creative", label: "크리에이티브" },
  { id: "spectator", label: "관전" },
];

/**
 * 대시보드 "접속 중인 플레이어" 목록. 킥·밴은 그대로 두고, ⋯ 를 누르면 줄 아래에 OP·화이트리스트·게임모드 액션이 펼쳐진다.
 * 모든 액션은 콘솔 명령으로 보낸다 (OP·화이트리스트는 보낸 뒤 목록을 다시 읽어 상태를 맞춘다).
 */
export function OnlinePlayers({ serverId, players, canCommand }: { serverId: string; players: string[]; canCommand: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const sendCmd = useSendCommand(serverId);
  const { data: ops } = usePlayerList<OpEntry>(serverId, "ops");
  const { data: whitelist } = usePlayerList<WhitelistEntry>(serverId, "whitelist");
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const isOp = (p: string) => !!ops?.some((e) => e.name.toLowerCase() === p.toLowerCase());
  const isWhitelisted = (p: string) => !!whitelist?.some((e) => e.name.toLowerCase() === p.toLowerCase());

  /** 명령을 보내고 결과를 토스트로. refresh 에 적은 목록은 서버가 파일을 다시 쓴 뒤(잠시 후) 다시 읽는다 */
  const run = (key: string, command: string, okMsg: string, refresh?: "ops" | "whitelist") => {
    setPending(key);
    sendCmd.mutate(command, {
      onSuccess: () => {
        toast("ok", okMsg);
        if (refresh) setTimeout(() => qc.invalidateQueries({ queryKey: keys.players(serverId, refresh) }), 800);
      },
      onError: (e) => toast("err", (e as Error).message),
      onSettled: () => setPending(null),
    });
  };

  return (
    <ul className="mt-3 space-y-1.5">
      {players.map((p) => {
        const expanded = open === p;
        const op = isOp(p);
        const stripId = `player-actions-${p}`;
        return (
          <li key={p} className="well px-3 py-2">
            <div className="flex h-7 items-center gap-3">
              <Avatar id={p} size={28} />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-sm font-medium">{p}</span>
                {op && <Badge tone="lamp">OP</Badge>}
              </span>
              {canCommand && (
                <div className="flex shrink-0 gap-1">
                  <ConfirmButton size="sm" variant="ghost" label="킥" confirmLabel="킥?" onConfirm={() => run(`kick:${p}`, `kick ${p}`, `${p} 추방`)} />
                  <ConfirmButton size="sm" variant="ghost" label="밴" confirmLabel="밴?" className="text-red-300" onConfirm={() => run(`ban:${p}`, `ban ${p}`, `${p} 밴`)} />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={MoreHorizontal}
                    aria-label={`${p} 더 많은 액션`}
                    aria-expanded={expanded}
                    aria-controls={stripId}
                    className={cx("px-1.5", expanded && "bg-ink-3 text-white")}
                    onClick={() => setOpen(expanded ? null : p)}
                  />
                </div>
              )}
            </div>
            {canCommand && expanded && (
              <div id={stripId} className="mt-2">
                <Divider className="mb-2" />
                <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="outline" loading={pending === `op:${p}`} disabled={!!pending} onClick={() => (op ? run(`op:${p}`, `deop ${p}`, `${p} 의 OP 를 해제했어요`, "ops") : run(`op:${p}`, `op ${p}`, `${p} 에게 OP 를 줬어요`, "ops"))}>
                  {op ? "OP 해제" : "OP 주기"}
                </Button>
                {!isWhitelisted(p) && (
                  <Button size="sm" variant="outline" loading={pending === `wl:${p}`} disabled={!!pending} onClick={() => run(`wl:${p}`, `whitelist add ${p}`, `${p} 을(를) 화이트리스트에 추가했어요`, "whitelist")}>
                    화이트리스트에 추가
                  </Button>
                )}
                {/* 라벨과 버튼 세 개를 한 덩어리로 묶어 줄이 바뀌어도 같이 내려가게 */}
                <span className="inline-flex items-center gap-1" role="group" aria-label={`${p} 게임모드`}>
                  <span className="ml-1 font-block text-[11px] text-slate-500">게임모드</span>
                  {GAMEMODES.map((g) => (
                    <Button key={g.id} size="sm" variant="ghost" className="px-2" loading={pending === `gm:${g.id}:${p}`} disabled={!!pending} aria-label={`${p} 게임모드를 ${g.label}로`} onClick={() => run(`gm:${g.id}:${p}`, `gamemode ${g.id} ${p}`, `${p} 게임모드 → ${g.label}`)}>
                      {g.label}
                    </Button>
                  ))}
                </span>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
