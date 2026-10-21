import { describe, it, expect } from "vitest";
import { newerThan } from "../src/routes/update.js";
import { APP_VERSION } from "../src/lib/appInfo.js";

describe("update check", () => {
  it("compares versions", () => {
    expect(newerThan("1.0.1", "1.0.0")).toBe(true);
    expect(newerThan("v1.10.0", "1.9.9")).toBe(true);
    expect(newerThan("1.0.0", "1.0.0")).toBe(false);
    expect(newerThan("0.9.0", "1.0.0")).toBe(false);
  });
  it("knows its own version from package.json", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
