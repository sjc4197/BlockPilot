import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Ban, Check, Copy, Link2, RefreshCw, ShieldAlert, ShieldCheck, UserMinus, UserX, X } from "lucide-react";
import type { P2pHostInfo, ProcessState } from "@blockpilot/shared";
import { useP2pHost, useP2pHostUpdate, useSystem } from "../api/hooks";
import { Badge, Button, Callout, Card, ConfirmButton, HoldButton, Input, SectionTitle, Toggle, useToast } from "../lib/ui";
import { Lamp } from "../lib/pixel";
import { requestPermission } from "../lib/notify";

/**
 * 대시보드 "포트포워딩 없이 초대" 카드. 초대를 켜면 서버가 켜져 있는 동안 P2P 터널이 돌고,
 * 친구는 BlockPilot 첫 화면의 "친구 서버에 접속" 에 초대코드를 넣어 들어온다.
 */
export function InviteCard({ serverId, state }: { serverId: string; state: ProcessState }) {
  const { data: info } = useP2pHost(serverId);
  const { setEnabled, rotate, peer } = useP2pHostUpdate(serverId);
  const { data: sys } = useSystem();
  const toast = useToast();
  const navigate = useNavigate();
  if (!info) return null;
  const onErr = (e: unknown) => toast("err", (e as Error).message);
  const running = state === "running" || state === "external";
  const busy = setEnabled.isPending || rotate.isPending || peer.isPending;
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("info", "초대코드를 복사했어요. 친구에게 보내 주세요."));
  const pending = info.peers.filter((p) => p.state === "pending");
  const connected = info.peers.filter((p) => p.state === "connected");
  const act = (key: string, action: "approve" | "reject" | "block" | "unblock" | "kick" | "forget", done?: string, name?: string) =>
    peer.mutate({ key, action, name }, { onError: onErr, onSuccess: () => done && toast(action === "approve" ? "ok" : "info", done, action === "approve" ? { icon: "grass" } : undefined) });

  return (
    <Card className="space-y-4">
      <SectionTitle
        right={
          <span className="flex items-center gap-2">
            <StateBadge info={info} running={running} />
            <Toggle
              checked={info.enabled}
              disabled={!info.supported || busy}
              onChange={(v) => {
                // 초대를 켜는 클릭(사용자 동작)에 맞춰 브라우저 알림 권한을 한 번만 묻는다 → 다른 탭에 있어도 승인 요청을 알 수 있게
                if (v) void requestPermission();
                setEnabled.mutate(v, {
                  onError: onErr,
                  onSuccess: (r) => toast(v ? "ok" : "info", v ? (r.state === "listening" ? "초대를 켰어요. 초대코드를 친구에게 보내 주세요." : "초대를 켰어요. 서버를 켜면 친구가 들어올 수 있어요.") : "초대를 껐어요. 접속 중이던 친구는 끊겨요.", v ? { icon: "lever" } : undefined),
                });
              }}
            />
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-redstone" /> 포트포워딩 없이 초대
        </span>
      </SectionTitle>

      {!info.supported ? (
        <p className="text-sm text-slate-400">{info.reason}</p>
      ) : !info.enabled ? (
        <p className="text-[11px] text-slate-500">
          공유기 설정 없이 친구가 들어와요. 친구도 BlockPilot 을 받아 첫 화면 → <b className="text-slate-300">친구 서버에 접속</b> 에 초대코드를 넣으면 돼요. 초대코드는 이 서버에 들어갈 수 있는 열쇠라 믿는 친구에게만 보내세요.
        </p>
      ) : (
        <>
          {/* 경고: 터널로 들어온 접속은 전부 127.0.0.1 로 보여 IP 밴이 안 먹는다 → 화이트리스트가 유일한 접근 제어 */}
          {info.warnings.whitelistOff && (
            <Callout tone="warning" icon={ShieldAlert} title="화이트리스트가 꺼져 있어요">
              <p>초대코드만 있으면 누구나 들어올 수 있어요. 터널로 들어온 접속은 서버에 전부 같은 주소(127.0.0.1)로 보여서 IP 밴도 소용없어요. 화이트리스트를 켜고 친구 닉네임을 등록해 두세요.</p>
              <Button size="sm" variant="primary" icon={ShieldCheck} className="mt-2" onClick={() => navigate(`/s/${serverId}/players?tab=whitelist`)}>
                화이트리스트 켜러 가기
              </Button>
            </Callout>
          )}
          {info.state === "error" && (
            <Callout tone="danger" title="초대를 시작하지 못했어요">
              {info.error}
            </Callout>
          )}
          {!running && info.state === "off" && <p className="text-sm text-slate-400">서버가 꺼져 있어요. 서버를 켜면 초대가 자동으로 시작돼요.</p>}

          {info.inviteCode && (
            <div className="space-y-2">
              <div className="font-block text-[12px] text-slate-400">초대코드</div>
              {/* 하이픈에서만 줄바꿈 → 4자 그룹이 쪼개지지 않는다. 클릭 한 번에 전체 선택 */}
              <code className="well block w-full select-all break-words px-3 py-2 font-mono text-[13px] leading-relaxed tracking-wide text-white">{info.inviteCode}</code>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={Copy} onClick={() => copy(info.inviteCode!)}>
                  복사
                </Button>
                <ConfirmButton size="sm" variant="ghost" icon={RefreshCw} label="다시 만들기" confirmLabel="옛 코드는 바로 못 써요. 만들까요?" disabled={busy} onConfirm={() => rotate.mutate(undefined, { onError: onErr, onSuccess: () => toast("ok", "새 초대코드를 만들었어요. 접속 중인 친구는 그대로예요.", { icon: "book" }) })} />
              </div>
              {info.recentAuthFailures > 0 && (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-300">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  최근 10분 동안 틀린 초대코드로 {info.recentAuthFailures}번 접속 시도가 있었어요. 코드가 새어 나갔다면 다시 만드세요.
                </p>
              )}
              <p className="text-[11px] text-slate-500">
                P2P 라 서로의 공인 IP 가 상대에게 보일 수 있어요 · {sys?.os === "windows" ? "양쪽 다 처음엔 Windows 방화벽 창에서 '액세스 허용'" : "양쪽 다 방화벽에서 BlockPilot 허용 필요"} · 한 번에 {info.maxPeers}명
              </p>
            </div>
          )}

          {pending.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-block text-[12px] text-lamp">
                <Lamp state="blink" /> 승인 기다리는 친구 {pending.length}
              </div>
              {pending.map((p) => (
                <PendingRow key={p.publicKey} shortKey={p.shortKey} remote={p.remote} busy={busy} onApprove={(name) => act(p.publicKey, "approve", `승인했어요: ${name || p.shortKey}`, name)} onReject={() => act(p.publicKey, "reject", "거절했어요.")} />
              ))}
            </div>
          )}

          {connected.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-block text-[12px] text-slate-400">
                <Lamp state="on" /> 접속 중 {connected.length}
              </div>
              {connected.map((p) => (
                <div key={p.publicKey} className="well flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="font-medium text-white">{p.name ?? p.shortKey}</span>
                  {p.name && <span className="font-mono text-[11px] text-slate-500">{p.shortKey}</span>}
                  {p.remote && <span className="text-[11px] text-slate-500">{p.remote}</span>}
                  <Badge mono>마크 연결 {p.connections}</Badge>
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" icon={UserMinus} disabled={busy} onClick={() => act(p.publicKey, "kick", "연결을 끊었어요.")}>
                      끊기
                    </Button>
                    <HoldButton size="sm" variant="ghost" icon={Ban} label="차단" disabled={busy} onConfirm={() => act(p.publicKey, "block", "차단했어요. 다시 들어오지 못해요.")} />
                  </span>
                </div>
              ))}
            </div>
          )}

          {(info.approved.length > 0 || info.blocked.length > 0) && (
            <details className="text-sm">
              <summary className="cursor-pointer font-block text-[12px] text-slate-400">
                승인한 친구 {info.approved.length} · 차단 {info.blocked.length}
              </summary>
              <div className="mt-2 space-y-1.5">
                {info.approved.map((p) => {
                  const short = p.publicKey.slice(0, 8);
                  return (
                    <div key={p.publicKey} className="well flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="text-slate-200">{p.name ?? short}</span>
                      {p.name && <span className="font-mono text-[11px] text-slate-500">{short}</span>}
                      <span className="ml-auto flex gap-1">
                        <HoldButton size="sm" variant="ghost" icon={UserX} label="승인 취소" disabled={busy} onConfirm={() => act(p.publicKey, "forget", "승인을 취소했어요. 다음엔 다시 승인해야 들어와요.")} />
                        <HoldButton size="sm" variant="ghost" icon={Ban} label="차단" disabled={busy} onConfirm={() => act(p.publicKey, "block", "차단했어요.")} />
                      </span>
                    </div>
                  );
                })}
                {info.blocked.map((p) => {
                  const short = p.publicKey.slice(0, 8);
                  return (
                    <div key={p.publicKey} className="well flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <Ban className="h-3.5 w-3.5 text-red-400" />
                      <span className="text-slate-400">{p.name ?? short}</span>
                      {p.name && <span className="font-mono text-[11px] text-slate-500">{short}</span>}
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => act(p.publicKey, "unblock", "차단을 해제했어요. 들어오려면 다시 승인해야 해요.")}>
                        차단 해제
                      </Button>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {info.warnings.onlineModeOff && <p className="text-[11px] text-amber-300/90">online-mode 가 꺼져 있어요. 닉네임만 대면 아무나 그 사람인 척 들어올 수 있으니 정품 인증을 켜 두는 걸 권해요.</p>}
        </>
      )}
    </Card>
  );
}

function StateBadge({ info, running }: { info: P2pHostInfo; running: boolean }) {
  if (!info.supported) return <Badge>사용 불가</Badge>;
  if (!info.enabled) return <Badge>꺼짐</Badge>;
  if (info.state === "listening")
    return (
      <Badge tone="lamp">
        <Lamp state="on" size={8} /> 초대 중
      </Badge>
    );
  if (info.state === "starting")
    return (
      <Badge tone="warning">
        <Lamp state="blink" size={8} /> 켜는 중
      </Badge>
    );
  if (info.state === "error") return <Badge tone="danger">오류</Badge>;
  return <Badge tone={running ? "warning" : "neutral"}>{running ? "준비 중" : "서버 꺼짐"}</Badge>;
}

/** 승인 대기 한 줄: 이름을 붙여 승인하거나 거절 */
function PendingRow({ shortKey, remote, busy, onApprove, onReject }: { shortKey: string; remote?: string; busy: boolean; onApprove: (name?: string) => void; onReject: () => void }) {
  const [name, setName] = useState("");
  return (
    <div className="slab flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      {/* 폰에서는 "정체 / 입력+버튼" 두 줄로 고정 */}
      <span className="flex basis-full items-center gap-2 sm:basis-auto">
        <span className="font-mono text-[12px] text-white">{shortKey}</span>
        {remote && <span className="text-[11px] text-slate-500">{remote}</span>}
      </span>
      <Input className="!h-7 min-w-[8rem] flex-1 sm:max-w-[160px]" placeholder="이름 (선택)" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
      <span className="ml-auto flex gap-1">
        <Button size="sm" variant="primary" icon={Check} disabled={busy} onClick={() => onApprove(name.trim() || undefined)}>
          승인
        </Button>
        <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={onReject}>
          거절
        </Button>
      </span>
    </div>
  );
}
