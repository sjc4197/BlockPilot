import { describe, it, expect } from "vitest";
import { intersectReleases, mavenPath } from "../src/services/create/sources.js";
import { parseJavaVersion } from "../src/services/create/java.js";
import { toCreateError } from "../src/services/create/errors.js";

describe("intersectReleases", () => {
  it("keeps only Mojang releases that Fabric marks stable, in manifest order", () => {
    const manifest = {
      latest: { release: "26.3", snapshot: "26.4-snapshot-4" },
      versions: [
        { id: "26.4-snapshot-4", type: "snapshot", url: "u0", sha1: "s0", releaseTime: "t0" },
        { id: "26.3", type: "release", url: "u1", sha1: "s1", releaseTime: "t1" },
        { id: "1.21.1", type: "release", url: "u2", sha1: "s2", releaseTime: "t2" },
        { id: "1.0", type: "release", url: "u3", sha1: "s3", releaseTime: "t3" },
      ],
    };
    const fabric = [
      { version: "26.4-snapshot-4", stable: false },
      { version: "26.3", stable: true },
      { version: "1.21.1", stable: true },
    ];
    expect(intersectReleases(manifest, fabric).map((r) => r.id)).toEqual(["26.3", "1.21.1"]);
  });
});

describe("mavenPath", () => {
  it("builds the maven repository layout", () => {
    expect(mavenPath("net.fabricmc:fabric-loader:0.19.5")).toBe("net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar");
    expect(mavenPath("org.ow2.asm:asm:9.10.1")).toBe("org/ow2/asm/asm/9.10.1/asm-9.10.1.jar");
    expect(mavenPath("a.b:c:1:natives")).toBe("a/b/c/1/c-1-natives.jar");
  });
});

describe("parseJavaVersion", () => {
  it("reads major versions from both old and new formats", () => {
    expect(parseJavaVersion('openjdk version "21.0.12.1" 2026-08-18 LTS')).toEqual({ version: "21.0.12.1", major: 21 });
    expect(parseJavaVersion('openjdk version "25" 2025-09-16')).toEqual({ version: "25", major: 25 });
    expect(parseJavaVersion('java version "1.8.0_392"')).toEqual({ version: "1.8.0_392", major: 8 });
    expect(parseJavaVersion("garbage")).toBeNull();
  });
});

describe("toCreateError", () => {
  it("explains common system errors in Korean", () => {
    expect(toCreateError(Object.assign(new Error("x"), { code: "ENOSPC" })).code).toBe("disk_full");
    expect(toCreateError(Object.assign(new Error("x"), { code: "EACCES" }), { path: "/tmp/a" }).message).toMatch(/권한이 없어요/);
    expect(toCreateError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }), { url: "https://meta.fabricmc.net/x" }).message).toMatch(/meta\.fabricmc\.net/);
  });
});
