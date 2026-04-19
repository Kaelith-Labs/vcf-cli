import { describe, it, expect } from "vitest";
import { describeServer } from "../src/server.js";
import { VERSION, MCP_SPEC_VERSION } from "../src/version.js";

describe("M0 smoke", () => {
  it("describeServer reports scope + pinned versions", () => {
    const info = describeServer("global");
    expect(info.name).toBe("@vcf/cli");
    expect(info.version).toBe(VERSION);
    expect(info.mcpSpec).toBe(MCP_SPEC_VERSION);
    expect(info.scope).toBe("global");
  });

  it("describeServer accepts both scopes", () => {
    expect(describeServer("project").scope).toBe("project");
    expect(describeServer("global").scope).toBe("global");
  });
});
