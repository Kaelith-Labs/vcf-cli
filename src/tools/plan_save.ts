// plan_save — project scope.
//
// Persist the three plan artifacts (plan, todo, manifest) to
// <project>/plans/<name>-{plan,todo,manifest}.md and transition the project
// state to 'planning' (or 'building' if explicitly requested). Writes
// artifact rows into project.db for the indexer.
//
// force=false (default) refuses to overwrite existing files so a re-plan
// is an explicit act.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { setProjectDependsOn, setProjectState } from "../util/projectRegistry.js";
import { McpError } from "../errors.js";

const PlanSaveInput = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .min(1)
      .max(128),
    plan: z.string().min(64).max(400_000).describe("narrative plan markdown"),
    todo: z.string().min(16).max(200_000).describe("flat imperative todo list markdown"),
    manifest: z.string().min(16).max(200_000).describe("file-by-file manifest markdown"),
    advance_state: z
      .enum(["planning", "building"])
      .default("planning")
      .describe("advance project.state after save (planning or building). Default planning."),
    force: z.boolean().default(false),
    expand: z.boolean().default(false),
  })
  .strict();

export function registerPlanSave(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "plan_save",
    {
      title: "Save Plan",
      description:
        "Persist plan, todo, manifest to plans/<name>-*.md; index in project.db.artifacts; advance project.state (planning|building).",
      inputSchema: PlanSaveInput.shape,
    },
    async (args: z.infer<typeof PlanSaveInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "plan_save requires project scope");
        }
        const parsed = PlanSaveInput.parse(args);
        const projectRoot = readProjectRoot(deps);
        if (!projectRoot) {
          throw new McpError("E_STATE_INVALID", "project row missing; re-run vcf init");
        }
        const plansDir = join(projectRoot, "plans");
        await assertInsideAllowedRoot(plansDir, deps.config.workspace.allowed_roots);
        await mkdir(plansDir, { recursive: true });

        const targets: Array<[string, string]> = [
          [join(plansDir, `${parsed.name}-plan.md`), parsed.plan],
          [join(plansDir, `${parsed.name}-todo.md`), parsed.todo],
          [join(plansDir, `${parsed.name}-manifest.md`), parsed.manifest],
        ];

        // Overwrite policy — atomic-ish: check all first, then write.
        if (!parsed.force) {
          for (const [target] of targets) {
            if (await exists(target)) {
              throw new McpError(
                "E_ALREADY_EXISTS",
                `${target} already exists — pass force=true to overwrite the plan`,
              );
            }
          }
        }

        const written: string[] = [];
        for (const [target, content] of targets) {
          await assertInsideAllowedRoot(target, deps.config.workspace.allowed_roots);
          await writeFile(target, content, "utf8");
          written.push(target);
          indexArtifact(deps, target, kindOf(target), content);
        }

        // Advance project state in both the per-project DB (authoritative)
        // and the global registry's state_cache (fast portfolio_graph lookup).
        const now = Date.now();
        deps.projectDb
          .prepare("UPDATE project SET state = ?, updated_at = ? WHERE id = 1")
          .run(parsed.advance_state, now);
        try {
          setProjectState(deps.globalDb, projectRoot, parsed.advance_state);
        } catch {
          /* non-fatal — registry is opt-in */
        }

        // Project the plan's `depends_on:` frontmatter into the registry so
        // portfolio_graph can render blockers without re-reading files.
        try {
          const deps_on = parseDependsOn(parsed.plan);
          setProjectDependsOn(deps.globalDb, projectRoot, deps_on);
        } catch {
          /* non-fatal */
        }

        const payload = success(
          written,
          `Saved plan "${parsed.name}" (3 files) and advanced project state → ${parsed.advance_state}.`,
          parsed.expand
            ? { content: { written, state: parsed.advance_state } }
            : {
                expand_hint:
                  "Call plan_save with expand=true to receive the file list + new state.",
              },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "plan_save",
            scope: "project",
            project_root: projectRoot,
            inputs: {
              ...parsed,
              plan: `<${parsed.plan.length} chars>`,
              todo: `<${parsed.todo.length} chars>`,
              manifest: `<${parsed.manifest.length} chars>`,
            },
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

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function kindOf(p: string): string {
  if (p.endsWith("-plan.md")) return "plan";
  if (p.endsWith("-todo.md")) return "todo";
  if (p.endsWith("-manifest.md")) return "manifest";
  return "artifact";
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

function indexArtifact(deps: ServerDeps, path: string, kind: string, body: string): void {
  const hash = "sha256:" + createHash("sha256").update(body).digest("hex");
  deps.projectDb
    ?.prepare(
      `INSERT INTO artifacts (path, kind, frontmatter_json, mtime, hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         kind = excluded.kind,
         mtime = excluded.mtime,
         hash = excluded.hash`,
    )
    .run(path, kind, "{}", Date.now(), hash);
}

/**
 * Extract `depends_on: [slug, slug, ...]` from the plan markdown's
 * frontmatter. Returns an empty array if the frontmatter is missing,
 * malformed, or the key isn't present. Only slug-shaped strings survive.
 *
 * We parse inline here rather than sharing primers/load.ts:extractFrontmatter
 * because plan frontmatter may nest more richly than KB frontmatter and
 * we don't want to drag that complexity into the KB loader.
 */
function parseDependsOn(plan: string): string[] {
  if (!plan.startsWith("---")) return [];
  const end = plan.indexOf("\n---", 3);
  if (end < 0) return [];
  const block = plan.slice(3, end);
  // Support both `depends_on: [a, b]` inline and `depends_on:\n  - a\n  - b`.
  const inline = block.match(/^\s*depends_on\s*:\s*\[(.*?)\]\s*$/m);
  if (inline && inline[1] !== undefined) {
    return inline[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s));
  }
  const multi = block.match(/^\s*depends_on\s*:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (multi && multi[1] !== undefined) {
    return multi[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) =>
        l
          .slice(1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      )
      .filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s));
  }
  return [];
}
