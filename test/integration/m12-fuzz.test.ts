import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ResolvedScope } from "../../src/scope.js";

// M12 fuzz: for each registered tool, hit it with a handful of malformed
// shapes and confirm the client either gets a schema rejection (isError
// content) or a stable E_* envelope. This is the catch-all "nothing the
// LLM can send should crash the server" test.

interface Envelope {
  ok: boolean;
  code?: string;
}

function parseEnvelopeOrNull(result: unknown): Envelope | null {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  if (r.isError === true) return null; // schema-level rejection
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return null;
  }
}

describe("M12 fuzz: every tool rejects malformed input safely", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m12-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-m12h-")));
  });
  afterEach(async () => {
    closeTrackedDbs();
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
      kb: { root: join(home, ".vcf", "kb") },
    });
  }

  async function connectGlobal() {
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
    return { client };
  }

  async function connectProject() {
    const projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
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
    return { client };
  }

  // Test table: [scope, tool name, list of malformed argument objects]
  const GLOBAL_FUZZ: Array<[string, unknown[]]> = [
    ["idea_capture", [{}, { content: "" }, { content: 42 }, { content: "x", tags: ["BadTag"] }]],
    ["idea_search", [{ tags: ["BadTag"] }, { limit: 99999 }]],
    ["idea_get", [{}, { slug: "" }]],
    ["spec_template", [{}, { project_name: "" }]],
    ["spec_save", [{}, { content: "too-short" }, { content: "no-frontmatter-here".repeat(10) }]],
    ["spec_get", [{}, { slug: "" }]],
    ["spec_suggest_primers", [{}, { tech_tags: [] }]],
    [
      "project_init",
      [{}, { name: "", target_dir: "" }, { name: "X", target_dir: "relative/path" }],
    ],
    ["config_get", [{ section: "bogus" }]],
    ["endpoint_list", [{ trust_level: "untrusted" }]],
    ["model_list", [{ prefer_for: "BadFormat" }]],
    ["primer_list", [{ kind: "bogus" }, { tags: ["BadTag"] }]],
  ];

  const PROJECT_FUZZ: Array<[string, unknown[]]> = [
    ["portfolio_status", [{ expand: "not-a-bool" }]],
    ["plan_context", [{}, { name: "" }]],
    ["plan_save", [{}, { name: "x", plan: "short", todo: "", manifest: "" }]],
    ["plan_get", [{}, { name: "" }]],
    ["build_context", [{}, { plan_name: "" }, { plan_name: "x", builder_type: "bogus" }]],
    ["build_swap", [{}, { from_type: "bogus", to_type: "frontend", plan_name: "x" }]],
    ["decision_log_add", [{}, { title: "", context: "", decision: "", consequences: "" }]],
    ["decision_log_list", [{ limit: -1 }]],
    ["response_log_add", [{}, { review_run_id: "", stance: "maybe", note: "" }]],
    ["test_generate", [{ kinds: ["bogus"] }, { dependencies: ["BadFormat"] }]],
    ["test_execute", [{}, { command: "" }]],
    ["test_analyze", [{ exit_code: "not-a-number" }]],
    ["review_prepare", [{}, { type: "bogus", stage: 1 }, { type: "code", stage: 99 }]],
    ["review_submit", [{}, { run_id: "x", verdict: "MAYBE", summary: "" }]],
    ["review_history", [{ type: "bogus" }, { stage: 99 }]],
    ["ship_audit", [{ include: ["BadName"] }]],
    ["ship_build", [{ targets: [] }, { targets: [{ name: "x", command: "" }] }]],
  ];

  it("global-scope tools reject every malformed shape", async () => {
    const { client } = await connectGlobal();
    for (const [name, shapes] of GLOBAL_FUZZ) {
      for (const args of shapes) {
        const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
        const asObj = r as { isError?: boolean };
        const env = parseEnvelopeOrNull(r);
        // Either: SDK-level schema rejection (isError=true) OR our envelope
        // with ok=false and a known E_* code.
        const okShape =
          asObj.isError === true ||
          (env !== null && env.ok === false && typeof env.code === "string");
        if (!okShape) {
          console.error(`fuzz leak: ${name}`, args, r);
        }
        expect(okShape).toBe(true);
      }
    }
  });

  it("project-scope tools reject every malformed shape", async () => {
    const { client } = await connectProject();
    for (const [name, shapes] of PROJECT_FUZZ) {
      for (const args of shapes) {
        const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
        const asObj = r as { isError?: boolean };
        const env = parseEnvelopeOrNull(r);
        const okShape =
          asObj.isError === true ||
          (env !== null && env.ok === false && typeof env.code === "string");
        if (!okShape) {
          console.error(`fuzz leak: ${name}`, args, r);
        }
        expect(okShape).toBe(true);
      }
    }
  });

  it("unknown tool names return an isError=true result (not a server crash)", async () => {
    const { client } = await connectGlobal();
    const r = (await client.callTool({ name: "nonexistent_tool", arguments: {} })) as {
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
  });
});
