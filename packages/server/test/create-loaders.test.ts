import { describe, it, expect } from "vitest";
import type { McRelease } from "../src/services/create/loaders/mojang.js";
import { paperReleases, pickBuilds, type FillBuild } from "../src/services/create/loaders/paper.js";
import { forgeReleases, forgeVersions } from "../src/services/create/loaders/forge.js";
import { mcToNeoPrefix, neoReleases, neoVersions } from "../src/services/create/loaders/neoforge.js";
import { stepLabels } from "../src/services/create/job.js";

const rel = (...ids: string[]): McRelease[] => ids.map((id) => ({ id, releaseTime: "t", url: "u", sha1: "s" }));
const build = (id: number, channel: FillBuild["channel"], withDownload = true): FillBuild => ({
  id,
  time: "t",
  channel,
  downloads: withDownload ? { "server:default": { name: `paper-1.21.1-${id}.jar`, url: "u", size: 1, checksums: { sha256: "a".repeat(64) } } } : {},
});

describe("Paper (Fill v3)", () => {
  it("flattens the version families, keeps Mojang releases only, and applies the 1.18 floor", () => {
    const project = { versions: { "26.3": ["26.3", "26.3-rc-3"], "1.21": ["1.21.11", "1.21.1"], "1.17": ["1.17.1"], "1.8": ["1.8.8"] } };
    const out = paperReleases(rel("26.3", "26.4-snapshot", "1.21.11", "1.21.1", "1.21.5", "1.17.1", "1.8.8"), project);
    expect(out.map((r) => r.id)).toEqual(["26.3", "1.21.11", "1.21.1"]);
  });

  it("shows STABLE builds newest first, falls back to BETA, hides ALPHA, and skips builds without a server file", () => {
    expect(pickBuilds([build(9, "STABLE"), build(133, "STABLE"), build(140, "BETA"), build(1, "ALPHA")])).toEqual([
      { version: "133", stable: true },
      { version: "9", stable: true },
    ]);
    expect(pickBuilds([build(5, "BETA"), build(12, "BETA"), build(1, "ALPHA")])).toEqual([
      { version: "12", stable: false },
      { version: "5", stable: false },
    ]);
    expect(pickBuilds([build(3, "ALPHA")])).toEqual([]);
    expect(pickBuilds([build(3, "STABLE", false)])).toEqual([]);
  });
});

describe("Forge", () => {
  const meta = {
    "1.21.1": ["1.21.1-52.0.1", "1.21.1-52.0.9", "1.21.1-52.0.10", "1.21.1-52.1.20", "1.21.1-52.1.21"],
    "1.18": ["1.18-38.0.1", "1.18-38.0.17"],
    "1.16.5": ["1.16.5-36.2.39"],
    "26.3": ["26.3-66.1.3", "26.3-66.1.5"],
  };
  const promos = { promos: { "1.21.1-recommended": "52.1.20", "1.21.1-latest": "52.1.21", "1.18-latest": "38.0.17", "26.3-recommended": "66.1.5" } };

  it("lists Mojang releases Forge has builds for, 1.18 and up", () => {
    expect(forgeReleases(rel("26.3", "1.21.1", "1.21.2", "1.18", "1.16.5"), meta).map((r) => r.id)).toEqual(["26.3", "1.21.1", "1.18"]);
  });

  it("sorts numerically (52.0.10 after 52.0.9) and recommends promos recommended → latest → newest", () => {
    const v = forgeVersions("1.21.1", meta, promos);
    expect(v.versions.map((x) => x.version).slice(0, 3)).toEqual(["1.21.1-52.1.21", "1.21.1-52.1.20", "1.21.1-52.0.10"]);
    expect(v.versions.every((x) => x.stable)).toBe(true);
    expect(v.recommended).toBe("1.21.1-52.1.20");
    expect(forgeVersions("1.18", meta, promos).recommended).toBe("1.18-38.0.17");
    expect(forgeVersions("26.3", meta, { promos: {} }).recommended).toBe("26.3-66.1.5");
    expect(forgeVersions("1.99", meta, promos)).toEqual({ versions: [], recommended: undefined });
  });
});

describe("NeoForge", () => {
  const all = ["0.25w14craftmine.3-beta", "20.2.91", "20.2.93", "21.0.167", "21.1.8", "21.1.9", "21.1.10", "21.1.265", "21.1.266-beta", "21.6.1-beta", "21.6.20-beta", "26.3.0.99", "26.3.0.100", "26.3.0.101-beta", "26.1.2.126", "26.1.0.5-beta"];

  it("maps Minecraft versions to version prefixes in both schemes", () => {
    expect(mcToNeoPrefix("1.21.1")).toBe("21.1.");
    expect(mcToNeoPrefix("1.21")).toBe("21.0.");
    expect(mcToNeoPrefix("1.21.11")).toBe("21.11.");
    expect(mcToNeoPrefix("26.3")).toBe("26.3.0.");
    expect(mcToNeoPrefix("26.1.2")).toBe("26.1.2.");
    expect(mcToNeoPrefix("26.4-snapshot-7")).toBeNull();
  });

  it("prefers stable builds, sorted numerically, and falls back to betas when a version has none", () => {
    const v = neoVersions("1.21.1", all);
    expect(v.versions.map((x) => x.version)).toEqual(["21.1.265", "21.1.10", "21.1.9", "21.1.8"]);
    expect(v.recommended).toBe("21.1.265");
    expect(v.versions.every((x) => x.stable)).toBe(true);
    // 1.21.11 (21.11.) must not pick up 1.21.1 (21.1.) builds
    expect(neoVersions("1.21.11", all).versions).toEqual([]);
    const beta = neoVersions("1.21.6", all);
    expect(beta.versions).toEqual([
      { version: "21.6.20-beta", stable: false },
      { version: "21.6.1-beta", stable: false },
    ]);
    expect(neoVersions("26.3", all).versions.map((x) => x.version)).toEqual(["26.3.0.100", "26.3.0.99"]);
    expect(neoVersions("1.21", all).versions.map((x) => x.version)).toEqual(["21.0.167"]);
  });

  it("lists Minecraft releases from 1.20.2 that have any NeoForge build", () => {
    expect(neoReleases(rel("26.3", "26.1.2", "26.1", "1.21.11", "1.21.6", "1.21.1", "1.21", "1.20.2", "1.20.1"), all).map((r) => r.id)).toEqual(["26.3", "26.1.2", "26.1", "1.21.6", "1.21.1", "1.21", "1.20.2"]);
  });
});

describe("step labels per loader", () => {
  it("names the loader step after the server type", () => {
    expect(stepLabels("fabric").loader).toBe("Fabric 설치");
    expect(stepLabels("paper").loader).toBe("Paper 받기");
    expect(stepLabels("neoforge").loader).toBe("NeoForge 설치");
    expect(stepLabels("vanilla").loader).toBe("로더 설치");
    expect(stepLabels("forge")["server-jar"]).toBe("Minecraft 서버 받기");
  });
});

describe("NeoForge version check for install", () => {
  it("accepts stable and beta versions for the right Minecraft version only, never alpha/snapshot tags", async () => {
    const { isNeoVersionFor } = await import("../src/services/create/loaders/neoforge.js");
    expect(isNeoVersionFor("1.21.1", "21.1.265")).toBe(true);
    expect(isNeoVersionFor("1.21.1", "21.1.266-beta")).toBe(true);
    expect(isNeoVersionFor("1.21.11", "21.1.265")).toBe(false);
    expect(isNeoVersionFor("1.21.1", "21.11.4-beta")).toBe(false);
    expect(isNeoVersionFor("26.1", "26.1.0.0-alpha.1+snapshot-1")).toBe(false);
    expect(isNeoVersionFor("26.1", "26.1.0.5-beta")).toBe(true);
    expect(isNeoVersionFor("1.20.1", "47.1.0")).toBe(false);
  });
});
