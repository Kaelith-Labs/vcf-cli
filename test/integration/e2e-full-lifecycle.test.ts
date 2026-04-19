import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import { __resetShipReleaseStoreForTests } from "../../src/tools/ship_release.js";
import type { ResolvedScope } from "../../src/scope.js";

// Full lifecycle smoke test. Runs the spec's MVP acceptance scenario end
// to end in-memory: capture → spec → init → plan (accept) → build
// (decision log) → test (analyze) → review (stage 1 PASS → stage 2) →
// response log → ship audit → ship_release plan. Verifies the artifact
// tree matches the examples/Vibe-Coding-Framework conventions for the
// covered surface.

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

function ok(env: Envelope): Envelope {
  if (!env.ok) {
    throw new Error(`tool failed: ${env.code ?? "?"} — ${env.summary ?? ""}`);
  }
  return env;
}

describe("e2e: full lifecycle", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-e2e-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-e2e-h-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");

    // Seed minimal KB for the tools that need it (plan_context,
    // review_prepare, spec_suggest_primers).
    await mkdir(join(kbRoot, "primers"), { recursive: true });
    await mkdir(join(kbRoot, "best-practices"), { recursive: true });
    await mkdir(join(kbRoot, "standards"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });

    await writeFile(join(kbRoot, "standards", "company-standards.md"), "# Company Standards\n");
    await writeFile(
      join(kbRoot, "standards", "vibe-coding-primer.md"),
      "# Vibe Coding Planner Standard\n",
    );
    await writeFile(
      join(kbRoot, "primers", "typescript.md"),
      [
        "---",
        "type: primer",
        "primer_name: typescript",
        "category: lang",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["typescript", "mcp"]',
        "---",
        "TS primer.",
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
        "---",
        "Vibe coding best practices.",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      [
        "---",
        "type: reviewer-config",
        "reviewer_type: code",
        "version: 1",
        "updated: 2026-04-18",
        "---",
        "Code reviewer.",
      ].join("\n"),
    );
    for (const stage of [1, 2]) {
      await writeFile(
        join(kbRoot, "review-system", "code", `0${stage}-smoke.md`),
        [
          "---",
          "type: review-stage",
          "review_type: code",
          `stage: ${stage}`,
          `stage_name: "smoke ${stage}"`,
          "version: 1",
          "updated: 2026-04-18",
          "---",
          `# Stage ${stage}`,
        ].join("\n"),
      );
    }
    clearKbCache();
    __resetShipReleaseStoreForTests();
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

  async function connectGlobal(globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") })) {
    const server = createServer({
      scope: "global",
      resolved: { scope: "global" },
      config: makeConfig(),
      globalDb,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, globalDb };
  }

  async function connectProject() {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const resolved: ResolvedScope = {
      scope: "project",
      vcfDir: join(projectDir, ".vcf"),
      projectDbPath: join(projectDir, ".vcf", "project.db"),
    };
    const server = createServer({
      scope: "project",
      resolved,
      config: makeConfig(),
      globalDb,
      projectDb,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, globalDb, projectDb };
  }

  it("capture → spec → init → plan → build → test → review → ship_audit → ship_release (plan-only)", async () => {
    // ---- 1. capture (global scope) ----
    const capEnv = ok(
      parseResult(
        await (
          await connectGlobal()
        ).client.callTool({
          name: "idea_capture",
          arguments: {
            content: "Primer scraper that digests @kaelith-labs/kb diffs daily.",
            title: "Primer Scraper",
            tags: ["infra", "ai"],
          },
        }),
      ),
    );
    const ideaPath = capEnv.paths?.[0];
    expect(ideaPath).toBeDefined();
    expect(ideaPath!).toMatch(/ideas[/\\]\d{4}-\d{2}-\d{2}-primer-scraper\.md$/);

    // ---- 2. spec (save directly; conversational fill is the client's job) ----
    const specMd = [
      "---",
      'title: "Primer Scraper"',
      "status: draft",
      "created: 2026-04-19",
      'tech_stack: ["typescript", "mcp"]',
      'tags: ["ai", "infra"]',
      "---",
      "",
      "# Primer Scraper Spec",
      "",
      "Body goes here.",
    ].join("\n");
    const { client: globalClient } = await connectGlobal();
    const specEnv = ok(
      parseResult(
        await globalClient.callTool({
          name: "spec_save",
          arguments: { content: specMd, expand: true },
        }),
      ),
    );
    const specPath = (specEnv.content as { path: string }).path;
    expect(existsSync(specPath)).toBe(true);

    // ---- 3. project_init ----
    ok(
      parseResult(
        await globalClient.callTool({
          name: "project_init",
          arguments: {
            name: "Primer Scraper",
            target_dir: projectDir,
            spec_path: specPath,
            expand: true,
          },
        }),
      ),
    );
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".vcf", "project.db"))).toBe(true);
    expect(existsSync(join(projectDir, ".mcp.json"))).toBe(true);

    // ---- 4. plan (project scope) ----
    const { client: projClient, projectDb } = await connectProject();
    const pctx = ok(
      parseResult(
        await projClient.callTool({
          name: "plan_context",
          arguments: { name: "scraper", expand: true },
        }),
      ),
    );
    const techTags = (pctx.content as { tech_tags: string[] }).tech_tags;
    expect(techTags).toEqual(["typescript", "mcp"]);

    ok(
      parseResult(
        await projClient.callTool({
          name: "plan_save",
          arguments: {
            name: "scraper",
            plan: "# Plan\n\nPhase 1: config + loader. Phase 2: scraper. Phase 3: digest.".padEnd(
              120,
              " ",
            ),
            todo: "- [ ] write config loader\n- [ ] write scraper\n- [ ] write digest formatter",
            manifest: "- src/config.ts — config loader\n- src/scraper.ts — diff walker",
            advance_state: "building",
          },
        }),
      ),
    );
    const state1 = (
      projectDb.prepare("SELECT state FROM project WHERE id=1").get() as {
        state: string;
      }
    ).state;
    expect(state1).toBe("building");

    // ---- 5. build context + decision log ----
    ok(
      parseResult(
        await projClient.callTool({
          name: "build_context",
          arguments: { plan_name: "scraper", builder_type: "backend", expand: true },
        }),
      ),
    );
    ok(
      parseResult(
        await projClient.callTool({
          name: "decision_log_add",
          arguments: {
            title: "Use yaml package for config parse",
            context: "We need a YAML parser that plays well with ESM + Node 20+.".padEnd(64, " "),
            decision: "Adopt the `yaml` npm package over `js-yaml` for native ESM + schema".padEnd(
              64,
              " ",
            ),
            consequences:
              "Any future migration to another YAML lib is a breaking change to config loader.",
            status: "accepted",
          },
        }),
      ),
    );

    // ---- 6. test pipeline ----
    const testExec = ok(
      parseResult(
        await projClient.callTool({
          name: "test_execute",
          arguments: {
            command: "node",
            args: ["-e", "process.stdout.write('ok\\n'); process.exit(0)"],
            timeout_ms: 5_000,
            expand: true,
          },
        }),
      ),
    );
    expect((testExec.content as { exit_code: number }).exit_code).toBe(0);

    ok(
      parseResult(
        await projClient.callTool({
          name: "test_analyze",
          arguments: {
            stdout: "tests/unit/foo PASSED\ntests/unit/bar PASSED\n",
            stderr: "",
            exit_code: 0,
            expand: true,
          },
        }),
      ),
    );

    // ---- 7. review stage 1 → PASS → stage 2 allowed ----
    const prep1 = ok(
      parseResult(
        await projClient.callTool({
          name: "review_prepare",
          arguments: { type: "code", stage: 1, expand: true },
        }),
      ),
    );
    const run1 = (prep1.content as { run_id: string }).run_id;
    ok(
      parseResult(
        await projClient.callTool({
          name: "review_submit",
          arguments: {
            run_id: run1,
            verdict: "PASS",
            summary: "Stage 1 clean.",
            carry_forward: [
              {
                section: "architecture",
                severity: "info",
                text: "Config-first layout is correct.",
              },
            ],
            expand: true,
          },
        }),
      ),
    );
    // Builder responds to a fictional finding.
    ok(
      parseResult(
        await projClient.callTool({
          name: "response_log_add",
          arguments: {
            review_run_id: run1,
            stance: "agree",
            note: "Will address in the config loader refactor next milestone.",
            expand: true,
          },
        }),
      ),
    );
    // Stage 2 now unlocked.
    const prep2 = ok(
      parseResult(
        await projClient.callTool({
          name: "review_prepare",
          arguments: { type: "code", stage: 2, expand: true },
        }),
      ),
    );
    const cf2Path = (prep2.content as { carry_forward_file: string }).carry_forward_file;
    const cf2 = await readFile(cf2Path, "utf8");
    expect(cf2).toContain("Config-first layout is correct");

    // ---- 8. ship_audit (clean) + ship_release plan ----
    const audit = ok(
      parseResult(
        await projClient.callTool({
          name: "ship_audit",
          arguments: { include: ["config-completeness"], expand: true },
        }),
      ),
    );
    expect((audit.content as { blocker: boolean }).blocker).toBe(false);

    const shipPlan = ok(
      parseResult(
        await projClient.callTool({
          name: "ship_release",
          arguments: {
            tag: "v0.0.1-alpha.0",
            draft: true,
            generate_notes: true,
            expand: true,
          },
        }),
      ),
    );
    const plan = shipPlan.content as {
      command: { name: string; args: string[] };
      confirm_token: string;
    };
    expect(plan.command.name).toBe("gh");
    expect(plan.command.args).toContain("v0.0.1-alpha.0");
    expect(plan.command.args).toContain("--draft");
    expect(plan.confirm_token.length).toBeGreaterThan(20);

    // ---- artifact tree sanity ----
    for (const rel of [
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      ".mcp.json",
      ".gitignore",
      "plans/scraper-plan.md",
      "plans/scraper-todo.md",
      "plans/scraper-manifest.md",
      "plans/reviews/response-log.md",
      "plans/reviews/code", // directory with at least one submitted report
    ]) {
      expect(existsSync(join(projectDir, rel))).toBe(true);
    }
    // decision file exists under plans/decisions/
    const decisions = projectDb.prepare("SELECT path FROM decisions").all() as { path: string }[];
    expect(decisions.length).toBe(1);
    expect(existsSync(decisions[0]!.path)).toBe(true);

    // review_runs has Stage 1 submitted + Stage 2 pending
    const runs = projectDb
      .prepare("SELECT stage, status, verdict FROM review_runs ORDER BY stage")
      .all() as { stage: number; status: string; verdict: string | null }[];
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ stage: 1, status: "submitted", verdict: "PASS" });
    expect(runs[1]).toMatchObject({ stage: 2, status: "pending" });
  });
});
