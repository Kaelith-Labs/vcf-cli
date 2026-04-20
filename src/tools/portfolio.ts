// project_list + portfolio_graph — global scope.
//
// Cross-project visibility built on the `projects` registry table
// (migration v3). Registry is opt-in: `project_init` auto-registers
// unless `register=false`, and `vcf project register/scan/unregister`
// manages it explicitly. Unregistered projects are invisible here.
//
// State + depends_on projection live in the global DB, kept current by
// state-mutating project-scope tools (plan_save, review_prepare, …) so
// these tools are cheap: no filesystem walks, no per-project DB reopens.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { listProjects, computeBlockers, computeUnblockedIfShips } from "../util/projectRegistry.js";

const ProjectListInput = z
  .object({
    expand: z.boolean().default(true),
  })
  .strict();

export function registerProjectList(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_list",
    {
      title: "List Registered Projects",
      description:
        "Return every project in the global cross-project registry (newest-registered first). Each row carries name, root_path, cached state, depends_on, and last_seen_at timestamp. Registration is opt-in via project_init (auto) or `vcf project register/scan`.",
      inputSchema: ProjectListInput.shape,
    },
    async (args: z.infer<typeof ProjectListInput>) => {
      return runTool(async () => {
        const parsed = ProjectListInput.parse(args);
        const rows = listProjects(deps.globalDb);
        const payload = success(
          rows.map((r) => r.root_path),
          `project_list: ${rows.length} project(s) registered`,
          parsed.expand
            ? { content: { projects: rows } }
            : { expand_hint: "Call project_list with expand=true for the full list." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "project_list",
            scope: "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

const PortfolioGraphInput = z
  .object({
    // Filter out shipped projects unless explicitly requested. Default
    // `true` because most callers care about the active portfolio.
    include_shipped: z.boolean().default(false),
    expand: z.boolean().default(true),
  })
  .strict();

export function registerPortfolioGraph(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "portfolio_graph",
    {
      title: "Portfolio Dependency Graph",
      description:
        "Return the cross-project dependency graph: registered projects + blockers computed from depends_on projections + reverse map of what becomes unblocked if a given project ships. Purely informational — the state machine per-project stays local; this tool does not block transitions.",
      inputSchema: PortfolioGraphInput.shape,
    },
    async (args: z.infer<typeof PortfolioGraphInput>) => {
      return runTool(async () => {
        const parsed = PortfolioGraphInput.parse(args);
        const all = listProjects(deps.globalDb);
        const filtered = parsed.include_shipped
          ? all
          : all.filter((p) => p.state_cache !== "shipped");
        const blockers = computeBlockers(filtered);
        const unblocked = computeUnblockedIfShips(filtered);

        const graph = {
          projects: filtered.map((p) => ({
            name: p.name,
            state: p.state_cache,
            root: p.root_path,
            depends_on: p.depends_on,
            last_seen_at: p.last_seen_at,
          })),
          blockers,
          unblocked_if_ships: unblocked,
        };

        const payload = success(
          filtered.map((p) => p.root_path),
          `portfolio_graph: ${filtered.length} active project(s), ${blockers.length} blocker edge(s)`,
          parsed.expand
            ? { content: graph }
            : { expand_hint: "Call portfolio_graph with expand=true for the full graph." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "portfolio_graph",
            scope: "global",
            inputs: parsed,
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}
