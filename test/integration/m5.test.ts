import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  paths?: string[];
  summary?: string;
  content?: unknown;
  code?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("M5 plan / build / logs (project scope)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m5-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-m5h-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(kbRoot, "primers"), { recursive: true });
    await mkdir(join(kbRoot, "best-practices"), { recursive: true });
    await mkdir(join(kbRoot, "standards"), { recursive: true });

    await writeFile(
      join(kbRoot, "standards", "company-standards.md"),
      "# Company Standards\n\n- rule 1\n",
    );
    await writeFile(
      join(kbRoot, "standards", "vibe-coding-primer.md"),
      "# Vibe Coding Planner Standard\n\n- plan the test layer\n",
    );
    await writeFile(
      join(kbRoot, "primers", "mcp.md"),
      [
        "---",
        "type: primer",
        "primer_name: mcp",
        "category: tools",
        "version: 2",
        "updated: 2026-04-18",
        'tags: ["mcp", "typescript"]',
        "---",
        "MCP primer body.",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "best-practices", "vibe-coding.md"),
      [
        "---",
        "type: best-practices",
        "best_practice_name: vibe-coding",
        "category: ai",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["vibe-coding"]',
        "---",
        "Vibe coding best practices body.",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "best-practices", "backend.md"),
      [
        "---",
        "type: best-practices",
        "best_practice_name: backend",
        "category: engineering",
        "version: 1",
        "updated: 2026-04-18",
        "---",
        "Backend BP body.",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "best-practices", "frontend.md"),
      [
        "---",
        "type: best-practices",
        "best_practice_name: frontend",
        "category: engineering",
        "version: 1",
        "updated: 2026-04-18",
        "---",
        "Frontend BP body.",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function makeConfig() {
    return ConfigSchema.parse({
      version: 1,
      workspace: {
        allowed_roots: [workRoot],
        ideas_dir: join(workRoot, "ideas"),
        specs_dir: join(workRoot, "specs"),
      },
      endpoints: [
        {
          name: "local-stub",
          provider: "local-stub",
          base_url: "http://127.0.0.1:1",
          trust_level: "local",
        },
      ],
      kb: { root: kbRoot },
    });
  }

  /** Initialize the project via project_init under global scope, then hand back
   *  a project-scope client for the rest of the test. Also writes a spec. */
  async function bootProjectScope() {
    const specPath = join(workRoot, "specs", "2026-04-19-demo.md");
    await mkdir(join(workRoot, "specs"), { recursive: true });
    await writeFile(
      specPath,
      [
        "---",
        'title: "Demo"',
        "status: draft",
        "created: 2026-04-19",
        'tech_stack: ["typescript", "mcp"]',
        'lens: ["security"]',
        "---",
        "",
        "# Demo Spec",
        "",
        "Body goes here.",
      ].join("\n"),
    );

    // Global scope: project_init.
    {
      const config = makeConfig();
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      const server = createServer({
        scope: "global",
        resolved: { scope: "global" },
        config,
        globalDb,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
      await client.connect(b);
      const init = await client.callTool({
        name: "project_init",
        arguments: { name: "Demo", target_dir: projectDir, spec_path: specPath },
      });
      expect(parseResult(init).ok).toBe(true);
      globalDb.close();
    }

    // Project scope.
    const config = makeConfig();
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const resolved: ResolvedScope = {
      scope: "project",
      vcfDir: join(projectDir, ".vcf"),
      projectDbPath: join(projectDir, ".vcf", "project.db"),
    };
    const server = createServer({ scope: "project", resolved, config, globalDb, projectDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, globalDb, projectDb };
  }

  it("registers every lifecycle tool under project scope", async () => {
    const { client } = await bootProjectScope();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const expected of [
      "vcf_ping",
      "portfolio_status",
      "plan_context",
      "plan_save",
      "plan_get",
      "build_context",
      "build_swap",
      "decision_log_add",
      "decision_log_list",
      "response_log_add",
      "config_get",
      "endpoint_list",
      "model_list",
      "primer_list",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("plan_context assembles spec + planner + KB suggestions", async () => {
    const { client } = await bootProjectScope();
    const res = await client.callTool({
      name: "plan_context",
      arguments: { name: "demo", expand: true },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const c = env.content as {
      planner_md: string;
      standards_md: string;
      vibe_primer_md: string;
      spec_md: string;
      suggested_primers: Array<{ id: string }>;
      tech_tags: string[];
    };
    expect(c.planner_md).toMatch(/Planner Role/);
    expect(c.standards_md).toMatch(/Company Standards/);
    expect(c.vibe_primer_md).toMatch(/Vibe Coding/);
    expect(c.spec_md).toMatch(/# Demo Spec/);
    expect(c.tech_tags).toEqual(["typescript", "mcp"]);
    expect(c.suggested_primers.some((s) => s.id === "primers/mcp")).toBe(true);
  });

  it("plan_save writes three files and advances state to planning", async () => {
    const { client, projectDb } = await bootProjectScope();
    const res = await client.callTool({
      name: "plan_save",
      arguments: {
        name: "demo",
        plan: "# Plan\n\nSome phases.".padEnd(120, " "),
        todo: "- [ ] item 1\n- [ ] item 2",
        manifest: "- src/main.ts — entry point",
        advance_state: "planning",
        expand: true,
      },
    });
    const env = parseResult(res);
    expect(env.ok).toBe(true);
    const out = env.content as { written: string[]; state: string };
    expect(out.written.length).toBe(3);
    expect(out.state).toBe("planning");
    // Verify on disk
    for (const suffix of ["plan", "todo", "manifest"]) {
      const p = join(projectDir, "plans", `demo-${suffix}.md`);
      expect(await readFile(p, "utf8")).toMatch(/./);
    }
    // DB state
    const state = (
      projectDb.prepare("SELECT state FROM project WHERE id=1").get() as { state: string }
    ).state;
    expect(state).toBe("planning");
  });

  it("plan_save with force=false refuses overwrite", async () => {
    const { client } = await bootProjectScope();
    const args = {
      name: "demo",
      plan: "# Plan A".padEnd(120, " "),
      todo: "- [ ] first task",
      manifest: "- src/main.ts — entry",
    };
    expect(parseResult(await client.callTool({ name: "plan_save", arguments: args })).ok).toBe(
      true,
    );
    const env = parseResult(
      await client.callTool({
        name: "plan_save",
        arguments: { ...args, plan: "# Plan B".padEnd(120, " ") },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_ALREADY_EXISTS");
  });

  it("plan_get returns the written plan files", async () => {
    const { client } = await bootProjectScope();
    await client.callTool({
      name: "plan_save",
      arguments: {
        name: "demo",
        plan: "# P".padEnd(120, " "),
        todo: "- [ ] first task",
        manifest: "- src/main.ts entry",
      },
    });
    const env = parseResult(
      await client.callTool({ name: "plan_get", arguments: { name: "demo", expand: true } }),
    );
    expect(env.ok).toBe(true);
    const bodies = env.content as Record<string, string>;
    expect(Object.keys(bodies).sort()).toEqual(["manifest_md", "plan_md", "todo_md"]);
  });

  it("build_context loads builder.md + vibe-BP + type-BP + plan bodies", async () => {
    const { client } = await bootProjectScope();
    await client.callTool({
      name: "plan_save",
      arguments: {
        name: "demo",
        plan: "# Plan".padEnd(120, " "),
        todo: "- [ ] first task",
        manifest: "- src/main.ts entry",
      },
    });
    const env = parseResult(
      await client.callTool({
        name: "build_context",
        arguments: { plan_name: "demo", builder_type: "backend", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as {
      builder_md: string;
      vibe_best_practice_md: string | null;
      type_best_practice_md: string | null;
      plan: Record<string, string | null>;
    };
    expect(c.builder_md).toMatch(/Builder Role/);
    expect(c.vibe_best_practice_md).toMatch(/Vibe coding/);
    expect(c.type_best_practice_md).toMatch(/Backend BP/);
    expect(c.plan["plan"]).toMatch(/# Plan/);
  });

  it("build_swap returns a compaction hint and the target best-practice body", async () => {
    const { client } = await bootProjectScope();
    const env = parseResult(
      await client.callTool({
        name: "build_swap",
        arguments: {
          from_type: "backend",
          to_type: "frontend",
          plan_name: "demo",
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as { compaction_hint: string; best_practice_md: string | null };
    expect(c.compaction_hint).toMatch(/Compact/);
    expect(c.best_practice_md).toMatch(/Frontend BP/);
  });

  it("decision_log_add writes an ADR file and indexes it; decision_log_list returns it", async () => {
    const { client } = await bootProjectScope();
    const add = parseResult(
      await client.callTool({
        name: "decision_log_add",
        arguments: {
          title: "Use Zod v4",
          context:
            "We need schema validation that gracefully handles strict mode and exportable types.".padEnd(
              80,
              " ",
            ),
          decision: "Adopt Zod v4 across server and KB frontmatter".padEnd(80, " "),
          consequences:
            "All new input schemas pass .strict(); breaking changes require version bump.",
          status: "accepted",
          expand: true,
        },
      }),
    );
    expect(add.ok).toBe(true);
    const meta = add.content as { slug: string; path: string };
    expect(meta.slug).toBe("use-zod-v4");
    const onDisk = await readFile(meta.path, "utf8");
    expect(onDisk).toMatch(/## Decision/);

    const list = parseResult(
      await client.callTool({ name: "decision_log_list", arguments: { expand: true } }),
    );
    expect(list.ok).toBe(true);
    const entries = (list.content as { entries: Array<{ slug: string }> }).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]?.slug).toBe("use-zod-v4");
  });

  it("decision_log_add with supersedes fails on unknown slug", async () => {
    const { client } = await bootProjectScope();
    const env = parseResult(
      await client.callTool({
        name: "decision_log_add",
        arguments: {
          title: "Some Decision",
          context: "ctx".padEnd(80, " "),
          decision: "dec".padEnd(80, " "),
          consequences: "consequences",
          supersedes: "nonexistent",
        },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_NOT_FOUND");
  });

  it("response_log_add appends to plans/reviews/response-log.md and indexes the row", async () => {
    const { client, projectDb } = await bootProjectScope();
    const env = parseResult(
      await client.callTool({
        name: "response_log_add",
        arguments: {
          review_run_id: "code-20260419T120000Z",
          stance: "disagree",
          note: "We intentionally swallow this error because the retry is idempotent — see ADR use-zod-v4.",
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const logPath = (env.content as { log_path: string }).log_path;
    const body = await readFile(logPath, "utf8");
    expect(body).toMatch(/stance: disagree/);
    expect(body).toMatch(/retry is idempotent/);
    const count = (
      projectDb.prepare("SELECT COUNT(*) as c FROM response_log").get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });
});
