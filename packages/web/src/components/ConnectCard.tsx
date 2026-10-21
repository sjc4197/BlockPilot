import { Copy, Globe, Radar, Wifi } from "lucide-react";
import type { ProcessState } from "@blockpilot/shared";
import { useNetwork, usePublicIp, useReachCheck, useSystem } from "../api/hooks";
import { Badge, Button, Card, SectionTitle, useToast } from "../lib/ui";

/** 대시보드 "친구 접속" 카드: 친구에게 알려 줄 주소와 밖에서 접속되는지 검사 */
export function ConnectCard({ serverId, state }: { serverId: string; state: ProcessState }) {
  const { data: net } = useNetwork(serverId);
  const { data: sys } = useSystem();
  const pub = usePublicIp();
  const check = useReachCheck(serverId);
  const toast = useToast();
  if (!net) return null;

  const port = net.port;
  // 마인크래프트는 25565 면 포트를 안 써도 된다
  const withPort = (ip: string) => (port === 25565 ? ip : `${ip}:${port}`);
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("info", `${text} 를 복사했어요. 친구에게 보내 주세요.`));
  const lan = net.local.filter((a) => a.kind !== "other").slice(0, 2);
  const running = state === "running" || state === "external";
  const result = check.data;
  const onErr = (e: unknown) => toast("err", (e as Error).message);

  return (
    <Card className="space-y-4">
      <SectionTitle right={<Badge mono>포트 {port}</Badge>}>친구 접속</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center gap-2 font-block text-[12px] text-slate-400">
            <Wifi className="h-4 w-4 text-redstone" /> 같은 와이파이·공유기
          </div>
          {lan.length ? (
            lan.map((a) => (
              <AddressRow key={a.address} text={withPort(a.address)} note={a.kind === "vpn" ? `${a.iface} · VPN` : a.iface} onCopy={copy} />
            ))
          ) : (
            <p className="text-sm text-slate-500">이 컴퓨터의 네트워크 주소를 찾지 못했어요.</p>
          )}
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 font-block text-[12px] text-slate-400">
            <Globe className="h-4 w-4 text-redstone" /> 밖에서 (다른 집)
          </div>
          {pub.data ? (
            <AddressRow text={withPort(pub.data.ip)} note="공인 IP" onCopy={copy} />
          ) : (
            <Button size="sm" loading={pub.isPending} onClick={() => pub.mutate(undefined, { onError: onErr })}>
              공인 IP 확인
            </Button>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={Radar} disabled={!running} loading={check.isPending} onClick={() => check.mutate(pub.data?.ip ?? "", { onError: onErr })}>
              밖에서 접속되는지 검사
            </Button>
            {!running && <span className="text-[11px] text-slate-500">서버를 켠 뒤 검사할 수 있어요</span>}
          </div>
          <p className="text-[11px] text-slate-500">공인 IP 확인은 ipify.org, 접속 검사는 mcsrvstat.us 에 이 컴퓨터의 공인 IP 를 알려요. 누를 때만 동작해요.</p>
        </div>
      </div>

      {result &&
        (result.reachable ? (
          <div className="bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200 shadow-[inset_0_0_0_1px_rgba(52,211,153,.35)]">
            <b className="font-block text-[12px]">밖에서 접속돼요.</b> 친구에게 <code className="font-mono">{withPort(result.ip)}</code> 를 알려 주세요.
            {result.players && <span className="text-emerald-300/80"> · 검사 서비스가 본 접속자 {result.players.online}/{result.players.max}명</span>}
          </div>
        ) : (
          <div className="space-y-2 bg-[#1f0a08] px-4 py-3 text-sm shadow-[inset_0_0_0_1px_rgba(255,59,47,.35)]">
            <b className="font-block text-[12px] text-red-300">밖에서는 아직 접속이 안 돼요.</b>
            <ol className="list-decimal space-y-1.5 pl-5 text-slate-300">
              <li>
                <b className="text-white">공유기 포트포워딩</b>: 브라우저 주소창에 <code className="font-mono">192.168.0.1</code> 또는 <code className="font-mono">192.168.1.1</code> 을 넣어 공유기 관리 페이지에 들어가, "포트포워딩"에 외부 포트 <code className="font-mono">{port}</code>, 내부 IP{" "}
                <code className="font-mono">{lan[0]?.address ?? "이 컴퓨터 주소"}</code>, 내부 포트 <code className="font-mono">{port}</code>, TCP 로 추가해요.
              </li>
              <li>
                <b className="text-white">방화벽</b>:{" "}
                {sys?.os === "windows"
                  ? "서버를 처음 켤 때 뜬 Windows 보안 경고에서 '액세스 허용'을 눌러요. 놓쳤다면 Windows 보안 → 방화벽 및 네트워크 보호 → 방화벽에서 앱 허용에서 Java 를 체크해요."
                  : sys?.os === "linux"
                    ? `ufw 를 쓰면 sudo ufw allow ${port}/tcp 로 열어요.`
                    : "시스템 설정 → 네트워크 → 방화벽이 켜져 있으면 옵션에서 java 의 들어오는 연결을 허용해요."}
              </li>
              <li>
                <b className="text-white">공인 IP 를 못 받는 경우</b>: 공유기 관리 페이지의 인터넷(WAN) IP 가 위 공인 IP 와 다르면 통신사가 주소를 나눠 쓰는 중이라 포트포워딩이 안 돼요. playit.gg 같은 터널 서비스나 다 같이 쓰는 VPN(Tailscale 등)을 써요.
              </li>
            </ol>
            <p className="text-[11px] text-slate-500">{result.cachedNote}</p>
          </div>
        ))}
    </Card>
  );
}

function AddressRow({ text, note, onCopy }: { text: string; note: string; onCopy: (t: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <code className="well px-2.5 py-1 font-mono text-[13px] text-white">{text}</code>
      <Button size="sm" variant="ghost" icon={Copy} onClick={() => onCopy(text)} aria-label={`${text} 복사`}>
        복사
      </Button>
      <span className="text-[11px] text-slate-500">{note}</span>
    </div>
  );
}
