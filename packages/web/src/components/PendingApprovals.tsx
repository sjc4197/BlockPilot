import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { useP2pHost, useP2pHostUpdate } from "../api/hooks";
import { Badge, Button, Input, cx, useToast } from "../lib/ui";
import { Lamp } from "../lib/pixel";
import { notify } from "../lib/notify";

const BASE_TITLE = "BlockPilot";

/**
 * 머리띠(헤더)의 "승인 요청 N" 배지. 어느 화면에 있든 친구의 P2P 접속 요청이 보이고, 눌러서 바로 승인·거절한다.
 * 같은 질의 키·주기를 쓰므로 대시보드가 아닌 화면에서도 2초마다 새로 가져온다.
 * 새 요청이 오면 탭 제목에 (N) 을 붙이고 브라우저 알림을 한 번 띄운다.
 */
export function PendingApprovals({ serverId, serverName }: { serverId: string; serverName?: string }) {
  const { data: info } = useP2pHost(serverId);
  const { peer } = useP2pHostUpdate(serverId);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  // 지금 승인 대기 중인 키. 사라졌다가(시간 초과·거절) 다시 오면 또 알린다
  const seen = useRef(new Set<string>());
  const pending = info?.peers.filter((p) => p.state === "pending") ?? [];
  const n = pending.length;

  // 탭 제목 (N)
  useEffect(() => {
    document.title = n > 0 ? `(${n}) ${BASE_TITLE}${serverName ? ` · ${serverName}` : ""}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [n, serverName]);

  // 새로 온 요청마다 브라우저 알림 한 번
  useEffect(() => {
    const keys = new Set(pending.map((p) => p.publicKey));
    for (const p of pending) {
      if (seen.current.has(p.publicKey)) continue;
      seen.current.add(p.publicKey);
      notify("친구 접속 요청", `${p.shortKey} 님이 ${serverName ?? "서버"} 접속 승인을 기다려요. 눌러서 승인해 주세요.`, { tag: `p2p-pending-${p.publicKey}` });
    }
    for (const k of seen.current) if (!keys.has(k)) seen.current.delete(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.map((p) => p.publicKey).join(","), serverName]);

  // 요청이 다 처리되면 닫고, 바깥 클릭·Esc 로 닫는다
  useEffect(() => {
    if (n === 0) setOpen(false);
  }, [n]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 열리면 첫 입력칸으로 포커스를 옮기고, 닫히면 (포커스가 갈 곳을 잃었을 때만) 배지로 되돌린다
  useEffect(() => {
    if (open) {
      const first = pop.current?.querySelector<HTMLElement>("input, button");
      (first ?? pop.current)?.focus();
    } else if (wasOpen.current) {
      const ae = document.activeElement;
      if (!ae || ae === document.body) btn.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const onErr = (e: unknown) => toast("err", (e as Error).message);
  const act = (key: string, action: "approve" | "reject", done: string, name?: string) =>
    peer.mutate({ key, action, name }, { onError: onErr, onSuccess: () => toast(action === "approve" ? "ok" : "info", done, action === "approve" ? { icon: "grass" } : undefined) });

  return (
    // 폰에서는 헤더(sticky) 기준, sm 부터는 배지 기준으로 팝오버를 놓는다
    <div ref={box} className={cx("sm:relative", n === 0 && "hidden")}>
      <span className="sr-only" aria-live="polite">
        {n > 0 ? `친구 ${n}명이 접속 승인을 기다려요` : ""}
      </span>
      {n > 0 && (
        <button ref={btn} type="button" className="focus-ring inline-flex" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" title="친구 접속 승인 요청">
          <Badge tone="lamp" className="gap-1.5 px-2 hover:bg-[#3a2814]">
            <Lamp state="blink" size={8} />
            승인<span className="hidden sm:inline">&nbsp;요청</span> {n}
          </Badge>
        </button>
      )}
      {open && n > 0 && (
        <div ref={pop} tabIndex={-1} role="dialog" aria-label="접속 승인 요청" className="slab absolute left-3 right-3 top-full z-30 mt-1 max-h-[70vh] space-y-2 overflow-y-auto p-3 sm:left-auto sm:right-0 sm:mt-2 sm:w-[22rem]">
          <div className="flex items-center gap-2 font-block text-[12px] text-lamp">
            <Lamp state="blink" /> 승인 기다리는 친구 {n}
          </div>
          {pending.map((p) => (
            <PendingRow key={p.publicKey} shortKey={p.shortKey} remote={p.remote} busy={peer.isPending} onApprove={(name) => act(p.publicKey, "approve", `승인했어요: ${name || p.shortKey}`, name)} onReject={() => act(p.publicKey, "reject", "거절했어요.")} />
          ))}
          <p className="text-[11px] text-slate-500">초대코드를 보낸 친구가 맞는지 확인한 뒤 승인하세요. 승인한 친구는 다음부터 바로 들어와요.</p>
        </div>
      )}
    </div>
  );
}

function PendingRow({ shortKey, remote, busy, onApprove, onReject }: { shortKey: string; remote?: string; busy: boolean; onApprove: (name?: string) => void; onReject: () => void }) {
  const [name, setName] = useState("");
  return (
    <div className="well flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <span className="flex basis-full items-center gap-2">
        <span className="font-mono text-[12px] text-white">{shortKey}</span>
        {remote && <span className="text-[11px] text-slate-500">{remote}</span>}
      </span>
      <Input className="!h-7 min-w-[7rem] flex-1" placeholder="이름 (선택)" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
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
