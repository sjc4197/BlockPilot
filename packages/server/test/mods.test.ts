import { describe, it, expect } from "vitest";
import { satisfies, parseVersion, compareVersions } from "../src/services/mods.js";

describe("parseVersion", () => {
  it("strips build metadata but keeps prerelease identifiers", () => {
    expect(parseVersion("0.116.15+1.21.1")).toEqual({ core: [0, 116, 15], pre: null });
    expect(parseVersion("5.1.3-beta")).toEqual({ core: [5, 1, 3], pre: ["beta"] });
    expect(parseVersion("1.21.1-Fabric-5.1.8")).toEqual({ core: [1, 21, 1], pre: ["Fabric-5", "1", "8"] });
    expect(parseVersion("abc")).toBeNull();
  });
});

describe("compareVersions", () => {
  const v = (s: string) => parseVersion(s)!;
  it("orders prerelease identifiers like semver", () => {
    expect(compareVersions(v("1.21.1-Fabric-5.1.8"), v("1.21.1-Fabric-5.1.3"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.21.1-Fabric-5.1.0"), v("1.21.1-Fabric-5.1.3"))).toBeLessThan(0);
    expect(compareVersions(v("1.21.1"), v("1.21.1-Fabric-5.1.3"))).toBeGreaterThan(0); // 프리릴리즈 없는 쪽이 큼
    expect(compareVersions(v("1.0.0-alpha"), v("1.0.0-beta"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0-alpha.1"), v("1.0.0-alpha"))).toBeGreaterThan(0);
  });
});

describe("YUNG-style versions (core identical, real version after the dash)", () => {
  // 실제 겪은 케이스: Better Dungeons 5.1.3 이 yungsapi >=1.21.1-Fabric-5.1.3 을 요구
  it("does not report an outdated YUNG's API as satisfied", () => {
    expect(satisfies("1.21.1-Fabric-5.1.0", ">=1.21.1-Fabric-5.1.3")).toBe(false);
    expect(satisfies("1.21.1-Fabric-5.1.3", ">=1.21.1-Fabric-5.1.3")).toBe(true);
    expect(satisfies("1.21.1-Fabric-5.1.8", ">=1.21.1-Fabric-5.1.3")).toBe(true);
  });
});

describe("satisfies", () => {
  it("handles wildcard and comparison operators", () => {
    expect(satisfies("15.0.140", "*")).toBe(true);
    expect(satisfies("15.0.140", ">=15.0.140")).toBe(true);
    expect(satisfies("15.0.130", ">=15.0.140")).toBe(false);
    expect(satisfies("1.21.1", ">=1.21.1 <1.21.2")).toBe(true);
    expect(satisfies("1.21.2", ">=1.21.1 <1.21.2")).toBe(false);
  });

  it("handles tilde, caret, x-ranges and alternatives", () => {
    expect(satisfies("1.21.1", "~1.21.1")).toBe(true);
    expect(satisfies("1.22.0", "~1.21.1")).toBe(false);
    expect(satisfies("5.1.8", "^5.1.3")).toBe(true);
    expect(satisfies("6.0.0", "^5.1.3")).toBe(false);
    expect(satisfies("1.21.4", "1.21.x")).toBe(true);
    expect(satisfies("1.20.1", "1.21.x")).toBe(false);
    expect(satisfies("1.20.1", "1.20.x || 1.21.x")).toBe(true);
  });

  it("returns null when it cannot judge", () => {
    expect(satisfies("1.21.1", "weird-range")).toBeNull();
  });
});
