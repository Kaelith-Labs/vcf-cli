import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb } from "../../src/db/global.js";
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

describe("M4 global-scope fan-out", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m4-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-m4h-")));
    kbRoot = join(home, ".vcf", "kb");
    await mkdir(join(kbRoot, "primers"), { recursive: true });
    await mkdir(join(kbRoot, "best-practices"), { recursive: true });
    await writeFile(
      join(kbRoot, "primers", "typescript.md"),
      [
        "---",
        "type: primer",
        "primer_name: typescript",
        "category: lang",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["typescript", "node"]',
        "---",
        "TypeScript primer body.",
      ].join("\n"),
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
        'tags: ["mcp", "llm", "typescript"]',
        "---",
        "MCP primer body.",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "best-practices", "security.md"),
      [
        "---",
        "type: best-practices",
        "best_practice_name: security",
        "category: security",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["security"]',
        "---",
        "Security body.",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function connectGlobal() {
    const config = ConfigSchema.parse({
      version: 1,
      workspace: {
        allowed_roots: [workRoot],
        ideas_dir: join(workRoot, "ideas"),
        specs_dir: join(workRoot, "specs"),
      },
      endpoints: [
        {
          name: "local-ollama",
          provider: "openai-compatible",
          base_url: "http://127.0.0.1:11434/v1",
          trust_level: "local",
          auth_env_var: "OLLAMA_API_KEY",
        },
        {
          name: "anthropic-main",
          provider: "anthropic",
          base_url: "https://api.anthropic.com",
          trust_level: "public",
          auth_env_var: "ANTHROPIC_API_KEY",
        },
      ],
      model_aliases: [
        {
          alias: "planner",
          endpoint: "anthropic-main",
          model_id: "claude-opus-4-7",
          prefer_for: ["planning"],
        },
        {
          alias: "builder",
          endpoint: "local-ollama",
          model_id: "gemma-3-12b",
          prefer_for: ["building"],
        },
      ],
      kb: { root: kbRoot },
    });
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const resolved: ResolvedScope = { scope: "global" };
    const server = createServer({ scope: "global", resolved, config, globalDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, globalDb, config };
  }

  it("lists every expected tool under global scope", async () => {
    const { client } = await connectGlobal();
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((t) => t.name));
    for (const expected of [
      "vcf_ping",
      "idea_capture",
      "idea_search",
      "idea_get",
      "spec_template",
      "spec_save",
      "spec_get",
      "spec_suggest_primers",
      "project_init",
      "config_get",
      "endpoint_list",
      "primer_list",
      "model_list",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("idea_capture → idea_search → idea_get round-trip", async () => {
    const { client } = await connectGlobal();
    await client.callTool({
      name: "idea_capture",
      arguments: { content: "Build a queue.", title: "Queue", tags: ["infra"] },
    });
    await client.callTool({
      name: "idea_capture",
      arguments: { content: "Build a cache.", title: "Cache", tags: ["infra", "perf"] },
    });
    const searchRes = await client.callTool({
      name: "idea_search",
      arguments: { tags: ["perf"], expand: true },
    });
    const env = parseResult(searchRes);
    const hits = (env.content as { path: string; slug: string }[]) ?? [];
    expect(hits.length).toBe(1);
    expect(hits[0]?.slug).toBe("cache");

    const getRes = await client.callTool({
      name: "idea_get",
      arguments: { slug: "cache", expand: true },
    });
    const envGet = parseResult(getRes);
    expect(envGet.ok).toBe(true);
    expect(typeof envGet.content).toBe("string");
    expect((envGet.content as string).includes("Build a cache")).toBe(true);
  });

  it("spec_template returns a rendered template; spec_save validates frontmatter", async () => {
    const { client } = await connectGlobal();
    const tpl = await client.callTool({
      name: "spec_template",
      arguments: { project_name: "Demo", expand: true },
    });
    const tplEnv = parseResult(tpl);
    const content = tplEnv.content as { template: string; suggested_slug: string };
    expect(content.suggested_slug).toBe("demo");
    expect(content.template).toMatch(/title: "Demo"/);

    // A good spec.
    const spec = [
      "---",
      'title: "Demo"',
      "status: draft",
      "created: 2026-04-19",
      'tech_stack: ["typescript", "mcp"]',
      'tags: ["dev-tooling"]',
      "---",
      "",
      "# Demo Spec",
      "",
      "Body goes here.",
    ].join("\n");
    const saveRes = await client.callTool({
      name: "spec_save",
      arguments: { content: spec, expand: true },
    });
    const saveEnv = parseResult(saveRes);
    expect(saveEnv.ok).toBe(true);
    const saved = (saveEnv.content as { path: string; slug: string }).path;
    expect(saved.endsWith("2026-04-19-demo.md")).toBe(true);
    const onDisk = await readFile(saved, "utf8");
    expect(onDisk).toContain("# Demo Spec");

    // Bad spec: missing tech_stack type (string instead of array).
    const badSpec = [
      "---",
      'title: "Bad"',
      "status: draft",
      "created: 2026-04-19",
      'tech_stack: "not-a-list"',
      "---",
      "body".padEnd(64, " "),
    ].join("\n");
    const badRes = await client.callTool({
      name: "spec_save",
      arguments: { content: badSpec },
    });
    const badEnv = parseResult(badRes);
    expect(badEnv.ok).toBe(false);
    expect(badEnv.code).toBe("E_VALIDATION");
  });

  it("spec_suggest_primers ranks KB entries by the saved spec's tags", async () => {
    const { client } = await connectGlobal();
    const spec = [
      "---",
      'title: "Demo"',
      "status: draft",
      "created: 2026-04-19",
      'tech_stack: ["typescript", "mcp"]',
      'lens: ["security"]',
      "---",
      "",
      "body".padEnd(64, " "),
    ].join("\n");
    await client.callTool({ name: "spec_save", arguments: { content: spec } });
    const sug = await client.callTool({
      name: "spec_suggest_primers",
      arguments: { spec_slug: "demo", expand: true },
    });
    const env = parseResult(sug);
    expect(env.ok).toBe(true);
    const list = (env.content as { suggestions: { id: string; score: number }[] }).suggestions;
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Most-specific match wins first.
    expect(list[0]?.id).toBe("primers/mcp");
  });

  it("config_get redacts endpoint secret values, returns var names only", async () => {
    const { client } = await connectGlobal();
    const res = await client.callTool({
      name: "config_get",
      arguments: { section: "endpoints", expand: true },
    });
    const env = parseResult(res);
    const body = (env.content as { endpoints: Array<{ auth_env_var?: string; value?: string }> })
      .endpoints;
    expect(body[0]?.auth_env_var).toBe("OLLAMA_API_KEY");
    expect(body[0]).not.toHaveProperty("value");
  });

  it("endpoint_list filters by trust_level", async () => {
    const { client } = await connectGlobal();
    const res = await client.callTool({
      name: "endpoint_list",
      arguments: { trust_level: "local", expand: true },
    });
    const env = parseResult(res);
    const endpoints = (env.content as { endpoints: { name: string; trust_level: string }[] })
      .endpoints;
    expect(endpoints.length).toBe(1);
    expect(endpoints[0]?.name).toBe("local-ollama");
  });

  it("model_list filters by prefer_for", async () => {
    const { client } = await connectGlobal();
    const res = await client.callTool({
      name: "model_list",
      arguments: { prefer_for: "planning", expand: true },
    });
    const env = parseResult(res);
    const aliases = (env.content as { model_aliases: { alias: string }[] }).model_aliases;
    expect(aliases.map((a) => a.alias)).toEqual(["planner"]);
  });

  it("primer_list returns metadata for the seeded KB with tag filter", async () => {
    const { client } = await connectGlobal();
    const all = await client.callTool({ name: "primer_list", arguments: { expand: true } });
    const allEnv = parseResult(all);
    const allEntries = (allEnv.content as { entries: { id: string }[] }).entries;
    expect(allEntries.length).toBe(3);

    const tsOnly = await client.callTool({
      name: "primer_list",
      arguments: { tags: ["typescript"], expand: true },
    });
    const tsEnv = parseResult(tsOnly);
    const tsEntries = (tsEnv.content as { entries: { id: string }[] }).entries;
    expect(tsEntries.map((e) => e.id).sort()).toEqual(["primers/mcp", "primers/typescript"]);
  });
});
