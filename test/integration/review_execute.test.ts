import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Return a canned chat-completions response body shaped like OpenAI's.
function makeFetchStub(responseJson: unknown): typeof fetch {
  return (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    // Capture body for assertions if the test wants to inspect.
    void init?.body;
    const payload = {
      choices: [{ message: { content: JSON.stringify(responseJson) } }],
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("review_execute (server-side LLM review)", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-rex-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-rexh-")));
    kbRoot = join(home, ".vcf", "kb");
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(kbRoot, "review-system", "code"), { recursive: true });
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });

    await writeFile(
      join(kbRoot, "review-system", "code", "01-test-stage.md"),
      [
        "---",
        "type: review-stage",
        "review_type: code",
        "stage: 1",
        "stage_name: test-stage-1",
        "version: 0.1",
        "updated: 2026-04-18",
        "---",
        "# Stage 1 body — inspect the diff",
      ].join("\n"),
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      [
        "---",
        "type: reviewer-config",
        "reviewer_type: code",
        "version: 0.1",
        "updated: 2026-04-18",
        "---",
        "# Code Reviewer Config\nYou are an independent code reviewer.",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function makeConfig(extraEndpoints: unknown[] = []) {
    return ConfigSchema.parse({
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
        },
        ...extraEndpoints,
      ],
      kb: { root: kbRoot },
    });
  }

  async function connectProject(configOverride?: ReturnType<typeof makeConfig>) {
    const config = configOverride ?? makeConfig();
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

  async function prepareRun(client: Client): Promise<string> {
    const env = parseResult(
      await client.callTool({
        name: "review_prepare",
        arguments: { type: "code", stage: 1, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const content = env.content as { run_id: string };
    return content.run_id;
  }

  it("runs a PASS verdict end-to-end against a stubbed OpenAI-compatible endpoint", async () => {
    const { client, projectDb } = await connectProject();
    const runId = await prepareRun(client);

    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        verdict: "PASS",
        summary: "diff is tight; no architectural concerns surfaced.",
        findings: [
          {
            file: "src/foo.ts",
            line: 42,
            severity: "info",
            description: "naming could be tightened but does not block",
          },
        ],
        carry_forward: [
          {
            section: "architecture",
            severity: "info",
            text: "stage 1 confirms layering is clean; no re-litigation needed",
          },
        ],
      }),
    );

    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: {
          run_id: runId,
          endpoint: "local-ollama",
          model_id: "qwen2.5-coder:14b",
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as {
      verdict: string;
      report_path: string;
      endpoint: string;
      model_id: string;
    };
    expect(c.verdict).toBe("PASS");
    expect(c.endpoint).toBe("local-ollama");
    expect(c.model_id).toBe("qwen2.5-coder:14b");

    // Report file was written with the parsed verdict.
    const report = await readFile(c.report_path, "utf8");
    expect(report).toMatch(/verdict: PASS/);
    expect(report).toMatch(/src\/foo\.ts/);

    // DB row flipped to submitted.
    const row = projectDb
      .prepare(`SELECT status, verdict FROM review_runs WHERE id = ?`)
      .get(runId) as { status: string; verdict: string };
    expect(row.status).toBe("submitted");
    expect(row.verdict).toBe("PASS");
  });

  it("refuses public endpoints without allow_public_endpoint=true", async () => {
    const config = makeConfig([
      {
        name: "openrouter",
        provider: "openai-compatible",
        base_url: "https://openrouter.ai/api/v1",
        auth_env_var: "OPENROUTER_API_KEY",
        trust_level: "public",
      },
    ]);
    const { client } = await connectProject(config);
    const runId = await prepareRun(client);

    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: runId, endpoint: "openrouter" },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_STATE_INVALID");
  });

  it("requires the endpoint's auth env var for non-local endpoints", async () => {
    const config = makeConfig([
      {
        name: "openrouter",
        provider: "openai-compatible",
        base_url: "https://openrouter.ai/api/v1",
        auth_env_var: "OPENROUTER_API_KEY_TEST_ONLY_DO_NOT_SET",
        trust_level: "trusted",
      },
    ]);
    const { client } = await connectProject(config);
    const runId = await prepareRun(client);

    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: runId, endpoint: "openrouter" },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_CONFIG_MISSING_ENV");
  });

  it("surfaces E_ENDPOINT_UNREACHABLE when the endpoint is down", async () => {
    const { client } = await connectProject();
    const runId = await prepareRun(client);

    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:11434");
    }) as typeof fetch);

    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: runId, endpoint: "local-ollama" },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_ENDPOINT_UNREACHABLE");
  });

  it("surfaces E_VALIDATION when the endpoint returns an unparseable verdict", async () => {
    const { client } = await connectProject();
    const runId = await prepareRun(client);

    vi.stubGlobal("fetch", (async (): Promise<Response> => {
      const payload = {
        choices: [{ message: { content: "I decline to respond as a JSON object." } }],
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: runId, endpoint: "local-ollama" },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_VALIDATION");
  });

  it("rejects unknown endpoint names", async () => {
    const { client } = await connectProject();
    const runId = await prepareRun(client);

    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: runId, endpoint: "no-such-endpoint" },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_VALIDATION");
  });

  it("rejects nonexistent run_ids", async () => {
    const { client } = await connectProject();

    const env = parseResult(
      await client.callTool({
        name: "review_execute",
        arguments: { run_id: "code-ghost", endpoint: "local-ollama" },
      }),
    );
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_NOT_FOUND");
  });
});
