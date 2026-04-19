// M0 stub for the MCP server factory.
//
// Real implementation lands in M2 (`createServer({ scope })`), M2.5 adds the
// envelope/error/redaction contract, and M3 wires the end-to-end skeleton spike
// (idea_capture / project_init / portfolio_status). This file exists now so the
// package has a valid `exports["."]` entry and tsup can produce declaration
// output.
import { VERSION, MCP_SPEC_VERSION } from "./version.js";

export type Scope = "global" | "project";

export interface ServerInfo {
  name: string;
  version: string;
  mcpSpec: string;
  scope: Scope;
}

export function describeServer(scope: Scope): ServerInfo {
  return {
    name: "@vcf/cli",
    version: VERSION,
    mcpSpec: MCP_SPEC_VERSION,
    scope,
  };
}
