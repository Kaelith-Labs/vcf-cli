// createServer({ scope, config }) — transport-agnostic MCP server factory.
//
// Called by:
// - src/mcp.ts (the stdio binary) after parsing --scope
// - tests (via the SDK's InMemoryTransport) to drive tool calls directly
//
// What this file owns:
// - registering tools available under the given scope
// - wiring the audit writer (every tool call emits one audit row)
// - exposing the server instance for the transport layer to connect
//
// What it does NOT own: argv parsing, stdio wiring, config loading — those
// live in the binary entrypoint so tests can skip them.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database as DatabaseType } from "better-sqlite3";
import { VERSION, MCP_SPEC_VERSION } from "./version.js";
import type { Config } from "./config/schema.js";
import type { Scope, ResolvedScope } from "./scope.js";
import { wrapResult, success } from "./envelope.js";
import { writeAudit, setFullAuditMode } from "./util/audit.js";
import { log } from "./logger.js";
import { registerIdeaCapture } from "./tools/idea_capture.js";
import { registerIdeaSearch } from "./tools/idea_search.js";
import { registerIdeaGet } from "./tools/idea_get.js";
import { registerProjectInit } from "./tools/project_init.js";
import { registerPortfolioStatus } from "./tools/portfolio_status.js";
import { registerSpecTemplate } from "./tools/spec_template.js";
import { registerSpecSave } from "./tools/spec_save.js";
import { registerSpecGet } from "./tools/spec_get.js";
import { registerSpecSuggestPrimers } from "./tools/spec_suggest_primers.js";
import { registerPlanContext } from "./tools/plan_context.js";
import { registerPlanSave } from "./tools/plan_save.js";
import { registerPlanGet } from "./tools/plan_get.js";
import { registerBuildContext } from "./tools/build_context.js";
import { registerBuildSwap } from "./tools/build_swap.js";
import { registerDecisionLogAdd, registerDecisionLogList } from "./tools/decision_log.js";
import { registerResponseLogAdd } from "./tools/response_log.js";
import { registerTestGenerate } from "./tools/test_generate.js";
import { registerTestExecute } from "./tools/test_execute.js";
import { registerTestAnalyze } from "./tools/test_analyze.js";
import { registerReviewPrepare } from "./tools/review_prepare.js";
import { registerReviewSubmit } from "./tools/review_submit.js";
import { registerReviewExecute } from "./tools/review_execute.js";
import { registerReviewHistory } from "./tools/review_history.js";
import { registerShipAudit } from "./tools/ship_audit.js";
import { registerShipBuild } from "./tools/ship_build.js";
import { registerShipRelease } from "./tools/ship_release.js";
import {
  registerConfigGet,
  registerEndpointList,
  registerModelList,
  registerPrimerList,
} from "./tools/catalog.js";

export interface ServerDeps {
  scope: Scope;
  resolved: ResolvedScope;
  config: Config;
  globalDb: DatabaseType;
  projectDb?: DatabaseType | undefined;
}

export interface ServerDescribe {
  name: string;
  version: string;
  mcpSpec: string;
  scope: Scope;
}

export function describeServer(scope: Scope): ServerDescribe {
  return {
    name: "@kaelith-labs/cli",
    version: VERSION,
    mcpSpec: MCP_SPEC_VERSION,
    scope,
  };
}

/**
 * Build the MCP server with tools appropriate to the scope. The caller is
 * responsible for connecting a transport; this function does no I/O.
 */
export function createServer(deps: ServerDeps): McpServer {
  // Apply the operator's full-audit opt-in before any tool registers. Last
  // caller wins in multi-server test setups — that's intentional; tests
  // typically create a single server per setup.
  setFullAuditMode(deps.config.audit.full_payload_storage);

  const server = new McpServer(
    { name: "vcf", version: VERSION },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
      instructions:
        "Vibe Coding Framework MCP. Tools follow a paths+summary envelope; pass expand=true for content. Scope: " +
        deps.scope,
    },
  );

  // Always-on ping tool (works under either scope). Cheap probe clients use
  // to verify the server is reachable before trying real tools.
  server.registerTool(
    "vcf_ping",
    {
      title: "VCF Ping",
      description:
        "Return server metadata (name, version, MCP spec, scope). Cheap probe — no side effects.",
      inputSchema: {
        expand: z
          .boolean()
          .default(false)
          .describe("include full server describe object in content"),
      },
    },
    async (args: { expand?: boolean }) => {
      const info = describeServer(deps.scope);
      const payload = success(
        [],
        `vcf ${info.version} (${deps.scope} scope, MCP ${info.mcpSpec})`,
        {
          ...(args.expand ? { content: info } : {}),
        },
      );
      try {
        writeAudit(deps.globalDb, {
          tool: "vcf_ping",
          scope: deps.scope === "project" ? "project" : "global",
          project_root: deps.resolved.vcfDir ? deps.resolved.vcfDir.replace(/\.vcf$/, "") : null,
          inputs: args,
          outputs: payload,
          result_code: "ok",
        });
      } catch (err) {
        log.warn({ err }, "vcf_ping: audit write failed");
      }
      return wrapResult(payload);
    },
  );

  // Scope-partitioned tool registration. Global scope owns idea/spec/
  // project-init + read-only catalog; project scope owns the lifecycle.
  if (deps.scope === "global") {
    // Idea
    registerIdeaCapture(server, deps);
    registerIdeaSearch(server, deps);
    registerIdeaGet(server, deps);
    // Spec
    registerSpecTemplate(server, deps);
    registerSpecSave(server, deps);
    registerSpecGet(server, deps);
    registerSpecSuggestPrimers(server, deps);
    // Project bootstrap
    registerProjectInit(server, deps);
  } else {
    // Project scope owns the full lifecycle.
    registerPortfolioStatus(server, deps);
    registerPlanContext(server, deps);
    registerPlanSave(server, deps);
    registerPlanGet(server, deps);
    registerBuildContext(server, deps);
    registerBuildSwap(server, deps);
    registerDecisionLogAdd(server, deps);
    registerDecisionLogList(server, deps);
    registerResponseLogAdd(server, deps);
    registerTestGenerate(server, deps);
    registerTestExecute(server, deps);
    registerTestAnalyze(server, deps);
    registerReviewPrepare(server, deps);
    registerReviewSubmit(server, deps);
    registerReviewExecute(server, deps);
    registerReviewHistory(server, deps);
    registerShipAudit(server, deps);
    registerShipBuild(server, deps);
    registerShipRelease(server, deps);
  }

  // Catalog (read-only) — available under both scopes; context is cheap and
  // saves the client from having to re-load the server to look up model
  // aliases mid-lifecycle.
  registerConfigGet(server, deps);
  registerEndpointList(server, deps);
  registerModelList(server, deps);
  registerPrimerList(server, deps);

  return server;
}
