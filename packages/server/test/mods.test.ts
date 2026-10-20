import { describe, it, expect } from "vitest";
import { satisfies, parseVersion } from "../src/services/mods.js";

describe("parseVersion", () => {
  it("strips build metadata and prerelease", () => {
    expect(parseVersion("0.116.15+1.21.1")).toEqual([0, 116, 15]);
    expect(parseVersion("5.1.3-beta")).toEqual([5, 1, 3]);
    expect(parseVersion("1.21.1-Fabric-5.1.8")).toEqual([1, 21, 1]);
    expect(parseVersion("abc")).toBeNull();
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
