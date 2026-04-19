import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb } from "../../src/db/global.js";
import { openProjectDb } from "../../src/db/project.js";
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

describe("M7 review subsystem (project scope)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m7-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-m7h-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });
    await mkdir(join(kbRoot, "lenses"), { recursive: true });

    // Seed stages 1–3 for "code" type.
    for (const stage of [1, 2, 3]) {
      await writeFile(
        join(kbRoot, "review-system", "code", `0${stage}-test-stage.md`),
        [
          "---",
          "type: review-stage",
          "review_type: code",
          `stage: ${stage}`,
          `stage_name: test-stage-${stage}`,
          "version: 0.1",
          "updated: 2026-04-18",
          "---",
          `# Stage ${stage} body`,
        ].join("\n"),
      );
    }
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      [
        "---",
        "type: reviewer-config",
        "reviewer_type: code",
        "version: 0.1",
        "updated: 2026-04-18",
        "---",
        "# Code Reviewer Config",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "lenses", "security-surface.md"),
      [
        "---",
        "type: lens",
        "lens_name: security-surface",
        "focus: attack surface",
        "version: 1",
        "updated: 2026-04-18",
        "---",
        "# Security Surface Lens",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  async function connectProject() {
    const config = makeConfig();
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'Demo', ?, 'building', ?, ?)`,
      )
      .run(projectDir, now, now);
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

  it("review_prepare(stage=1) creates a disposable workspace + copies stage + reviewer + carry-forward", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const m = env.content as {
      run_dir: string;
      stage_file: string;
      reviewer_file: string;
      carry_forward_file: string;
    };
    // The stage file was *copied*, not referenced — source still exists.
    const original = await readFile(
      join(kbRoot, "review-system", "code", "01-test-stage.md"),
      "utf8",
    );
    const copy = await readFile(m.stage_file, "utf8");
    expect(copy).toBe(original);
    // Reviewer copy exists.
    expect((await readFile(m.reviewer_file, "utf8")).length).toBeGreaterThan(0);
    // Empty carry-forward YAML.
    const cf = await readFile(m.carry_forward_file, "utf8");
    expect(cf).toContain("architecture:");
    expect(cf).toContain("[]"); // empty sections rendered as []
  });

  it("review_prepare(stage=2) without prior Stage-1 PASS returns E_STATE_INVALID", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 2 },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_STATE_INVALID");
  });

  it("review_prepare + review_submit(PASS) unlocks stage 2; carry-forward propagates", async () => {
    const { client } = await connectProject();
    const prep1 = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    const runId1 = (prep1.content as { run_id: string }).run_id;

    const submit1 = parseResult(
      await client.callTool({
        name: "review_submit",
        arguments: {
          run_id: runId1,
          verdict: "PASS",
          summary: "Stage 1 looks good.",
          findings: [],
          carry_forward: [
            {
              section: "architecture",
              severity: "info",
              text: "Config-first shape is clean — no hardcoded literals detected.",
            },
          ],
          expand: true,
        },
      }),
    );
    expect(submit1.ok).toBe(true);
    // Stage 2 now allowed.
    const prep2 = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 2, expand: true },
      }),
    );
    expect(prep2.ok).toBe(true);
    // Carry-forward file for stage 2 includes the Stage 1 entry.
    const m = prep2.content as { carry_forward_file: string };
    const cf = await readFile(m.carry_forward_file, "utf8");
    expect(cf).toContain("Config-first shape is clean");
  });

  it("Re-preparing the same stage supersedes the prior run (new id, prior status='superseded')", async () => {
    const { client, projectDb } = await connectProject();
    const first = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    const id1 = (first.content as { run_id: string }).run_id;
    // Brief wait so timestamps differ.
    await new Promise((r) => setTimeout(r, 1100));
    const second = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    const id2 = (second.content as { run_id: string }).run_id;
    expect(id2).not.toBe(id1);
    const firstStatus = (
      projectDb.prepare("SELECT status FROM review_runs WHERE id = ?").get(id1) as {
        status: string;
      }
    ).status;
    expect(firstStatus).toBe("superseded");
  });

  it("review_submit writes a report file with correct frontmatter + carry-forward section", async () => {
    const { client } = await connectProject();
    const prep = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    const runId = (prep.content as { run_id: string }).run_id;
    const sub = parseResult(
      await client.callTool({
        name: "review_submit",
        arguments: {
          run_id: runId,
          verdict: "NEEDS_WORK",
          summary: "Two findings — see below.",
          findings: [
            {
              file: "src/foo.ts",
              line: 42,
              severity: "warning",
              description: "Unbounded loop.",
              required_change: "Bound with a sane default.",
            },
          ],
          carry_forward: [
            {
              section: "verification",
              severity: "warning",
              text: "Add regression test for loop bound.",
            },
          ],
          expand: true,
        },
      }),
    );
    expect(sub.ok).toBe(true);
    const reportPath = (sub.content as { report_path: string }).report_path;
    const body = await readFile(reportPath, "utf8");
    expect(body).toMatch(/verdict: NEEDS_WORK/);
    expect(body).toMatch(/src\/foo\.ts:42/);
    expect(body).toMatch(/Add regression test/);
    expect(body).toMatch(/## Carry-forward/);
  });

  it("review_submit with unknown run_id returns E_NOT_FOUND", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "review_submit",
        arguments: {
          run_id: "code-1-2026-bogus",
          verdict: "PASS",
          summary: "nothing to see here",
        },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_NOT_FOUND");
  });

  it("force=true lets a stage skip prior-PASS requirement (audited)", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 3, force: true, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const m = env.content as { force_used: boolean };
    expect(m.force_used).toBe(true);
  });

  it("review_history filters by type and stage", async () => {
    const { client } = await connectProject();
    await client.callTool({
      name: "review_prepare",
      arguments: { type: "code", stage: 1 },
    });
    const all = parseResult(
      await client.callTool({ name: "review_history", arguments: { expand: true } }),
    );
    expect((all.content as { runs: unknown[] }).runs.length).toBe(1);
    const filtered = parseResult(
      await client.callTool({
        name: "review_history",
        arguments: { type: "security", expand: true },
      }),
    );
    expect((filtered.content as { runs: unknown[] }).runs.length).toBe(0);
  });
});
