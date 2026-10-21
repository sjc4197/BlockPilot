import { useState } from "react";
import { BellRing, RotateCcw, Send, Trash2 } from "lucide-react";
import { DISCORD_EVENTS, DISCORD_EVENT_LABEL, type AutomationView } from "@blockpilot/shared";
import { useDiscordTest, useUpdateAutomation } from "../api/hooks";
import { Badge, Button, Callout, Card, Field, Input, SectionTitle, Select, Toggle, fmtDate, useToast } from "../lib/ui";

/** 서버 설정 → 알림·자동화 탭 */
export function AutomationPanel({ serverId, view }: { serverId: string; view: AutomationView }) {
  return (
    <div className="space-y-5">
      <DiscordCard serverId={serverId} view={view} />
      <AutoRestartCard serverId={serverId} view={view} />
    </div>
  );
}

function DiscordCard({ serverId, view }: { serverId: string; view: AutomationView }) {
  const update = useUpdateAutomation(serverId);
  const test = useDiscordTest(serverId);
  const toast = useToast();
  const [url, setUrl] = useState("");
  const d = view.discord;
  const onErr = (e: unknown) => toast("err", (e as Error).message);

  const saveUrl = () =>
    update.mutate(
      { discord: { webhookUrl: url.trim() } },
      {
        onSuccess: () => {
          setUrl("");
          toast("ok", "디스코드 웹훅을 저장했어요. 시험 메시지로 확인해 보세요.", { icon: "book" });
        },
        onError: onErr,
      },
    );

  return (
    <Card className="space-y-4">
      <SectionTitle right={<Badge tone={d.webhookSet ? "lamp" : "neutral"}>{d.webhookSet ? "연결됨" : "꺼짐"}</Badge>}>
        <span className="inline-flex items-center gap-2">
          <BellRing className="h-4 w-4 text-redstone" /> 디스코드 알림
        </span>
      </SectionTitle>
      <p className="text-sm text-slate-400">서버가 켜지고 꺼질 때, 친구가 들어오고 나갈 때, 서버가 죽었을 때 디스코드 채널에 글을 올려요.</p>

      <div className="flex flex-wrap items-end gap-2">
        <Field
          className="min-w-[16rem] flex-1"
          label="웹훅 주소"
          hint="디스코드 채널 설정 → 연동 → 웹후크 → 새 웹후크 → 웹후크 URL 복사. 주소는 이 컴퓨터에만 저장되고 화면에는 끝 네 글자만 보여요."
        >
          <Input id="discord-webhook" type="password" autoComplete="off" spellCheck={false} placeholder={d.webhookSet ? `저장됨 (${d.webhookHint}) · 바꾸려면 새 주소 붙여 넣기` : "https://discord.com/api/webhooks/…"} value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Button variant="primary" disabled={!url.trim()} loading={update.isPending} onClick={saveUrl}>
          저장
        </Button>
        {d.webhookSet && (
          <>
            <Button icon={Send} loading={test.isPending} onClick={() => test.mutate(undefined, { onSuccess: () => toast("ok", "시험 메시지를 보냈어요. 디스코드 채널을 확인해 보세요.", { icon: "book", first: "discord" }), onError: onErr })}>
              시험 메시지
            </Button>
            <Button variant="ghost" icon={Trash2} onClick={() => update.mutate({ discord: { webhookUrl: "" } }, { onSuccess: () => toast("info", "웹훅을 지웠어요. 더 이상 알림을 보내지 않아요."), onError: onErr })}>
              지우기
            </Button>
          </>
        )}
      </div>

      <div>
        <div className="mb-2 font-block text-[12px] text-slate-400">보낼 소식</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {DISCORD_EVENTS.map((k) => (
            <label key={k} className="well flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="text-slate-300">{DISCORD_EVENT_LABEL[k]}</span>
              <Toggle size="sm" checked={d.events[k]} onChange={(v) => update.mutate({ discord: { events: { [k]: v } } }, { onError: onErr })} />
            </label>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">접속 주소(IP)는 채널을 보는 모두에게 보이므로 메시지에 넣지 않아요. 입장·퇴장은 몇 초씩 묶어서 보내요.</p>
      </div>

      {d.lastError ? (
        <Callout tone="danger" title="마지막 전송 실패">
          {d.lastError}
        </Callout>
      ) : (
        d.lastSentAt && <p className="text-[11px] text-slate-500 tnum">마지막으로 보낸 시각 {fmtDate(d.lastSentAt)}</p>
      )}
    </Card>
  );
}

function AutoRestartCard({ serverId, view }: { serverId: string; view: AutomationView }) {
  const update = useUpdateAutomation(serverId);
  const toast = useToast();
  const a = view.autoRestart;
  const onErr = (e: unknown) => toast("err", (e as Error).message);
  return (
    <Card className="space-y-4">
      <SectionTitle right={<Toggle checked={a.enabled} onChange={(v) => update.mutate({ autoRestart: { enabled: v } }, { onError: onErr })} />}>
        <span className="inline-flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-redstone" /> 크래시 자동 재시작
        </span>
      </SectionTitle>
      <p className="text-sm text-slate-400">
        레버로 끈 게 아닌데 서버가 꺼지면 잠깐 뒤 다시 켜요. 10분 안에 세 번 넘게 꺼지면 같은 문제가 반복되는 거라 멈추고 알려 줘요. BlockPilot 이 켠 서버에만 동작해요.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="다시 켜기까지" className="w-40">
          <Select id="auto-restart-delay" value={a.delaySeconds} disabled={!a.enabled} onChange={(e) => update.mutate({ autoRestart: { delaySeconds: Number(e.target.value) } }, { onError: onErr })}>
            {[10, 30, 60, 120, 300].map((s) => (
              <option key={s} value={s}>
                {s < 60 ? `${s}초` : `${s / 60}분`}
              </option>
            ))}
          </Select>
        </Field>
        {a.enabled && (
          <span className="pb-2 text-[12px] text-slate-500">
            {a.gaveUp ? <Badge tone="danger">반복해서 꺼져 자동 재시작을 멈췄어요 · 레버로 켜면 다시 동작해요</Badge> : a.recentAttempts > 0 ? `최근 10분 동안 ${a.recentAttempts}번 다시 켰어요` : "아직 다시 켠 적 없어요"}
          </span>
        )}
      </div>
    </Card>
  );
}
