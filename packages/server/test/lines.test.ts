import { describe, it, expect } from "vitest";
import { LineSplitter } from "../src/lib/lines.js";
import { parseProperties, serializeProperties, detectEol, applyChanges } from "../src/services/properties.js";

describe("LineSplitter", () => {
  it("keeps multi-byte characters intact across chunk boundaries and strips CRLF", () => {
    const out: string[] = [];
    const sp = new LineSplitter((b) => b.toString("utf8"), (l) => out.push(l));
    const bytes = Buffer.from("첫 줄\r\n두 번째 줄\n끝", "utf8");
    // 한글 한 글자(3바이트) 중간에서 자르기
    sp.push(bytes.subarray(0, 2));
    sp.push(bytes.subarray(2, 11));
    sp.push(bytes.subarray(11));
    expect(out).toEqual(["첫 줄", "두 번째 줄"]);
    sp.flush();
    expect(out).toEqual(["첫 줄", "두 번째 줄", "끝"]);
  });
});

describe("server.properties line endings", () => {
  it("keeps CRLF files as CRLF", () => {
    const text = "#Minecraft server properties\r\npvp=true\r\nmotd=Hi\r\n";
    expect(detectEol(text)).toBe("\r\n");
    const out = serializeProperties(applyChanges(parseProperties(text), { pvp: "false" }), detectEol(text));
    expect(out).toBe("#Minecraft server properties\r\npvp=false\r\nmotd=Hi\r\n");
  });
});
