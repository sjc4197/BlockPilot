import { describe, it, expect } from "vitest";
import { compareVersionStrings, sortVersionsDesc, versionAtLeast } from "../src/lib/version.js";
import { neoForgeToMc } from "../src/services/serverInfo.js";

describe("version helpers", () => {
  it("compares numerically, not as strings", () => {
    expect(compareVersionStrings("61.0.10", "61.0.8")).toBeGreaterThan(0);
    expect(compareVersionStrings("26.3.0.100", "26.3.0.99")).toBeGreaterThan(0);
    expect(compareVersionStrings("1.21.11", "1.21.9")).toBeGreaterThan(0);
    expect(compareVersionStrings("21.1.265-beta", "21.1.265")).toBeLessThan(0);
  });

  it("sorts newest first and keeps unparsable names last", () => {
    expect(sortVersionsDesc(["0.16.9", "0.16.10", "0.15.0", "weird"], (s) => s)).toEqual(["0.16.10", "0.16.9", "0.15.0", "weird"]);
  });

  it("checks a floor across the 1.x and year-based Minecraft version schemes", () => {
    expect(versionAtLeast("1.18", "1.18")).toBe(true);
    expect(versionAtLeast("1.17.1", "1.18")).toBe(false);
    expect(versionAtLeast("1.21.11", "1.18")).toBe(true);
    expect(versionAtLeast("26.3", "1.18")).toBe(true);
    expect(versionAtLeast("1.20.2", "1.20.2")).toBe(true);
    expect(versionAtLeast("1.20.1", "1.20.2")).toBe(false);
    expect(versionAtLeast("nope", "1.18")).toBe(false);
  });
});

describe("neoForgeToMc", () => {
  it("maps NeoForge versions to Minecraft versions in both schemes", () => {
    expect(neoForgeToMc("21.1.265")).toBe("1.21.1");
    expect(neoForgeToMc("21.0.167")).toBe("1.21");
    expect(neoForgeToMc("20.2.93")).toBe("1.20.2");
    expect(neoForgeToMc("21.11.4-beta")).toBe("1.21.11");
    expect(neoForgeToMc("26.3.0.102")).toBe("26.3");
    expect(neoForgeToMc("26.1.2.126")).toBe("26.1.2");
    expect(neoForgeToMc("0.25w14craftmine.3-beta")).toBeUndefined();
  });
});
