import { spawn } from "node:child_process";

/**
 * 운영체제 알림 (호스트 컴퓨터 화면 구석에 뜨는 그것).
 * 대시보드를 보고 있지 않아도 "친구가 승인을 기다려요" 를 알 수 있게.
 * - macOS: osascript display notification
 * - Windows: PowerShell 토스트 (WinRT ToastNotificationManager)
 * - Linux: notify-send (있을 때만)
 * 실패해도 조용히 넘어간다. BLOCKPILOT_NO_NOTIFY=1 이면 아예 안 띄운다.
 */

export interface NotifyCommand {
  cmd: string;
  args: string[];
}

const MAX_LEN = 200;

/** 줄바꿈·제어 문자를 지우고 길이를 자른다 (알림 한 칸에 들어갈 만큼만) */
function clean(s: string) {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 1)}…` : t;
}

/** AppleScript 문자열 리터럴: 백슬래시와 큰따옴표만 이스케이프 */
export function escapeAppleScript(s: string) {
  return clean(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 토스트 XML 속 텍스트: XML 특수문자. 작은따옴표도 바꿔서 PowerShell '...' 안에 그대로 넣을 수 있게 */
export function escapeXml(s: string) {
  return clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// 패키지 앱이 아닌 프로그램은 등록된 AppUserModelId 가 있어야 토스트가 보인다 → PowerShell 의 것을 빌려 쓴다
const PS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

export function buildToastScript(title: string, body: string) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`;
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${xml}')`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${PS_APP_ID}').Show($toast)`,
  ].join("\n");
}

/** 실행할 명령과 인자. 셸을 거치지 않고 spawn 하므로 셸 이스케이프는 필요 없다. 모르는 OS 면 null */
export function buildNotifyCommand(platform: NodeJS.Platform | string, title: string, body: string): NotifyCommand | null {
  switch (platform) {
    case "darwin":
      return { cmd: "osascript", args: ["-e", `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`] };
    case "win32":
      // -EncodedCommand: 따옴표·한글이 명령줄 인자 규칙에 걸리지 않게 UTF-16LE base64 로 통째로 넘긴다
      return {
        cmd: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(buildToastScript(title, body), "utf16le").toString("base64")],
      };
    case "linux":
      return { cmd: "notify-send", args: ["-a", "BlockPilot", clean(title), clean(body)] };
    default:
      return null;
  }
}

export const notifyDisabled = () => process.env.BLOCKPILOT_NO_NOTIFY === "1" || process.env.NODE_ENV === "test";

/** OS 알림을 띄운다. 없는 명령·오류는 모두 무시 (알림은 덤이지 서버 동작이 아니다) */
export function osNotify(title: string, body: string) {
  if (notifyDisabled()) return;
  const c = buildNotifyCommand(process.platform, title, body);
  if (!c) return;
  try {
    const child = spawn(c.cmd, c.args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    // PowerShell 이 멈춰 있어도 BlockPilot 종료를 막지 않게
    const t = setTimeout(() => child.kill(), 15_000);
    t.unref();
    child.on("exit", () => clearTimeout(t));
    child.unref();
  } catch {
    /* 무시 */
  }
}

// ---------- 같은 일로 자꾸 띄우지 않기 ----------

/** key → 마지막으로 알린 시각. 다시 적을 때 지웠다 넣어 "오래된 순" 으로 유지한다 */
const lastNotified = new Map<string, number>();
export const NOTIFY_THROTTLE_MS = 2 * 60_000;
/** 기억하는 key 의 상한. 넘치면 가장 오래된 것부터 지운다 (친구 키마다 끝없이 쌓이지 않게) */
export const NOTIFY_KEYS_MAX = 500;

/**
 * 모든 key 가 windowMs 안에 알린 적이 없을 때만 true 를 돌려주고 그 시각을 적는다. (시험용으로 now 를 넣을 수 있다)
 * key 를 여러 개 주면(예: 서버 + 친구) 하나라도 막히면 아무것도 적지 않는다 — 막힌 알림이 다른 key 의 창을 쓰지 않게.
 */
export function shouldNotify(key: string | string[], now = Date.now(), windowMs = NOTIFY_THROTTLE_MS) {
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) {
    const last = lastNotified.get(k);
    if (last !== undefined && now - last < windowMs) return false;
  }
  for (const k of keys) {
    lastNotified.delete(k);
    lastNotified.set(k, now);
  }
  while (lastNotified.size > NOTIFY_KEYS_MAX) lastNotified.delete(lastNotified.keys().next().value!);
  return true;
}

/** 시험용: 기억하고 있는 key 수 */
export function notifyKeyCount() {
  return lastNotified.size;
}

/** 시험용 */
export function resetNotifyThrottle() {
  lastNotified.clear();
}

/** key(들) 당 2분에 한 번만 OS 알림 */
export function osNotifyThrottled(key: string | string[], title: string, body: string) {
  if (!shouldNotify(key)) return false;
  osNotify(title, body);
  return true;
}
