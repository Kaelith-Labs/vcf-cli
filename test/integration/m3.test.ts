import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  paths?: string[];
  summary?: string;
  content?: unknown;
  code?: string;
  message?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool result has no text content");
  return JSON.parse(text) as Envelope;
}

describe("M3 end-to-end skeleton spike (global scope)", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m3-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-home-")));
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
    const resolved: ResolvedScope = { scope: "global" };
    const server = createServer({ scope: "global", resolved, config, globalDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, server, globalDb };
  }

  it("vcf_ping returns a summary with scope + version", async () => {
    const { client } = await connectGlobal();
    const result = await client.callTool({ name: "vcf_ping", arguments: {} });
    const env = parseResult(result);
    expect(env.ok).toBe(true);
    expect(env.summary).toMatch(/global scope/);
  });

  it("idea_capture writes a file under ideas_dir and indexes the row", async () => {
    const { client, globalDb } = await connectGlobal();
    const result = await client.callTool({
      name: "idea_capture",
      arguments: {
        content: "Build a better mousetrap.",
        title: "Better Mousetrap",
        tags: ["hardware", "mechanical"],
      },
    });
    const env = parseResult(result);
    expect(env.ok).toBe(true);
    expect(env.paths).toBeDefined();
    expect(env.paths?.[0]).toMatch(/ideas[/\\]\d{4}-\d{2}-\d{2}-better-mousetrap\.md$/);
    // file exists
    const body = await readFile(env.paths![0]!, "utf8");
    expect(body).toMatch(/---/);
    expect(body).toMatch(/Build a better mousetrap/);
    // db has one row
    const count = (globalDb.prepare("SELECT COUNT(*) as c FROM ideas").get() as { c: number }).c;
    expect(count).toBe(1);
    // audit row written
    const audit = (
      globalDb.prepare("SELECT COUNT(*) as c FROM audit WHERE tool='idea_capture'").get() as {
        c: number;
      }
    ).c;
    expect(audit).toBe(1);
  });

  it("idea_capture rejects tags that are not kebab-case", async () => {
    const { client } = await connectGlobal();
    // The SDK parses inputs against the Zod schema before the handler runs.
    // Validation failures come back as a tool result with isError=true and
    // a text content block carrying the JSON-RPC invalid-params message.
    const result = (await client.callTool({
      name: "idea_capture",
      arguments: { content: "hello", tags: ["BadTag"] },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? "";
    expect(text).toMatch(/Invalid|pattern|regex/);
  });

  it("project_init scaffolds templates, .mcp.json, project.db, git init", async () => {
    const { client } = await connectGlobal();
    const target = join(workRoot, "demo");
    const result = await client.callTool({
      name: "project_init",
      arguments: { name: "Demo Project", target_dir: target, expand: true },
    });
    const env = parseResult(result);
    expect(env.ok).toBe(true);
    // content should have a file list
    const content = env.content as { written: string[]; project_db: string; mcp_json: string };
    expect(content.written.length).toBeGreaterThan(5);
    // Key files exist
    for (const rel of ["AGENTS.md", "CLAUDE.md", "README.md", ".gitignore", ".mcp.json"]) {
      const body = await readFile(join(target, rel), "utf8");
      expect(body.length).toBeGreaterThan(0);
    }
    // project.db exists and has the singleton row
    const pdb = openProjectDb({ path: join(target, ".vcf", "project.db") });
    const row = pdb.prepare("SELECT name, state FROM project WHERE id=1").get() as
      | { name: string; state: string }
      | undefined;
    expect(row?.name).toBe("Demo Project");
    expect(row?.state).toBe("draft");
    pdb.close();
    // .mcp.json has a vcf block
    const mcpRaw = await readFile(join(target, ".mcp.json"), "utf8");
    const mcp = JSON.parse(mcpRaw) as { mcpServers: { vcf: { args: string[] } } };
    expect(mcp.mcpServers.vcf.args).toContain("--scope");
    expect(mcp.mcpServers.vcf.args).toContain("project");
  });

  it("project_init with force=false on existing non-empty dir returns E_ALREADY_EXISTS", async () => {
    const { client } = await connectGlobal();
    const target = join(workRoot, "existing");
    // Create the directory with something in it.
    await import("node:fs/promises").then((fs) => fs.mkdir(target, { recursive: true }));
    const first = await client.callTool({
      name: "project_init",
      arguments: { name: "First", target_dir: target },
    });
    // The first call succeeds because the dir is empty.
    expect(parseResult(first).ok).toBe(true);
    // The second call must fail because the dir now contains files.
    const second = await client.callTool({
      name: "project_init",
      arguments: { name: "Second", target_dir: target },
    });
    const env = parseResult(second);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_ALREADY_EXISTS");
  });
});

describe("M3 project scope (portfolio_status)", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m3p-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-homep-")));
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("portfolio_status returns state=draft after project_init", async () => {
    const target = join(workRoot, "demo");
    // First, init the project under global scope.
    {
      const config = ConfigSchema.parse({
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
      const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
      const server = createServer({
        scope: "global",
        resolved: { scope: "global" },
        config,
        globalDb,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(b);
      const result = await client.callTool({
        name: "project_init",
        arguments: { name: "Demo Project", target_dir: target },
      });
      expect(parseResult(result).ok).toBe(true);
      globalDb.close();
    }

    // Now boot a fresh server in project scope pointed at that dir.
    const config = ConfigSchema.parse({
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
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDb = openProjectDb({ path: join(target, ".vcf", "project.db") });
    const server = createServer({
      scope: "project",
      resolved: {
        scope: "project",
        vcfDir: join(target, ".vcf"),
        projectDbPath: join(target, ".vcf", "project.db"),
      },
      config,
      globalDb,
      projectDb,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(b);
    const result = await client.callTool({ name: "portfolio_status", arguments: { expand: true } });
    const env = parseResult(result);
    expect(env.ok).toBe(true);
    expect(env.summary).toMatch(/state=draft/);
    const content = env.content as { state: string; next_action: string; name: string };
    expect(content.state).toBe("draft");
    expect(content.name).toBe("Demo Project");
    globalDb.close();
    projectDb.close();
  });
});
