import { describe, it, expect, beforeEach } from "vitest";
import { NOTIFY_KEYS_MAX, buildNotifyCommand, buildToastScript, escapeAppleScript, escapeXml, notifyDisabled, notifyKeyCount, resetNotifyThrottle, shouldNotify } from "../src/services/notify.js";

/** OS 알림: 실제로 띄우지 않고 만들어진 명령·인자만 검사한다 */
describe("os notify command", () => {
  const title = `친구 "철수" 접속 요청`;
  const body = `ab12cd34 님이 \\승인을\n기다려요 <b>&'x'`;

  it("macOS: osascript with AppleScript-escaped quotes and backslashes, no newlines", () => {
    const c = buildNotifyCommand("darwin", title, body)!;
    expect(c.cmd).toBe("osascript");
    expect(c.args[0]).toBe("-e");
    const script = c.args[1];
    expect(script).toBe(`display notification "ab12cd34 님이 \\\\승인을 기다려요 <b>&'x'" with title "친구 \\"철수\\" 접속 요청"`);
    expect(script).not.toContain("\n");
    expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("Windows: hidden non-interactive PowerShell with an encoded toast script, XML-escaped text", () => {
    const c = buildNotifyCommand("win32", title, body)!;
    expect(c.cmd).toBe("powershell.exe");
    expect(c.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]);
    expect(c.args[4]).toBe("-EncodedCommand");
    const script = Buffer.from(c.args[5], "base64").toString("utf16le");
    expect(script).toBe(buildToastScript(title, body));
    expect(script).toContain("<text>친구 &quot;철수&quot; 접속 요청</text>");
    expect(script).toContain("<text>ab12cd34 님이 \\승인을 기다려요 &lt;b&gt;&amp;&apos;x&apos;</text>");
    // 작은따옴표 문자열 안에 들어가므로 XML 안에 ' 가 남아 있으면 안 된다
    const xml = script.match(/LoadXml\('(.*)'\)/)![1];
    expect(xml).not.toContain("'");
    expect(script).toContain("ToastNotificationManager");
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });

  it("Linux: notify-send with the app name; unknown platforms get nothing", () => {
    const c = buildNotifyCommand("linux", "제목", "본문\n둘째 줄")!;
    expect(c).toEqual({ cmd: "notify-send", args: ["-a", "BlockPilot", "제목", "본문 둘째 줄"] });
    expect(buildNotifyCommand("freebsd", "a", "b")).toBeNull();
  });

  it("truncates very long text", () => {
    const c = buildNotifyCommand("linux", "t", "x".repeat(1000))!;
    expect(c.args[3].length).toBeLessThanOrEqual(200);
    expect(c.args[3].endsWith("…")).toBe(true);
  });

  it("is off under BLOCKPILOT_NO_NOTIFY=1 (and in tests)", () => {
    expect(notifyDisabled()).toBe(true);
    const prevEnv = process.env.NODE_ENV;
    const prevNoNotify = process.env.BLOCKPILOT_NO_NOTIFY;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.BLOCKPILOT_NO_NOTIFY;
      expect(notifyDisabled()).toBe(false);
      process.env.BLOCKPILOT_NO_NOTIFY = "1";
      expect(notifyDisabled()).toBe(true);
    } finally {
      // 다른 테스트가 실제 OS 알림을 띄우지 않게 원래 값으로 되돌린다 (setup.ts 가 "1" 로 둔다)
      if (prevNoNotify === undefined) delete process.env.BLOCKPILOT_NO_NOTIFY;
      else process.env.BLOCKPILOT_NO_NOTIFY = prevNoNotify;
      process.env.NODE_ENV = prevEnv;
    }
    expect(process.env.BLOCKPILOT_NO_NOTIFY).toBe("1");
  });
});

describe("notify throttle", () => {
  beforeEach(() => resetNotifyThrottle());

  it("allows one notification per key per 2 minutes", () => {
    const t0 = 1_000_000;
    expect(shouldNotify("s1:peerA", t0)).toBe(true);
    expect(shouldNotify("s1:peerA", t0 + 1000)).toBe(false);
    expect(shouldNotify("s1:peerA", t0 + 119_000)).toBe(false);
    expect(shouldNotify("s1:peerB", t0 + 1000)).toBe(true);
    expect(shouldNotify("s1:peerA", t0 + 120_000)).toBe(true);
    expect(shouldNotify("s1:peerA", t0 + 121_000)).toBe(false);
  });

  it("with several keys (server + friend) every key must be free, and a blocked call records nothing", () => {
    const t0 = 1_000_000;
    expect(shouldNotify(["s1", "s1:peerA"], t0)).toBe(true);
    // 같은 서버에 다른 친구: 서버 창에 막힌다. 막혔으니 peerB 의 창도 열리지 않는다
    expect(shouldNotify(["s1", "s1:peerB"], t0 + 1000)).toBe(false);
    expect(shouldNotify("s1:peerB", t0 + 2000)).toBe(true);
    // 서버 창이 지나도 같은 친구는 아직 막힌다
    expect(shouldNotify(["s1", "s1:peerB"], t0 + 120_000)).toBe(false);
    expect(shouldNotify(["s1", "s1:peerA"], t0 + 120_000)).toBe(true);
  });

  it("keeps at most 500 keys, evicting the oldest first", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < NOTIFY_KEYS_MAX + 20; i++) shouldNotify(`k${i}`, t0 + i);
    expect(notifyKeyCount()).toBe(NOTIFY_KEYS_MAX);
    // 가장 오래된 k0..k19 는 잊혔으니 바로 다시 알릴 수 있고 (그만큼 k20, k21 이 또 밀려난다), 최근 것은 아직 막힌다
    expect(shouldNotify("k0", t0 + 1000)).toBe(true);
    expect(shouldNotify("k19", t0 + 1000)).toBe(true);
    expect(shouldNotify("k30", t0 + 1000)).toBe(false);
    expect(shouldNotify(`k${NOTIFY_KEYS_MAX + 19}`, t0 + 1000)).toBe(false);
    expect(notifyKeyCount()).toBe(NOTIFY_KEYS_MAX);
  });
});
