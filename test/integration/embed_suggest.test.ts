import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { clearKbCache } from "../../src/primers/load.js";
import type { ResolvedScope } from "../../src/scope.js";
import { writeEmbeddingRecord } from "../../src/primers/embed.js";

interface Envelope {
  ok: boolean;
  content?: unknown;
}
function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  return JSON.parse(r.content?.[0]?.text ?? "{}") as Envelope;
}

// Stub an OpenAI-compatible /embeddings response with a preset vector.
function embeddingFetch(vector: number[]): typeof fetch {
  return (async (): Promise<Response> => {
    const payload = { data: [{ embedding: vector, index: 0 }] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("spec_suggest_primers — blended scoring with embeddings", () => {
  let workRoot: string;
  let home: string;
  let kbRoot: string;
  let cacheDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-esug-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-esugh-")));
    kbRoot = join(home, ".vcf", "kb");
    cacheDir = join(home, ".vcf", "embeddings");
    await mkdir(join(kbRoot, "primers"), { recursive: true });
    await mkdir(join(kbRoot, "best-practices"), { recursive: true });

    await writeFile(
      join(kbRoot, "primers", "typescript.md"),
      [
        "---",
        "type: primer",
        "primer_name: typescript",
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
        "version: 2",
        "updated: 2026-04-18",
        'tags: ["mcp", "typescript"]',
        "---",
        "MCP primer body.",
      ].join("\n"),
    );
    clearKbCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function makeConfig(embeddings?: {
    endpoint: string;
    model: string;
    blend_weight?: number;
    cache_dir?: string;
  }) {
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
      ],
      kb: { root: kbRoot },
      ...(embeddings ? { embeddings: { cache_dir: cacheDir, ...embeddings } } : {}),
    });
  }

  async function connectGlobal(config: ReturnType<typeof makeConfig>) {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const resolved: ResolvedScope = { scope: "global" };
    const server = createServer({ scope: "global", resolved, config, globalDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client };
  }

  async function saveDemoSpec(client: Client): Promise<void> {
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
  }

  it("falls back to tag-only when embeddings config is absent (scoring=tag)", async () => {
    const { client } = await connectGlobal(makeConfig());
    await saveDemoSpec(client);
    const env = parseResult(
      await client.callTool({
        name: "spec_suggest_primers",
        arguments: { spec_slug: "demo", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as { scoring: string };
    expect(c.scoring).toBe("tag");
  });

  it("falls back to tag-only when embeddings configured but cache is empty", async () => {
    const { client } = await connectGlobal(
      makeConfig({ endpoint: "local-ollama", model: "nomic-embed-text", blend_weight: 0.5 }),
    );
    await saveDemoSpec(client);
    const env = parseResult(
      await client.callTool({
        name: "spec_suggest_primers",
        arguments: { spec_slug: "demo", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    expect((env.content as { scoring: string }).scoring).toBe("tag");
  });

  it("blends when the cache is populated + the endpoint returns a query vector", async () => {
    // Pre-populate the cache with vectors that strongly favor `typescript`
    // over `mcp` when compared against the stubbed query vector.
    const queryVec = [1, 0, 0];
    vi.stubGlobal("fetch", embeddingFetch(queryVec));

    await writeEmbeddingRecord(cacheDir, "primers/typescript", {
      model: "nomic-embed-text",
      dim: 3,
      content_sha256: "t",
      vector: [1, 0, 0], // cosine with query = 1
      updated_at: Date.now(),
    });
    await writeEmbeddingRecord(cacheDir, "primers/mcp", {
      model: "nomic-embed-text",
      dim: 3,
      content_sha256: "m",
      vector: [0, 1, 0], // cosine with query = 0
      updated_at: Date.now(),
    });

    // Pure-cosine blend_weight=1 forces the cosine signal to dominate so
    // typescript should win over mcp even though mcp has more tag hits.
    const { client } = await connectGlobal(
      makeConfig({ endpoint: "local-ollama", model: "nomic-embed-text", blend_weight: 1 }),
    );
    await saveDemoSpec(client);
    const env = parseResult(
      await client.callTool({
        name: "spec_suggest_primers",
        arguments: { spec_slug: "demo", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as {
      scoring: string;
      suggestions: Array<{ id: string; score: number }>;
    };
    expect(c.scoring).toBe("blended");
    expect(c.suggestions[0]?.id).toBe("primers/typescript");
  });

  it("falls back to tag-only when the embedding endpoint is unreachable at query time", async () => {
    await writeEmbeddingRecord(cacheDir, "primers/typescript", {
      model: "nomic-embed-text",
      dim: 3,
      content_sha256: "t",
      vector: [1, 0, 0],
      updated_at: Date.now(),
    });
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);

    const { client } = await connectGlobal(
      makeConfig({ endpoint: "local-ollama", model: "nomic-embed-text", blend_weight: 0.5 }),
    );
    await saveDemoSpec(client);
    const env = parseResult(
      await client.callTool({
        name: "spec_suggest_primers",
        arguments: { spec_slug: "demo", expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    expect((env.content as { scoring: string }).scoring).toBe("tag");
  });
});
