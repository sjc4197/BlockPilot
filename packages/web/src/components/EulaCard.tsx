import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useAcceptEula } from "../api/hooks";
import { Button, Callout, cx, useToast } from "../lib/ui";

/**
 * eula.txt 에 eula=true 가 없을 때 대시보드 맨 위에 보여 주는 동의 카드.
 * 새 서버 만들기와 같은 원칙: 사용자가 직접 체크해야 버튼이 켜지고, 서버도 accepted: true 만 받는다.
 */
export function EulaCard({ serverId }: { serverId: string }) {
  const [agreed, setAgreed] = useState(false);
  const accept = useAcceptEula(serverId);
  const toast = useToast();
  const inputId = `eula-agree-${serverId}`;

  const save = () =>
    accept.mutate(undefined, {
      onSuccess: () => toast("ok", "eula.txt 에 저장했어요. 이제 레버를 당기면 켜져요", { icon: "lever" }),
      onError: (e) => toast("err", (e as Error).message),
    });

  return (
    <Callout tone="warning" title="서버를 켜려면 마인크래프트 EULA 에 동의해야 해요">
      <p>
        Minecraft 서버를 실행하려면 Mojang 의 최종 사용자 라이선스 계약(EULA)에 동의해야 해요. BlockPilot 은 대신 동의하지 않아요.{" "}
        <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-red-300 underline underline-offset-2 focus-ring">
          EULA 읽기 <ExternalLink className="h-3 w-3" />
        </a>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label htmlFor={inputId} className={cx("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm", agreed ? "slab" : "well")}>
          <input id={inputId} type="checkbox" className="peer sr-only" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span className={cx("grid h-5 w-5 shrink-0 place-items-center shadow-well peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-redstone", agreed ? "bg-redstone" : "bg-[#0d0d0f]")} aria-hidden>
            {agreed && <span className="h-2 w-2 bg-white" />}
          </span>
          <span className={agreed ? "text-white" : "text-slate-300"}>EULA 를 읽었고 동의해요</span>
        </label>
        <Button variant="primary" disabled={!agreed} loading={accept.isPending} onClick={save}>
          동의하고 저장
        </Button>
        <span className="text-[11px] text-slate-500">
          서버 폴더의 <code className="font-mono">eula.txt</code> 에 <code className="font-mono">eula=true</code> 를 써요.
        </span>
      </div>
    </Callout>
  );
}
