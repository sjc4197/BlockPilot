import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { BackupSettings } from "@blockpilot/shared";
import { useBackups, useCreateBackup, useDeleteBackup, useRestoreBackup, useSaveBackupSettings, useServer } from "../api/hooks";
import { withToken } from "../api/client";
import { btn, card, cx, input, ConfirmButton, EmptyState, Spinner, Toggle, useToast } from "../lib/ui";

const INTERVALS = [
  { value: 0, label: "끔" },
  { value: 30, label: "30분" },
  { value: 60, label: "1시간" },
  { value: 180, label: "3시간" },
  { value: 360, label: "6시간" },
  { value: 720, label: "12시간" },
  { value: 1440, label: "24시간" },
];

export default function Backups() {
  const { id = "" } = useParams();
  const { data, isLoading } = useBackups(id);
  const { data: server } = useServer(id);
  const create = useCreateBackup(id);
  const del = useDeleteBackup(id);
  const restore = useRestoreBackup(id);
  const saveSettings = useSaveBackupSettings(id);
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [settings, setSettings] = useState<BackupSettings | null>(null);

  useEffect(() => {
    if (data && !settings) setSettings(data.status.settings);
  }, [data, settings]);

  const stopped = server?.process.state === "stopped";
  const onErr = (e: unknown) => toast("err", (e as Error).message);
  const settingsDirty = !!data && !!settings && JSON.stringify(settings) !== JSON.stringify(data.status.settings);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">백업</h1>
        <p className="mt-1 text-sm text-slate-400">
          월드 폴더{data?.worlds.length ? ` (${data.worlds.join(", ")})` : ""}를 zip 으로 <code className="text-slate-300">backups/</code> 에 저장합니다. 실행 중이면 먼저 save-all 로 저장을 강제해요.
        </p>
      </header>

      <section className={cx(card, "flex flex-wrap items-end gap-3")}>
        <div className="flex-1 min-w-48">
          <label className="mb-1 block text-xs text-slate-400">이름표 (선택)</label>
          <input className={input} placeholder="예: 네더-가기-전" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <button
          className={cx(btn.base, btn.primary)}
          disabled={create.isPending}
          onClick={() =>
            create.mutate(label || undefined, {
              onSuccess: (b) => {
                toast("ok", `${b.file} (${(b.sizeBytes / 1024 / 1024).toFixed(1)} MB) 백업 완료`);
                setLabel("");
              },
              onError: onErr,
            })
          }
        >
          {create.isPending ? "백업 중..." : "지금 백업"}
        </button>
      </section>

      {settings && (
        <section className={card}>
          <h2 className="mb-3 font-semibold">자동 백업</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-slate-400">간격</label>
              <select className={input} value={settings.intervalMinutes} onChange={(e) => setSettings({ ...settings, intervalMinutes: Number(e.target.value) })}>
                {INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">보관 개수 (자동 백업만)</label>
              <input type="number" className={input} min={1} max={500} value={settings.keep} onChange={(e) => setSettings({ ...settings, keep: Number(e.target.value) || 1 })} />
            </div>
            <div className="flex items-center gap-3 pt-5">
              <Toggle checked={settings.whenStopped} onChange={(v) => setSettings({ ...settings, whenStopped: v })} />
              <span className="text-sm">서버가 꺼져 있어도 백업</span>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>
              {data?.status.lastRunAt && `마지막: ${new Date(data.status.lastRunAt).toLocaleString()}`}
              {data?.status.nextRunAt && ` · 다음: ${new Date(data.status.nextRunAt).toLocaleString()}`}
              {data?.status.lastError && <span className="text-red-300"> · 오류: {data.status.lastError}</span>}
              {data?.status.running && " · 백업 진행 중"}
            </span>
            <button
              className={cx(btn.base, btn.primary)}
              disabled={!settingsDirty || saveSettings.isPending}
              onClick={() => saveSettings.mutate(settings, { onSuccess: () => toast("ok", "자동 백업 설정을 저장했습니다."), onError: onErr })}
            >
              설정 저장
            </button>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-semibold">백업 목록</h2>
        {isLoading ? (
          <Spinner />
        ) : !data?.backups.length ? (
          <EmptyState>아직 백업이 없습니다.</EmptyState>
        ) : (
          <ul className={cx(card, "divide-y divide-slate-800 p-0")}>
            {data.backups.map((b) => (
              <li key={b.file} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <div className="truncate console-font text-sm">{b.file}</div>
                  <div className="text-xs text-slate-500">
                    {(b.sizeBytes / 1024 / 1024).toFixed(1)} MB · {new Date(b.createdAt).toLocaleString()}
                    {b.scheduled && <span className="ml-2 rounded bg-slate-800 px-1.5 py-px text-[10px]">자동</span>}
                  </div>
                </div>
                <a className={cx(btn.base, btn.ghost)} href={withToken(`/api/servers/${id}/backups/${encodeURIComponent(b.file)}/download`)}>
                  다운로드
                </a>
                <ConfirmButton
                  label="복원"
                  confirmLabel="현재 월드를 덮어씁니다. 진행?"
                  disabled={!stopped || restore.isPending}
                  onConfirm={() =>
                    restore.mutate(b.file, {
                      onSuccess: (r) => toast("ok", `${r.restored.join(", ")} 복원 완료. 이전 월드는 ${r.previousMovedTo} 에 옮겨뒀어요.`),
                      onError: onErr,
                    })
                  }
                />
                <ConfirmButton label="삭제" confirmLabel="정말 삭제?" className={btn.ghost} onConfirm={() => del.mutate(b.file, { onError: onErr })} />
              </li>
            ))}
          </ul>
        )}
        {!stopped && <p className="mt-2 text-xs text-amber-300">복원은 서버를 중지한 뒤에만 할 수 있어요.</p>}
      </section>
    </div>
  );
}
