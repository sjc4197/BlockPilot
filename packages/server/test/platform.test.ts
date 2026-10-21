import { describe, it, expect } from "vitest";
import { detectOs, platforms, systemInfo } from "../src/services/platform/index.js";
import { decodeWindows } from "../src/services/platform/windows.js";

describe("detectOs", () => {
  it("maps Node platforms to BlockPilot OS ids, and nothing else", () => {
    expect(detectOs("darwin")).toBe("macos");
    expect(detectOs("linux")).toBe("linux");
    expect(detectOs("win32")).toBe("windows");
    expect(detectOs("freebsd")).toBeNull();
  });

  it("describes the computer it is running on", () => {
    const s = systemInfo();
    expect(s.os).toBe(detectOs());
    expect(s.osLabel.length).toBeGreaterThan(0);
    expect(s.words.thisComputer).toMatch(/^이 /);
  });
});

describe("start scripts", () => {
  it("POSIX start.sh pins java and round-trips", () => {
    const s = platforms.linux.startScriptFor("/opt/jdk 21/bin/java", 1024, 2048);
    expect(s.name).toBe("start.sh");
    expect(s.mode).toBe(0o755);
    expect(s.body).toContain('exec "/opt/jdk 21/bin/java" -Xms1024M -Xmx2048M -jar fabric-server-launch.jar nogui');
    expect(platforms.macos.pinnedJava(s.body)).toBe("/opt/jdk 21/bin/java");
  });

  it("Windows start.bat uses CRLF, UTF-8 code page, no pause under BlockPilot, and round-trips", () => {
    const java = "C:\\Users\\서준\\.blockpilot\\runtimes\\temurin-21\\bin\\java.exe";
    const s = platforms.windows.startScriptFor(java, 2048, 4096);
    expect(s.name).toBe("start.bat");
    expect(s.body.split("\r\n").length).toBeGreaterThan(5);
    expect(s.body).not.toMatch(/[^\r]\n/);
    expect(s.body).toContain("chcp 65001");
    expect(s.body).toContain("if not defined BLOCKPILOT if errorlevel 1 pause");
    expect(platforms.windows.pinnedJava(s.body)).toBe(java);
  });
});

describe("Windows rules (checked on any OS)", () => {
  const w = platforms.windows;
  it("forbids drive roots, system folders and reserved names, case-insensitively", () => {
    expect(w.isForbidden("C:\\")).toBe(true);
    expect(w.isForbidden("d:")).toBe(true);
    expect(w.isForbidden("c:\\windows")).toBe(true);
    expect(w.isForbidden("C:\\Program Files")).toBe(true);
    expect(w.isForbidden("C:\\Minecraft\\CON")).toBe(true);
    expect(w.isForbidden("C:\\Minecraft\\servers\\survival")).toBe(false);
  });

  it("compares paths without case", () => {
    expect(w.pathKey("C:\\Users\\Me\\Server")).toBe(w.pathKey("c:\\users\\me\\server\\"));
  });

  it("hides system entries in the folder picker", () => {
    expect(w.isHiddenEntry("$RECYCLE.BIN")).toBe(true);
    expect(w.isHiddenEntry("System Volume Information")).toBe(true);
    expect(w.isHiddenEntry("Minecraft")).toBe(false);
  });

  it("reads CP949 console output when it is not valid UTF-8", () => {
    // "한글 서버" 를 CP949 로 인코딩한 바이트
    const cp949 = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xbc, 0xad, 0xb9, 0xf6]);
    expect(decodeWindows(cp949)).toBe("한글 서버");
    expect(decodeWindows(Buffer.from("한글 서버", "utf8"))).toBe("한글 서버");
  });
});

describe("Linux rules", () => {
  it("forbids system folders but allows folders under them", () => {
    expect(platforms.linux.isForbidden("/home")).toBe(true);
    expect(platforms.linux.isForbidden("/srv")).toBe(true);
    expect(platforms.linux.isForbidden("/srv/minecraft")).toBe(false);
  });

  it("reads Adoptium os/archive per OS", () => {
    expect(platforms.macos.jdk()).toMatchObject({ os: "mac", archive: "tar.gz" });
    expect(platforms.windows.jdk()).toMatchObject({ os: "windows", archive: "zip", javaRel: ["bin/java.exe"] });
    expect(["linux", "alpine-linux"]).toContain(platforms.linux.jdk().os);
  });
});

describe.runIf(process.platform !== "win32")("POSIX killTree", () => {
  it("kills the script and the process it started (no exec), via the process group", async () => {
    const { spawn } = await import("node:child_process");
    const { platform } = await import("../src/services/platform/index.js");
    // exec 없이 자식을 띄우는 스크립트: 예전 방식(스크립트만 kill)으로는 자식이 남는다
    const child = spawn("/bin/sh", ["-c", `"${process.execPath}" -e "setTimeout(()=>{},60000)" & echo $!; wait`], { ...platform.spawnOptions(), stdio: ["ignore", "pipe", "ignore"] });
    const grandPid = await new Promise<number>((r) => child.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive(grandPid)).toBe(true);
    platform.killTree(child, true);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(grandPid)).toBe(false);
  });
});

describe("scriptCommand runs this OS's start scripts for real", () => {
  // Windows 에서 `cmd /c start.bat` 은 내장 명령 START 로 읽혀 스크립트가 안 돌고 멈춘다 → 실제로 실행해서 확인
  it.each(["start", "run"])("%s script runs from a folder with a space and Korean in its name", async (base) => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { platform } = await import("../src/services/platform/index.js");
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bp-script-"));
    const dir = path.join(root, "내 서버 1");
    await fsp.mkdir(dir);
    try {
      const name = platform.startScripts.find((s) => s.startsWith(base))!;
      const body = name.endsWith(".bat") ? "@echo off\r\necho script-ran-ok\r\n" : "#!/bin/sh\necho script-ran-ok\n";
      await fsp.writeFile(path.join(dir, name), body, { mode: 0o755 });
      const { cmd, args, verbatim } = platform.scriptCommand(name);
      const child = spawn(cmd, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], ...platform.spawnOptions(), windowsVerbatimArguments: verbatim });
      let out = "";
      child.stdout!.on("data", (d) => (out += d));
      child.stderr!.on("data", (d) => (out += d));
      const code = await new Promise<number | null>((resolve, reject) => {
        const t = setTimeout(() => {
          platform.killTree(child, true);
          reject(new Error(`스크립트가 끝나지 않음. 출력: ${out}`));
        }, 15_000);
        child.once("exit", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      expect(out).toContain("script-ran-ok");
      expect(code).toBe(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
