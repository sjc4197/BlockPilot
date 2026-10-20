import { describe, it, expect } from "vitest";
import { explainServerFailure } from "../src/services/create/pipeline.js";

describe("explainServerFailure", () => {
  it("recognises the usual first-run failures from server output", () => {
    expect(explainServerFailure("[Server thread/WARN]: **** FAILED TO BIND TO PORT!").code).toBe("port_in_use");
    expect(explainServerFailure("java.lang.UnsupportedClassVersionError: net/minecraft/server/Main has been compiled by a more recent version").code).toBe("java_failed");
    expect(explainServerFailure("Error occurred during initialization of VM\nCould not reserve enough space for object heap").code).toBe("memory");
    expect(explainServerFailure("[main/INFO]: You need to agree to the EULA in order to run the server.").code).toBe("eula_required");
    const other = explainServerFailure("something else");
    expect(other.code).toBe("server_exited");
    expect(other.message).toMatch(/준비를 마치기 전에 꺼졌어요/);
  });
});
