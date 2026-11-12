/**
 * 브라우저 알림 (Notification API). 다른 탭·다른 창을 보고 있어도 "친구가 승인을 기다려요" 가 뜬다.
 * - 권한 요청은 사용자가 뭔가 눌렀을 때만 (브라우저 규칙). 허용/차단으로 답했으면 다시 묻지 않지만, 그냥 닫았으면(default) 다음에 또 묻는다
 * - http 로 LAN 에서 열었을 때처럼 API 가 없거나 막혀 있으면 조용히 아무것도 안 한다
 */

const ASKED_KEY = "blockpilot.notify.asked";

export const notifySupported = () => typeof window !== "undefined" && "Notification" in window && typeof Notification !== "undefined";

export const notifyPermission = (): NotificationPermission | "unsupported" => (notifySupported() ? Notification.permission : "unsupported");

function asked() {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}
function markAsked() {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    /* 저장소를 못 쓰면 다음에 또 묻는다 */
  }
}

/** 사용자 동작(클릭) 안에서만 부를 것. 이미 답했거나 전에 물어봤으면 바로 현재 상태를 돌려준다 */
export async function requestPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notifySupported()) return "unsupported";
  if (Notification.permission !== "default" || asked()) return Notification.permission;
  let result: NotificationPermission = "default";
  try {
    // 옛 사파리는 콜백 방식만 지원
    result = await new Promise<NotificationPermission>((resolve) => {
      const r = Notification.requestPermission((p) => resolve(p));
      if (r && typeof (r as Promise<NotificationPermission>).then === "function") (r as Promise<NotificationPermission>).then(resolve, () => resolve("default"));
    });
  } catch {
    result = "default";
  }
  // 허용/차단으로 답했을 때만 "물어봤음" 으로 기억. 프롬프트를 그냥 닫았으면 다음 클릭 때 다시 묻는다
  if (result !== "default") markAsked();
  return result;
}

/** 권한이 있을 때만 띄운다. 같은 tag 는 새 것으로 바뀐다 (쌓이지 않게). 누르면 이 창으로 온다 */
export function notify(title: string, body: string, opts: { tag?: string } = {}): Notification | null {
  if (!notifySupported() || Notification.permission !== "granted") return null;
  try {
    const n = new Notification(title, { body, tag: opts.tag, icon: "/favicon.svg" });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* 무시 */
      }
      n.close();
    };
    return n;
  } catch {
    return null;
  }
}
