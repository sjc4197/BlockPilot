import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { platform } from "../../src/services/platform/index.js";

/**
 * 테스트용 가짜 마인크래프트 서버 폴더. 이 OS 의 시작 스크립트가 node 로 fake.js 를 실행한다.
 * script 는 fake.js 본문: log(m) 으로 "[hh:mm:ss] [Server thread/INFO]: m" 을 찍고, onCommand(cmd => …) 로 입력을 받는다.
 */
export async function makeFakeServer(script: string, opts: { port?: number; files?: Record<string, string> } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-fake-"));
  const port = opts.port ?? 26000 + Math.floor(Math.random() * 2000);
  await fsp.writeFile(path.join(dir, "eula.txt"), "eula=true\n");
  await fsp.writeFile(path.join(dir, "server.properties"), `server-port=${port}\nmax-players=8\nlevel-name=world\n`);
  const prelude = `
const t = () => new Date().toTimeString().slice(0, 8);
const log = (m) => console.log("[" + t() + "] [Server thread/INFO]: " + m);
const handlers = [];
const onCommand = (fn) => handlers.push(fn);
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const c = buf.slice(0, i).trim(); buf = buf.slice(i + 1); for (const h of handlers) h(c); } });
const keep = setInterval(() => {}, 1 << 30);
const quit = (code = 0) => { clearInterval(keep); setTimeout(() => process.exit(code), 50); };
onCommand((c) => { if (c === "stop") { log("Stopping the server"); log("All dimensions are saved"); quit(0); } });
`;
  await fsp.writeFile(path.join(dir, "fake.js"), prelude + script);
  for (const [name, body] of Object.entries(opts.files ?? {})) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), body);
  }
  const name = platform.startScripts[0];
  const body = name.endsWith(".bat") ? `@echo off\r\n"${process.execPath}" fake.js\r\n` : `#!/bin/sh\ncd "$(dirname "$0")"\nexec "${process.execPath}" fake.js\n`;
  await fsp.writeFile(path.join(dir, name), body, { mode: 0o755 });
  return { dir, port, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000, what = "조건") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`시간 초과: ${what}`);
}
