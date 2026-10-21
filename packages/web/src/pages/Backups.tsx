import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Archive, Clock, Download, HardDriveDownload, History, Trash2 } from "lucide-react";
import type { BackupSettings } from "@blockpilot/shared";
import { useBackups, useCreateBackup, useDeleteBackup, useRestoreBackup, useSaveBackupSettings, useServer } from "../api/hooks";
import { withToken } from "../api/client";
import { Badge, Button, Callout, Card, ConfirmButton, EmptyState, Field, Input, LinkButton, PageHeader, Select, Spinner, Toggle, fmtBytes, fmtDate, useToast } from "../lib/ui";

const INTERVALS = [
  { value: 0, label: "끔" },
  { value: 30, label: "30분마다" },
  { value: 60, label: "1시간마다" },
  { value: 180, label: "3시간마다" },
  { value: 360, label: "6시간마다" },
  { value: 720, label: "12시간마다" },
  { value: 1440, label: "하루에 한 번" },
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
  const totalSize = data?.backups.reduce((a, b) => a + b.sizeBytes, 0) ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Archive}
        title="백업"
        description={
          <span>
            월드 폴더{data?.worlds.length ? ` (${data.worlds.join(", ")})` : ""}를 zip 으로 <code className="font-mono text-slate-300">backups/</code> 에 저장해요. 실행 중이면 먼저 save-all 로 저장을 강제합니다.
          </span>
        }
        actions={data && <Badge>{data.backups.length}개 · {fmtBytes(totalSize)}</Badge>}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-block text-[12px] text-slate-200">
            <HardDriveDownload className="h-4 w-4 text-redstone" /> 지금 백업
          </h2>
          <div className="flex items-end gap-3">
            <Field label="이름표 (선택)" className="flex-1">
              <Input placeholder="예: 네더-가기-전" value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() =>
                create.mutate(label || undefined, {
                  onSuccess: (b) => {
                    toast("ok", `${b.file} (${fmtBytes(b.sizeBytes)}) 백업 완료`, { icon: "chest", first: "backup" });
                    setLabel("");
                  },
                  onError: onErr,
                })
              }
            >
              백업 만들기
            </Button>
          </div>
        </Card>

        {settings && (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-block text-[12px] text-slate-200">
                <Clock className="h-4 w-4 text-redstone" /> 자동 백업
              </h2>
              <Badge tone={settings.intervalMinutes > 0 ? "lamp" : "neutral"}>{settings.intervalMinutes > 0 ? "켜짐" : "꺼짐"}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="간격">
                <Select value={settings.intervalMinutes} onChange={(e) => setSettings({ ...settings, intervalMinutes: Number(e.target.value) })}>
                  {INTERVALS.map((i) => (
                    <option key={i.value} value={i.value}>
                      {i.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="보관 개수" hint="자동 백업만 셈">
                <Input type="number" min={1} max={500} value={settings.keep} onChange={(e) => setSettings({ ...settings, keep: Number(e.target.value) || 1 })} />
              </Field>
            </div>
            <label className="mt-3 flex items-center justify-between well px-3 py-2 text-sm">
              <span className="text-slate-300">서버가 꺼져 있어도 백업</span>
              <Toggle size="sm" checked={settings.whenStopped} onChange={(v) => setSettings({ ...settings, whenStopped: v })} />
            </label>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500 tnum">
                {data?.status.lastRunAt && `마지막 ${fmtDate(data.status.lastRunAt)}`}
                {data?.status.nextRunAt && ` · 다음 ${fmtDate(data.status.nextRunAt)}`}
                {data?.status.running && " · 진행 중"}
              </span>
              <Button size="sm" variant="primary" disabled={!settingsDirty} loading={saveSettings.isPending} onClick={() => saveSettings.mutate(settings, { onSuccess: () => toast("ok", "자동 백업 설정을 저장했습니다.", { icon: "book" }), onError: onErr })}>
                설정 저장
              </Button>
            </div>
            {data?.status.lastError && (
              <div className="mt-3">
                <Callout tone="danger">{data.status.lastError}</Callout>
              </div>
            )}
          </Card>
        )}
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-block text-[12px] text-slate-200">백업 목록</h2>
          {!stopped && <span className="text-xs text-amber-300">복원은 서버를 중지한 뒤에만 가능해요</span>}
        </div>
        {isLoading ? (
          <Spinner />
        ) : !data?.backups.length ? (
          <EmptyState icon={Archive} title="아직 백업이 없어요">
            위에서 "백업 만들기"를 누르거나 자동 백업을 켜 두세요.
          </EmptyState>
        ) : (
          <Card padded={false} className="divide-y-2 divide-bevel-lo">
            {data.backups.map((b) => (
              <div key={b.file} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="well grid h-9 w-9 shrink-0 place-items-center text-slate-400">
                  <Archive className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-white">{b.file}</span>
                    {b.scheduled && <Badge tone="brand">자동</Badge>}
                  </div>
                  <div className="text-[11px] text-slate-500 tnum">
                    {fmtBytes(b.sizeBytes)} · {fmtDate(b.createdAt)}
                  </div>
                </div>
                <LinkButton size="sm" variant="ghost" icon={Download} href={withToken(`/api/servers/${id}/backups/${encodeURIComponent(b.file)}/download`)}>
                  다운로드
                </LinkButton>
                <ConfirmButton
                  size="sm"
                  icon={History}
                  label="복원"
                  confirmLabel="현재 월드를 덮어씁니다. 진행?"
                  disabled={!stopped || restore.isPending}
                  onConfirm={() =>
                    restore.mutate(b.file, {
                      onSuccess: (r) => toast("ok", `${r.restored.join(", ")} 복원 완료. 이전 월드는 ${r.previousMovedTo} 에 옮겨뒀어요.`, { icon: "chest" }),
                      onError: onErr,
                    })
                  }
                />
                <ConfirmButton size="sm" variant="ghost" icon={Trash2} label="삭제" confirmLabel="정말 삭제?" onConfirm={() => del.mutate(b.file, { onError: onErr })} />
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
