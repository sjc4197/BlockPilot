import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Circle, CircleCheck, ListChecks, X } from "lucide-react";
import type { ServerSummary, WhitelistEntry } from "@blockpilot/shared";
import { useAutomation, useBackups, useP2pHost, usePlayerList } from "../api/hooks";
import { Badge, Button, Card, SectionTitle, cx } from "../lib/ui";

const doneKey = (id: string) => `bp.firstSteps.${id}`;
const startedKey = (id: string) => `bp.firstSteps.${id}.started`;
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 사생활 보호 모드 등에선 저장이 안 될 수 있다. 그냥 넘어간다 */
  }
};

interface Step {
  key: string;
  label: string;
  /** 아직 안 했을 때 안내 */
  hint: string;
  /** 끝났을 때 안내 (담담하게 상태만) */
  doneHint: string;
  done: boolean;
  /** 선택 단계는 완료하지 않아도 카드가 사라진다 */
  optional?: boolean;
  /** 같은 페이지 안의 위치면 <a href="#…">, 아니면 라우터 Link */
  to: string;
  anchor?: boolean;
}

interface Props {
  serverId: string;
  server: ServerSummary;
  p2pEnabled?: boolean;
  whitelistOn?: boolean;
  backupScheduled?: boolean;
  discordSet?: boolean;
  className?: string;
}

/**
 * 처음 서버를 등록한 사람을 위한 체크리스트. 모든 필수 단계가 끝나거나 X 를 누르면 사라진다.
 * 바깥 껍데기는 "닫았는지" 만 보고, 닫혔으면 안쪽(목록·백업 폴링 같은 질의를 켜는 쪽)을 아예 마운트하지 않는다.
 * 다 끝난 것도 한 번 보면 닫힌 걸로 기억해 두므로 그 뒤로는 질의가 돌지 않는다.
 */
export function FirstStepsCard(props: Props) {
  const [dismissed, setDismissed] = useState(() => lsGet(doneKey(props.serverId)) === "done");
  if (dismissed) return null;
  const dismiss = () => {
    lsSet(doneKey(props.serverId), "done");
    setDismissed(true);
  };
  return <FirstStepsInner {...props} onDismiss={dismiss} />;
}

/** 자세한 상태(화이트리스트·백업·알림·P2P)는 props 로 받되, 안 주면 직접 조회한다 (react-query 가 대시보드와 캐시를 공유) */
function FirstStepsInner({ serverId, server, p2pEnabled, whitelistOn, backupScheduled, discordSet, className, onDismiss }: Props & { onDismiss: () => void }) {
  const { data: whitelist } = usePlayerList<WhitelistEntry>(serverId, "whitelist");
  const { data: backups } = useBackups(serverId);
  const { data: automation } = useAutomation(serverId);
  const { data: p2p } = useP2pHost(serverId);

  // 한 번이라도 켜진 걸 봤으면 기억해 둔다 (꺼진 뒤에도 "서버 켜기" 는 끝난 걸로)
  const everStarted = server.process.state !== "stopped" || lsGet(startedKey(serverId)) === "1";
  useEffect(() => {
    if (server.process.state !== "stopped") lsSet(startedKey(serverId), "1");
  }, [serverId, server.process.state]);

  const wlOn = whitelistOn ?? server.properties.whitelist;
  const wlCount = whitelist?.length ?? 0;
  const p2pOn = p2pEnabled ?? !!p2p?.enabled;
  const steps: Step[] = [
    { key: "start", label: "서버 켜기", hint: "바로 위의 레버를 당겨요", doneHint: "켜 본 적 있어요", done: everStarted, to: `/s/${serverId}` },
    {
      key: "friends",
      label: "친구 추가",
      // 화이트리스트가 꺼져 있으면 아직 안 한 것. P2P 초대는 승인제라 그때는 선택 단계가 된다
      hint: wlOn ? "화이트리스트에 친구 이름을 넣어요" : p2pOn ? "P2P 초대는 승인제라 화이트리스트는 안 켜도 돼요" : "화이트리스트를 켜고 친구 이름을 넣어요",
      doneHint: `화이트리스트에 ${wlCount}명 있어요`,
      done: wlOn && wlCount > 0,
      optional: p2pOn,
      to: `/s/${serverId}/players`,
    },
    { key: "invite", label: "친구 초대 방법 고르기", hint: "초대코드(P2P) 또는 주소로 초대해요", doneHint: "초대코드(P2P) 를 켰어요", done: p2pOn, to: "#invite", anchor: true },
    { key: "backup", label: "자동 백업 켜기", hint: "월드가 날아가도 되돌릴 수 있게", doneHint: "자동 백업이 켜져 있어요", done: backupScheduled ?? (backups?.status.settings.intervalMinutes ?? 0) > 0, to: `/s/${serverId}/backups` },
    { key: "discord", label: "디스코드 알림", hint: "서버가 켜지고 꺼질 때 알려 줘요", doneHint: "디스코드 웹훅이 연결돼 있어요", done: discordSet ?? !!automation?.discord.webhookSet, optional: true, to: `/s/${serverId}/settings` },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  const allDone = doneCount === required.length;

  // 다 끝났으면 닫은 걸로 기억 → 바깥 껍데기가 이 컴포넌트를 내려서 질의도 멈춘다
  useEffect(() => {
    if (allDone) onDismiss();
  }, [allDone, onDismiss]);
  if (allDone) return null;

  return (
    <Card className={cx("space-y-2", className)}>
      <SectionTitle right={<Button size="sm" variant="ghost" icon={X} onClick={onDismiss} aria-label="처음 할 일 닫기" title="다시 보이지 않아요" />}>
        <span className="inline-flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-redstone" /> 처음 할 일
          <Badge tone={doneCount ? "lamp" : "neutral"}>
            {doneCount}/{required.length}
          </Badge>
        </span>
      </SectionTitle>
      <ul className="space-y-1">
        {steps.map((s) => (
          <li key={s.key} className={cx("flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-3 py-1.5 text-sm", s.done ? "well text-slate-500" : "text-slate-200")}>
            {s.done ? <CircleCheck className="h-4 w-4 shrink-0 text-emerald-400" /> : <Circle className="h-4 w-4 shrink-0 text-slate-600" />}
            <span className={cx("shrink-0", s.done && "line-through")}>{s.label}</span>
            {s.optional && !s.done && <Badge>선택</Badge>}
            {/* 폰에선 설명이 아이콘 아래로 내려가 한 줄을 다 쓰고, sm 부터는 같은 줄에서 줄임표 */}
            <span className="order-last basis-full pl-[26px] text-[12px] text-slate-500 sm:order-none sm:min-w-0 sm:flex-1 sm:basis-auto sm:truncate sm:pl-0">{s.done ? s.doneHint : s.hint}</span>
            {!s.done &&
              (s.anchor ? (
                <a href={s.to} className="ml-auto shrink-0 font-block text-[12px] text-red-300 hover:underline focus-ring sm:ml-0">
                  하러 가기 →
                </a>
              ) : (
                <Link to={s.to} className="ml-auto shrink-0 font-block text-[12px] text-red-300 hover:underline focus-ring sm:ml-0">
                  하러 가기 →
                </Link>
              ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}
