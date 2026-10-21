import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Archive, LogOut, X } from "lucide-react";
import type { ServerSummary } from "@blockpilot/shared";
import { useDeleteServer, useRemoveServer } from "../api/hooks";
import { TntIcon } from "../lib/pixel";
import { burst, flash } from "../lib/burst";
import { Button, Callout, Card, ConfirmButton, Field, Input, SectionTitle, cx, useToast, type IconType } from "../lib/ui";

const BigTnt: IconType = ({ className }) => <TntIcon className={className} />;
const PrimedTnt: IconType = ({ className }) => <TntIcon className={className} primed />;

/** 서버 설정 맨 아래: 등록 해제(파일 유지)와 서버 삭제(폴더째 삭제)를 나란히 두어 차이가 보이게 */
export function ServerDanger({ server }: { server: ServerSummary }) {
  const remove = useRemoveServer();
  const toast = useToast();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const stopped = server.process.state === "stopped";

  return (
    <Card className="space-y-4">
      <SectionTitle>서버 관리</SectionTitle>

      <div className="well flex flex-wrap items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="font-block text-[12px] text-white">목록에서 등록 해제</div>
          <p className="mt-1 text-sm text-slate-400">BlockPilot 목록에서만 빼요. 서버 폴더와 월드는 그대로 남아서 나중에 다시 추가할 수 있어요.</p>
        </div>
        <ConfirmButton
          icon={LogOut}
          label="등록 해제"
          confirmLabel="해제할까요?"
          disabled={!stopped}
          onConfirm={() =>
            remove.mutate(server.id, {
              onSuccess: () => {
                toast("info", `'${server.name}' 을(를) 목록에서 뺐어요. 서버 파일은 그대로 있어요.`);
                navigate("/");
              },
              onError: (e) => toast("err", (e as Error).message),
            })
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#1f0a08] px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,59,47,.35)]">
        <div className="min-w-0">
          <div className="font-block text-[12px] text-red-300">서버 삭제</div>
          <p className="mt-1 text-sm text-slate-400">서버 폴더를 통째로 지워요. 월드·모드·설정·백업까지 전부 사라지고 되돌릴 수 없어요.</p>
        </div>
        <Button variant="danger" icon={BigTnt} disabled={!stopped} onClick={() => setDeleting(true)}>
          서버 삭제…
        </Button>
      </div>
      {!stopped && <p className="text-[12px] text-amber-300">서버가 켜져 있는 동안에는 등록 해제·삭제를 할 수 없어요. 레버를 내려 서버를 먼저 꺼 주세요.</p>}

      {deleting && <DeleteDialog server={server} onClose={() => setDeleting(false)} />}
    </Card>
  );
}

function DeleteDialog({ server, onClose }: { server: ServerSummary; onClose: () => void }) {
  const del = useDeleteServer(server.id);
  const toast = useToast();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const stopped = server.process.state === "stopped";
  const matches = typed === server.name;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !del.isPending && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, del.isPending]);

  // 연출 5: 영구 삭제를 누르면 TNT 가 깜빡이며 부풀고(삭제 진행), 끝나면 터진다. 실패하면 터지지 않고 원인을 보여 준다
  const tntRef = useRef<HTMLSpanElement>(null);
  const [fuse, setFuse] = useState(false);
  const [boom, setBoom] = useState(false);
  const submit = () => {
    const lit = Date.now();
    setFuse(true);
    del.mutate(typed, {
      onSuccess: (r) => {
        const explode = () => {
          setFuse(false);
          setBoom(true);
          const box = tntRef.current?.getBoundingClientRect();
          flash();
          if (box) burst(box.left + box.width / 2, box.top + box.height / 2, { count: 34, colors: ["#f2efe6", "#bdbdbd", "#8f8f8f", "#ffb347", "#d93a2b", "#5e5e5e"], spread: 150, size: [4, 8], ring: true });
          toast("ok", `'${server.name}' 서버 폴더를 삭제했어요.`, { icon: "tnt" });
          if (r.removedLink) toast("info", `등록에 쓰던 링크 ${r.removedLink} 도 지웠어요.`);
          setTimeout(() => navigate("/"), 650);
        };
        // 삭제가 금방 끝나도 심지가 타는 게 보이도록 최소 1.2초
        setTimeout(explode, Math.max(0, 1200 - (Date.now() - lit)));
      },
      onError: () => setFuse(false),
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal aria-label="서버 삭제" onMouseDown={(e) => e.target === e.currentTarget && !del.isPending && onClose()}>
      <div className="glass w-[min(560px,96vw)]">
        <header className="flex items-center justify-between px-5 py-3 shadow-[inset_0_-2px_0_#08080a]">
          <h2 className="flex items-center gap-2.5 font-block text-[12px] text-white">
            <span ref={tntRef} className={cx("inline-block h-5 w-5", fuse && "tnt-fuse", boom && "invisible")}>
              <TntIcon className="h-5 w-5" />
            </span>
            {fuse ? "심지에 불이 붙었어요…" : boom ? "삭제했어요" : "서버를 완전히 삭제할까요?"}
          </h2>
          <Button size="sm" variant="ghost" icon={X} onClick={onClose} disabled={del.isPending} aria-label="닫기" />
        </header>

        <div className="space-y-4 px-5 py-4">
          <div>
            <div className="mb-1.5 font-block text-[12px] text-slate-400">지워지는 폴더</div>
            <div className="well break-all px-3 py-2 font-mono text-[12px] text-slate-200">{server.path}</div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
            <li>월드({server.levelName}), 모드, 설정 파일, 로그가 모두 지워져요.</li>
            <li>
              이 폴더 안의 <code className="font-mono">backups/</code> 에 있는 백업도 함께 지워져요.
            </li>
            <li>휴지통으로 가지 않아서 되돌릴 수 없어요.</li>
          </ul>
          <Link to={`/s/${server.id}/backups`} onClick={onClose} className="inline-flex items-center gap-1.5 text-sm text-red-300 underline underline-offset-2">
            <Archive className="h-3.5 w-3.5" /> 먼저 백업 화면에서 월드를 다운로드해 두기
          </Link>

          {!stopped && <Callout tone="warning">서버가 켜져 있어요. 레버를 내려 서버를 끈 뒤 삭제할 수 있어요.</Callout>}

          <Field label={<span>확인을 위해 서버 이름 <b className="text-white">{server.name}</b> 을(를) 그대로 입력하세요</span>}>
            <Input id="del-confirm" autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && matches && stopped && !fuse && !boom && submit()} />
          </Field>

          {del.error && <Callout tone="danger">{(del.error as Error).message}</Callout>}
        </div>

        <footer className="flex justify-end gap-2 px-5 py-3 shadow-[inset_0_2px_0_#08080a]">
          <Button variant="ghost" onClick={onClose} disabled={del.isPending}>
            취소
          </Button>
          <Button variant="danger" icon={matches ? PrimedTnt : BigTnt} disabled={!matches || !stopped || fuse || boom} loading={del.isPending} onClick={submit}>
            영구 삭제
          </Button>
        </footer>
      </div>
    </div>
  );
}
