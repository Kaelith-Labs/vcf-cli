// project_init — global scope.
//
// Scaffolds a new project directory:
//   - AGENTS.md / CLAUDE.md / TOOLS.md / MEMORY.md / README.md / CHANGELOG.md from templates
//   - plans/, memory/daily-logs/, docs/, skills/, backups/ subdirs
//   - .vcf/project.db (initialized via openProjectDb)
//   - .mcp.json (auto-wiring the project-scope MCP server)
//   - .gitignore
//   - `git init` + hook templates (post-commit, pre-push)
//   - optional: copy the source spec into plans/<slug>-spec.md
//
// Merge-safe: on an existing project directory, refuse unless --force is
// set; when merging, any file that already exists is skipped with a warning
// (never overwritten). .mcp.json is merged, not replaced.
//
// The source spec (if provided by path) is also re-validated against
// allowed_roots so clients can't hand us a path outside the configured
// workspace.

import { mkdir, writeFile, readFile, chmod, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { simpleGit } from "simple-git";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { slugify, isoDate } from "../util/slug.js";
import { readTemplate, renderTemplate, templatesDir } from "../util/templates.js";
import { openProjectDb } from "../db/project.js";
import { writeAudit } from "../util/audit.js";
import { upsertProject } from "../util/projectRegistry.js";
import { VERSION } from "../version.js";
import { McpError } from "../errors.js";

const ProjectInitInput = z
  .object({
    name: z.string().min(1).max(128).describe("human-readable project name"),
    target_dir: z
      .string()
      .min(1)
      .describe(
        "absolute path where the project should live. Must be inside workspace.allowed_roots.",
      ),
    spec_path: z
      .string()
      .optional()
      .describe("optional absolute path to a spec .md to copy into plans/"),
    force: z
      .boolean()
      .default(false)
      .describe("proceed even if target_dir is non-empty; never overwrites existing files"),
    register: z
      .boolean()
      .default(true)
      .describe(
        "add the new project to the global cross-project registry (used by portfolio_graph + project_list). Opt out with register=false.",
      ),
    expand: z.boolean().default(false),
  })
  .strict();

type ProjectInitArgs = z.infer<typeof ProjectInitInput>;

const SUBDIRS = [
  "plans",
  "plans/decisions",
  "plans/reviews",
  "memory/daily-logs",
  "docs",
  "skills",
  "backups",
  ".vcf",
] as const;

export function registerProjectInit(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "project_init",
    {
      title: "Initialize Project",
      description:
        "Scaffold a new Vibe Coding Framework project at target_dir: template docs, plans/memory dirs, project.db, .mcp.json, git repo + hooks. Merge-safe. Returns {paths, summary}; pass expand=true for the full list of files written.",
      inputSchema: ProjectInitInput.shape,
    },
    async (args: ProjectInitArgs) => {
      return runTool(async () => {
        const parsed = ProjectInitInput.parse(args);
        const target = resolvePath(parsed.target_dir);
        await assertInsideAllowedRoot(target, deps.config.workspace.allowed_roots);

        // Pre-existence check. An empty existing directory is fine (treat as
        // fresh init — common when the user pre-created the folder). A
        // non-empty directory requires force=true; even then we never
        // overwrite existing files (see per-file `existsSync` checks below).
        const targetExists = existsSync(target);
        if (targetExists) {
          const st = await stat(target);
          if (!st.isDirectory()) {
            throw new McpError("E_STATE_INVALID", `${target} exists and is not a directory`);
          }
          const entries = await readdir(target);
          if (entries.length > 0 && !parsed.force) {
            throw new McpError(
              "E_ALREADY_EXISTS",
              `${target} is non-empty — pass force=true to initialize in place (existing files are never overwritten)`,
            );
          }
        }

        await mkdir(target, { recursive: true });
        const written: string[] = [];
        const skipped: string[] = [];

        for (const sub of SUBDIRS) await mkdir(join(target, sub), { recursive: true });

        const projectSlug = slugify(parsed.name);
        const createdDate = isoDate();
        const tplVars: Record<string, string> = {
          PROJECT_NAME: parsed.name,
          PROJECT_SLUG: projectSlug,
          CREATED_DATE: createdDate,
          DATE: createdDate,
        };

        // Docs at project root.
        const docFiles: Array<[string, string]> = [
          ["AGENTS.md.tpl", "AGENTS.md"],
          ["CLAUDE.md.tpl", "CLAUDE.md"],
          ["TOOLS.md.tpl", "TOOLS.md"],
          ["MEMORY.md.tpl", "MEMORY.md"],
          ["README.md.tpl", "README.md"],
          ["CHANGELOG.md.tpl", "CHANGELOG.md"],
        ];
        for (const [tpl, out] of docFiles) {
          const outPath = join(target, out);
          if (existsSync(outPath)) {
            skipped.push(outPath);
            continue;
          }
          const rendered = renderTemplate(await readTemplate(tpl), tplVars);
          await writeFile(outPath, rendered, "utf8");
          written.push(outPath);
        }

        // .gitignore (skip if present).
        const gitignorePath = join(target, ".gitignore");
        if (!existsSync(gitignorePath)) {
          await writeFile(gitignorePath, await readTemplate("gitignore.tpl"), "utf8");
          written.push(gitignorePath);
        } else {
          skipped.push(gitignorePath);
        }

        // Today's daily log.
        const dailyLogPath = join(target, "memory", "daily-logs", `${createdDate}.md`);
        if (!existsSync(dailyLogPath)) {
          await writeFile(
            dailyLogPath,
            renderTemplate(await readTemplate("daily-log-template.md.tpl"), tplVars),
            "utf8",
          );
          written.push(dailyLogPath);
        } else {
          skipped.push(dailyLogPath);
        }

        // Optional spec copy.
        if (parsed.spec_path) {
          const specSrc = resolvePath(parsed.spec_path);
          await assertInsideAllowedRoot(specSrc, deps.config.workspace.allowed_roots);
          const specDst = join(target, "plans", `${projectSlug}-spec.md`);
          if (!existsSync(specDst)) {
            const content = await readFile(specSrc, "utf8");
            await writeFile(specDst, content, "utf8");
            written.push(specDst);
          } else {
            skipped.push(specDst);
          }
        }

        // .mcp.json — merge with existing, never replace.
        const mcpJsonPath = join(target, ".mcp.json");
        const mcpBlock = {
          command: "npx",
          args: ["-y", "@kaelith-labs/cli", "vcf-mcp", "--scope", "project"],
          env: { VCF_CONFIG: "${HOME}/.vcf/config.yaml" },
        };
        let mcpMerged = false;
        if (existsSync(mcpJsonPath)) {
          const raw = await readFile(mcpJsonPath, "utf8");
          let parsedJson: { mcpServers?: Record<string, unknown> } = {};
          try {
            parsedJson = JSON.parse(raw) as typeof parsedJson;
          } catch {
            throw new McpError("E_STATE_INVALID", `${mcpJsonPath} is not valid JSON`);
          }
          if (!parsedJson.mcpServers) parsedJson.mcpServers = {};
          if (!parsedJson.mcpServers["vcf"]) {
            parsedJson.mcpServers["vcf"] = mcpBlock;
            await writeFile(mcpJsonPath, JSON.stringify(parsedJson, null, 2) + "\n", "utf8");
            mcpMerged = true;
            written.push(mcpJsonPath);
          } else {
            skipped.push(mcpJsonPath);
          }
        } else {
          await writeFile(
            mcpJsonPath,
            JSON.stringify({ mcpServers: { vcf: mcpBlock } }, null, 2) + "\n",
            "utf8",
          );
          written.push(mcpJsonPath);
        }

        // Project DB.
        const dbPath = join(target, ".vcf", "project.db");
        const newDb = !existsSync(dbPath);
        const db = openProjectDb({ path: dbPath });
        const now = Date.now();
        db.prepare(
          `INSERT OR IGNORE INTO project (id, name, root_path, state, created_at, updated_at, spec_path)
           VALUES (1, ?, ?, 'draft', ?, ?, ?)`,
        ).run(parsed.name, target, now, now, parsed.spec_path ?? null);
        db.close();
        if (newDb) written.push(dbPath);
        else skipped.push(dbPath);

        // Global registry: auto-register the new project unless opted out.
        // Silent if it's already registered (upsert). Uses the same slug
        // the project directory already derived from parsed.name.
        if (parsed.register) {
          try {
            upsertProject(deps.globalDb, {
              name: projectSlug,
              root_path: target,
              state: "draft",
            });
          } catch {
            /* non-fatal — registry is a convenience, not a requirement */
          }
        }

        // Git init + hooks. Only init if .git doesn't already exist so we
        // don't disturb an existing repo.
        const gitDir = join(target, ".git");
        if (!existsSync(gitDir)) {
          const git = simpleGit({ baseDir: target });
          await git.init();
        }
        await installHooks(target, written, skipped);

        const createdCount = written.length;
        const summary =
          `Initialized project "${parsed.name}" at ${target} — ` +
          `${createdCount} file(s) written, ${skipped.length} skipped (existing)` +
          (mcpMerged ? " — .mcp.json merged with existing block." : "");

        const payload = success([target, ...written.slice(0, 10)], summary, {
          ...(parsed.expand
            ? {
                content: {
                  written,
                  skipped,
                  project_db: dbPath,
                  mcp_json: mcpJsonPath,
                  vcf_version: VERSION,
                },
              }
            : {
                expand_hint: "Call project_init again with expand=true to see the full file list.",
              }),
        });

        try {
          writeAudit(deps.globalDb, {
            tool: "project_init",
            scope: "global",
            project_root: target,
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

async function installHooks(target: string, written: string[], skipped: string[]): Promise<void> {
  const hooksDir = join(target, ".git", "hooks");
  if (!existsSync(hooksDir)) return; // git init didn't complete; silently skip
  for (const hook of ["post-commit", "pre-push"] as const) {
    const dest = join(hooksDir, hook);
    if (existsSync(dest)) {
      skipped.push(dest);
      continue;
    }
    const src = join(templatesDir(), "hooks", hook);
    const body = await readFile(src, "utf8");
    await writeFile(dest, body, "utf8");
    await chmod(dest, 0o755);
    written.push(dest);
  }
}
