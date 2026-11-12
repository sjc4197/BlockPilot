import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppLogger, formatPretty, redactObject, redactText, redactUrl, rotateIfLarge, MASK } from "../src/lib/logger.js";

const SECRET = "abcdef123456SECRET";

async function tmpFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-log-"));
  return path.join(dir, "logs", "blockpilot.log");
}

describe("앱 로그 파일", () => {
  it("JSON 한 줄을 파일에 남기고 Authorization 헤더와 ?token= 은 가린다", async () => {
    const file = await tmpFile();
    const { logger, flush } = createAppLogger({ level: "info", toConsole: "none", file });
    logger.info({ req: { method: "GET", url: `/api/servers?token=${SECRET}&x=1`, headers: { authorization: `Bearer ${SECRET}`, cookie: "a=b", "sec-websocket-protocol": `bp.token.${SECRET}` } } }, "incoming request");
    logger.warn({ headers: { authorization: `Bearer ${SECRET}` }, server: "abc" }, "헤더만 따로");
    flush();
    const text = await fsp.readFile(file, "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].msg).toBe("incoming request");
    expect(lines[0].req.method).toBe("GET");
    expect(lines[0].req.url).toBe(`/api/servers?token=${MASK}&x=1`);
    expect(lines[1].headers.authorization).toBe(MASK);
    expect(lines[1].server).toBe("abc");
    expect(text).not.toContain(SECRET);
    // 나만 읽기
    if (process.platform !== "win32") expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("켤 때 파일이 크면 .1 … .keep 으로 돌린다", async () => {
    const file = await tmpFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "x".repeat(100));
    expect(rotateIfLarge(file, 1000, 2)).toBe(false);
    expect(rotateIfLarge(file, 50, 2)).toBe(true);
    expect(await fsp.readFile(`${file}.1`, "utf8")).toBe("x".repeat(100));
    await fsp.writeFile(file, "y".repeat(100));
    createAppLogger({ toConsole: "none", file, rotate: { maxBytes: 50, keep: 2 } }).flush();
    expect(await fsp.readFile(`${file}.1`, "utf8")).toBe("y".repeat(100));
    expect(await fsp.readFile(`${file}.2`, "utf8")).toBe("x".repeat(100));
    await fsp.writeFile(file, "z".repeat(100));
    createAppLogger({ toConsole: "none", file, rotate: { maxBytes: 50, keep: 2 } }).flush();
    expect(await fsp.readFile(`${file}.2`, "utf8")).toBe("y".repeat(100));
    await expect(fsp.stat(`${file}.3`)).rejects.toThrow();
  });
});

describe("redactText", () => {
  it("디스코드 웹훅은 마지막 4자만 남긴다", () => {
    const out = redactText("보냄: https://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz-1234 끝");
    expect(out).toBe("보냄: https://discord.com/api/webhooks/…/…1234 끝");
    expect(redactText("https://discordapp.com/api/webhooks/1/token_abcd")).not.toContain("token_abcd");
  });
  it("P2P 초대코드(z-base-32 80자)를 가린다", () => {
    const code = Array.from({ length: 20 }, (_, i) => "ybndrfg8ejkmcpqxot1uwisza345h769".slice(i % 28, (i % 28) + 4)).join("-");
    expect(code.replace(/-/g, "")).toHaveLength(80);
    expect(redactText(`초대코드 ${code} 입니다`)).toBe("초대코드 [초대코드 가림] 입니다");
    expect(redactText(`${code.replace(/-/g, "")}`)).toBe("[초대코드 가림]");
    // 평범한 글은 건드리지 않는다
    expect(redactText("server started on port 25565 with 8 players")).toBe("server started on port 25565 with 8 players");
  });
  it("Bearer · token= · JSON 필드 · 알려진 비밀값을 가린다", () => {
    expect(redactText(`Authorization: Bearer ${SECRET}`)).toBe(`Authorization: Bearer ${MASK}`);
    expect(redactText(`GET /x?token=${SECRET}&a=1`)).toBe(`GET /x?token=${MASK}&a=1`);
    expect(redactText(`rcon.password=hunter2`)).toBe(`rcon.password=${MASK}`);
    expect(redactText(`{"token":"${SECRET}","secret": "abc","name":"ok"}`)).toBe(`{"token":"${MASK}","secret": "${MASK}","name":"ok"}`);
    expect(redactText(`접속 토큰을 생성했습니다 → ${SECRET}`, [SECRET])).toBe(`접속 토큰을 생성했습니다 → ${MASK}`);
    // 너무 짧은 비밀값은 글을 망가뜨리므로 무시
    expect(redactText("abc def", ["abc"])).toBe("abc def");
  });
  it("redactUrl 은 경로는 두고 쿼리의 토큰만", () => {
    expect(redactUrl("/api/servers/a/backups/b/download?token=xyz")).toBe(`/api/servers/a/backups/b/download?token=${MASK}`);
    expect(redactUrl("/api/servers")).toBe("/api/servers");
  });
});

describe("redactObject", () => {
  it("설정 파일 모양에서 비밀 키만 가리고 공개키는 줄인다", () => {
    const cfg = {
      servers: [{ id: "a", name: "서버", path: "/x" }],
      auth: { token: SECRET },
      settings: {
        a: {
          automation: { discord: { webhookUrl: "https://discord.com/api/webhooks/1/abcdefgh9999" } },
          p2p: { enabled: true, keyPair: { publicKey: "ab".repeat(32), secretKey: "cd".repeat(64) }, secret: "ef".repeat(16), approved: [{ publicKey: "11".repeat(32), name: "친구" }] },
        },
      },
      p2pJoin: { remembered: { inviteCode: "ybnd".repeat(20), name: "친구서버" } },
    };
    const out = redactObject(cfg);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.auth.token).toBe(MASK);
    expect(out.settings.a.automation.discord.webhookUrl).toBe("https://discord.com/api/webhooks/…/…9999");
    expect(out.settings.a.p2p.keyPair.secretKey).toBe(MASK);
    expect(out.settings.a.p2p.keyPair.publicKey).toBe("abababab…");
    expect(out.settings.a.p2p.secret).toBe(MASK);
    expect(out.settings.a.p2p.approved[0]).toEqual({ publicKey: "11111111…", name: "친구" });
    expect(out.p2pJoin.remembered.inviteCode).toBe(MASK);
    expect(out.servers[0]).toEqual({ id: "a", name: "서버", path: "/x" });
  });
});

describe("콘솔 한 줄", () => {
  it("요청 시작은 기억만 하고 끝날 때 한 줄로 합친다", () => {
    const pending = new Map<string, string>();
    expect(formatPretty({ level: 30, time: 0, reqId: "req-1", req: { method: "GET", url: "/api/servers" }, msg: "incoming request" }, pending)).toBeNull();
    const done = formatPretty({ level: 30, time: 0, reqId: "req-1", res: { statusCode: 200 }, responseTime: 12.34, msg: "request completed" }, pending);
    expect(done).toContain("INFO");
    expect(done).toContain("GET /api/servers 200 12ms");
    expect(pending.size).toBe(0);
  });
  it("오류는 메시지와 스택 일부를 붙인다", () => {
    const out = formatPretty({ level: 50, time: 0, msg: "자동 백업 실패", server: "abc", err: { type: "Error", message: "디스크 가득", stack: "Error: 디스크 가득\n    at a (x.ts:1:1)" } });
    expect(out).toContain("ERROR 자동 백업 실패 server=abc");
    expect(out).toContain("Error: 디스크 가득");
    expect(out).toContain("at a (x.ts:1:1)");
  });
});
