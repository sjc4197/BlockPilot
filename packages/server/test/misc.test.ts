import { describe, it, expect } from "vitest";
import { parseList } from "../src/services/process.js";
import { stripColor } from "../src/services/rcon.js";
import { validate } from "../src/services/configs.js";

describe("parseList", () => {
  it("extracts player names from the list command output", () => {
    expect(parseList("There are 2 of a max of 20 players online: Alice, Bob")).toEqual(["Alice", "Bob"]);
    expect(parseList("There are 0 of a max of 20 players online:")).toEqual([]);
    expect(parseList("garbage")).toEqual([]);
  });
});

describe("stripColor", () => {
  it("removes § formatting codes", () => {
    expect(stripColor("§aHello §r§lWorld")).toBe("Hello World");
  });
});

describe("config validate", () => {
  it("accepts valid toml/json/yaml", () => {
    expect(validate("toml", "[a]\nb = 1\n").ok).toBe(true);
    expect(validate("json", '{"a":1}').ok).toBe(true);
    expect(validate("yaml", "a: 1\nb:\n  - x\n").ok).toBe(true);
    expect(validate("properties", "anything=goes").ok).toBe(true);
  });

  it("reports line numbers for broken files", () => {
    const toml = validate("toml", "[a]\nb = \n");
    expect(toml.ok).toBe(false);
    expect(toml.line).toBe(2);
    const json = validate("json", '{\n"a": 1,\n}');
    expect(json.ok).toBe(false);
    expect(json.line).toBe(3);
  });
});
