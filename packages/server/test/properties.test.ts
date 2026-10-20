import { describe, it, expect } from "vitest";
import { parseProperties, serializeProperties, applyChanges, toRecord } from "../src/services/properties.js";

const SAMPLE = `#Minecraft server properties
#Tue Oct 20 10:31:37 KST 2026
difficulty=easy
level-type=minecraft\\:normal
motd=A Minecraft Server
pvp=true
level-seed=
`;

describe("properties parser", () => {
  it("parses entries and keeps comments", () => {
    const lines = parseProperties(SAMPLE);
    expect(lines[0]).toEqual({ kind: "other", raw: "#Minecraft server properties" });
    expect(toRecord(lines)).toEqual({
      difficulty: "easy",
      "level-type": "minecraft:normal",
      motd: "A Minecraft Server",
      pvp: "true",
      "level-seed": "",
    });
  });

  it("round-trips unchanged text", () => {
    expect(serializeProperties(parseProperties(SAMPLE))).toBe(SAMPLE);
  });

  it("applies changes in place and appends new keys before trailing blank line", () => {
    const lines = applyChanges(parseProperties(SAMPLE), { pvp: "false", "new-key": "x" });
    const out = serializeProperties(lines);
    expect(out).toBe(`#Minecraft server properties
#Tue Oct 20 10:31:37 KST 2026
difficulty=easy
level-type=minecraft\\:normal
motd=A Minecraft Server
pvp=false
level-seed=
new-key=x
`);
  });

  it("escapes non-ascii like java.util.Properties", () => {
    const lines = applyChanges(parseProperties("motd=x\n"), { motd: "친구 서버: 환영!" });
    const out = serializeProperties(lines);
    expect(out).toBe("motd=\\uce5c\\uad6c \\uc11c\\ubc84\\: \\ud658\\uc601\\!\n");
    expect(toRecord(parseProperties(out)).motd).toBe("친구 서버: 환영!");
  });
});
