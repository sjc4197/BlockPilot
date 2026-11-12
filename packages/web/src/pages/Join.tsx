import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Copy, ExternalLink, Link2, RefreshCw, Unplug, X } from "lucide-react";
import type { P2pJoinInfo } from "@blockpilot/shared";
import { useP2pJoin, useP2pJoinActions, useSystem } from "../api/hooks";
import { Lamp } from "../lib/pixel";
import { notify, requestPermission } from "../lib/notify";
import { Badge, Button, Callout, Card, Field, Input, PageHeader, SectionTitle, Spinner, cx, inputCls, useToast } from "../lib/ui";

/**
 * 친구 서버에 접속 (참가 모드). 초대코드 → 연결 → (호스트 승인) → "마인크래프트에서 localhost:<포트> 로 접속하세요".
 * 서버를 등록하지 않은 사람도 쓰는 화면이라 서버 레이아웃 밖에 있다.
 */
export default function Join() {
  const { data: info } = useP2pJoin();
  const { start, stop, forget } = useP2pJoinActions();
  const { data: sys } = useSystem();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const codeBox = useRef<HTMLTextAreaElement>(null);
  const onErr = (e: unknown) => toast("err", (e as Error).message);

  // 마지막 초대를 칸에 미리 채워 둔다 (사용자가 뭔가 쳤으면 덮지 않는다)
  const codeRef = useRef(code);
  codeRef.current = code;
  useEffect(() => {
    if (info?.remembered && !codeRef.current) {
      setCode(info.remembered.inviteCode);
      setName(info.remembered.name ?? "");
    }
  }, [info?.remembered]);
  // 코드 길이에 맞춰 칸 높이를 (잘려서 스크롤되지 않게)
  useEffect(() => {
    const el = codeBox.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [code, info?.state]);

  const active = !!info && (info.state === "connecting" || info.state === "pending" || info.state === "connected");
  const addr = info?.localPort ? (info.localPort === 25565 ? "localhost" : `localhost:${info.localPort}`) : undefined;

  // 승인 기다리다 연결되면 (다른 탭을 보고 있어도) 알리고, 접속 주소를 바로 복사해 둔다
  const prevState = useRef(info?.state);
  useEffect(() => {
    const prev = prevState.current;
    prevState.current = info?.state;
    if (prev !== "pending" || info?.state !== "connected") return;
    notify("승인됐어요", `마인크래프트에서 ${addr ?? "localhost"} 로 접속하세요`, { tag: "p2p-approved" });
    if (addr && navigator.clipboard) navigator.clipboard.writeText(addr).then(() => toast("ok", `주소를 복사했어요: ${addr}`, { icon: "grass" }), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.state]);

  // 이름 칸을 비우면 "" 를 보내 지난 이름을 지운다
  const connect = () => {
    if (!code.trim() || active) return;
    // 접속 버튼(사용자 동작)에 맞춰 알림 권한을 한 번만 묻는다 → 승인되면 다른 탭에 있어도 알 수 있게
    void requestPermission();
    start.mutate({ inviteCode: code.trim(), name: name.trim() }, { onError: onErr });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    connect();
  };
  const disconnect = () => stop.mutate(undefined, { onError: onErr, onSuccess: () => toast("info", "연결을 끊었어요.") });

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link to="/" className="mb-6 inline-flex items-center gap-1.5 font-block text-[12px] text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> 서버 목록
      </Link>
      <div className="space-y-5">
        <PageHeader icon={Link2} title="친구 서버에 접속" description="친구가 BlockPilot 에서 보낸 초대코드를 넣으면 포트포워딩 없이 친구 서버에 들어가요. 연결되면 마인크래프트에서 localhost 주소로 접속하면 돼요." />

        {!info ? (
          <Spinner />
        ) : !info.supported ? (
          <Callout tone="warning" title="이 컴퓨터에서는 쓸 수 없어요">
            {info.reason}
          </Callout>
        ) : (
          <>
            {/* 연결 중·연결됨: 지금 필요한 것(상태·접속 주소)을 먼저 */}
            {active && <StatusPanel info={info} onCopy={(t) => navigator.clipboard?.writeText(t).then(() => toast("info", `${t} 를 복사했어요.`))} />}

            {active ? (
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <span className="font-block text-[12px] text-slate-400">초대</span>{" "}
                  <span className="text-white">{name.trim() || info.remembered?.name || "친구 서버"}</span> <span className="font-mono text-[11px] text-slate-500">{info.hostShortKey}</span>
                </div>
                <Button className="w-full md:w-auto" icon={Unplug} loading={stop.isPending} onClick={disconnect}>
                  연결 끊기
                </Button>
              </Card>
            ) : (
              <Card>
                <form onSubmit={onSubmit} className="space-y-4">
                  <SectionTitle right={<StateBadge info={info} />}>초대코드</SectionTitle>
                  <Field label="친구가 보낸 초대코드" hint="4자씩 20묶음이에요. 하이픈·공백·줄바꿈이 섞여 있어도 돼요.">
                    <textarea
                      id="join-code"
                      ref={codeBox}
                      className={cx(inputCls, "h-auto min-h-[3.75rem] resize-none py-2 font-mono text-[13px] leading-relaxed")}
                      rows={3}
                      spellCheck={false}
                      placeholder="xxxx-xxxx-xxxx-…"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </Field>
                  <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <Field label="이름 (선택)">
                      <Input id="join-name" placeholder="예: 철수네 서버" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
                    </Field>
                    <Button type="submit" variant="primary" className="w-full md:w-auto" icon={Link2} disabled={!code.trim()} loading={start.isPending}>
                      접속
                    </Button>
                  </div>
                  {info.remembered && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span>
                        마지막 초대: <b className="text-slate-300">{info.remembered.name ?? info.remembered.hostShortKey}</b> ({info.remembered.hostShortKey})
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={X}
                        onClick={() =>
                          forget.mutate(undefined, {
                            onError: onErr,
                            onSuccess: () => {
                              setCode("");
                              setName("");
                            },
                          })
                        }
                      >
                        잊기
                      </Button>
                    </div>
                  )}
                </form>
              </Card>
            )}

            {info.state === "failed" && <FailurePanel info={info} onRetry={connect} onDismiss={() => stop.mutate(undefined, { onError: onErr })} retrying={start.isPending} canRetry={!!code.trim()} />}

            <div className="space-y-1 text-[11px] text-slate-500">
              <p>친구가 승인하면 연결돼요. 연결된 동안 BlockPilot 을 끄면 접속도 끊겨요.</p>
              <p>P2P 연결 특성상 서로의 공인 IP 가 상대에게 노출될 수 있어요. 신뢰하는 친구와만 쓰세요.</p>
              <p>{sys?.os === "windows" ? "처음 접속할 때 Windows 방화벽 허용 창이 뜨면 '액세스 허용'을 눌러 주세요." : "방화벽이 켜져 있으면 BlockPilot 의 들어오는 연결을 허용해야 해요."}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StateBadge({ info }: { info: P2pJoinInfo }) {
  switch (info.state) {
    case "connecting":
      return (
        <Badge tone="warning">
          <Lamp state="blink" size={8} /> 연결 중
        </Badge>
      );
    case "pending":
      return (
        <Badge tone="warning">
          <Lamp state="blink" size={8} /> 승인 기다리는 중
        </Badge>
      );
    case "connected":
      return (
        <Badge tone="lamp">
          <Lamp state="on" size={8} /> 연결됨
        </Badge>
      );
    case "failed":
      return <Badge tone="danger">실패</Badge>;
    default:
      return <Badge>대기</Badge>;
  }
}

/** 연결 중·승인 대기·연결됨 */
function StatusPanel({ info, onCopy }: { info: P2pJoinInfo; onCopy: (t: string) => void }) {
  const addr = info.localPort ? (info.localPort === 25565 ? "localhost" : `localhost:${info.localPort}`) : undefined;
  return (
    <Card className={cx("space-y-3", info.state === "connected" && "shadow-[inset_0_0_0_1px_rgba(255,179,71,.35)]")}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-block text-[12px] text-white">
            {info.state === "connecting" && "호스트를 찾아 연결하는 중…"}
            {info.state === "pending" && "호스트가 승인하길 기다리는 중"}
            {info.state === "connected" && "연결됐어요"}
          </div>
          {info.hostShortKey && <div className="font-mono text-[11px] text-slate-500">호스트 {info.hostShortKey}</div>}
        </div>
        <StateBadge info={info} />
      </div>
      {info.state === "pending" && <p className="text-sm text-slate-400">친구의 BlockPilot 대시보드에 승인 요청이 떠 있어요. 친구가 "승인"을 누르면 바로 이어져요.</p>}
      {info.state === "connected" && addr && (
        <div className="space-y-2">
          <p className="text-sm text-slate-300">
            마인크래프트 → <b className="text-white">멀티플레이</b> → <b className="text-white">직접 연결</b>(또는 서버 추가)에 아래 주소를 넣으세요.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="well px-3 py-1.5 font-mono text-[14px] text-white">{addr}</code>
            <Button size="sm" icon={Copy} onClick={() => onCopy(addr)}>
              복사
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** 실패: 원인 → 해 볼 것 → 그래도 안 되면 (대안 서비스 안내만) → 다시 접속 · 닫기 */
function FailurePanel({ info, onRetry, onDismiss, retrying, canRetry }: { info: P2pJoinInfo; onRetry: () => void; onDismiss: () => void; retrying: boolean; canRetry: boolean }) {
  const d = info.diagnosis;
  return (
    <Callout tone="danger" title={d?.title ?? info.detail ?? "연결하지 못했어요."}>
      <div className="space-y-2">
        {d ? (
          <>
            <p>{d.cause}</p>
            <ul className="list-disc space-y-1 pl-5">
              {d.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            {d.alternatives.length > 0 && (
              <div className="pt-1">
                <p className="font-block text-[12px] text-slate-300">그래도 안 되면 (BlockPilot 과 별개 서비스예요)</p>
                <ul className="mt-1 space-y-1">
                  {d.alternatives.map((a) => (
                    <li key={a.url}>
                      <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-red-300 underline underline-offset-2">
                        {a.label} <ExternalLink className="h-3 w-3" />
                      </a>{" "}
                      <span className="text-slate-300">{a.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p>초대코드가 맞는지, 친구의 BlockPilot 에서 초대가 켜져 있고 서버가 켜져 있는지 확인한 뒤 다시 접속해 보세요.</p>
        )}
        {info.hostShortKey && <p className="font-mono text-[11px] text-slate-500">호스트 {info.hostShortKey}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" icon={RefreshCw} disabled={!canRetry} loading={retrying} onClick={onRetry}>
            다시 접속
          </Button>
          <Button size="sm" variant="ghost" icon={X} onClick={onDismiss}>
            닫기
          </Button>
        </div>
      </div>
    </Callout>
  );
}
