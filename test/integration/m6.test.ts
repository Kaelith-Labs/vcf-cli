import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

describe("M6 test pipeline (project scope)", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "vcf-m6-"));
    home = await mkdtemp(join(tmpdir(), "vcf-m6h-"));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    clearKbCache();
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function connectProject() {
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

  it("test_generate returns one stub per requested kind", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "test_generate",
        arguments: {
          kinds: ["unit", "prompt-injection", "volume"],
          scale_target: 500,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const stubs = (env.content as { stubs: Array<{ kind: string; body: string }> }).stubs;
    expect(stubs.map((s) => s.kind)).toEqual(["unit", "prompt-injection", "volume"]);
    // volume stub references the 10× scale
    expect(stubs.find((s) => s.kind === "volume")?.body).toContain("5000");
  });

  it("test_execute runs a zero-exit command successfully", async () => {
    const { client, projectDb } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "test_execute",
        arguments: {
          command: "node",
          args: ["-e", "console.log('ran'); process.exit(0)"],
          timeout_ms: 5_000,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as { exit_code: number; stdout_tail: string; timed_out: boolean };
    expect(c.exit_code).toBe(0);
    expect(c.stdout_tail).toContain("ran");
    expect(c.timed_out).toBe(false);
    // build row written
    const count = (projectDb.prepare("SELECT COUNT(*) as c FROM builds").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("test_execute returns exit_code=1 for a failing command; envelope ok remains true", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "test_execute",
        arguments: {
          command: "node",
          args: ["-e", "process.stderr.write('boom\\n'); process.exit(2)"],
          timeout_ms: 5_000,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true); // the call itself succeeded; only the subprocess failed
    const c = env.content as { exit_code: number; stderr_tail: string };
    expect(c.exit_code).toBe(2);
    expect(c.stderr_tail).toContain("boom");
  });

  it("test_execute kills a runaway command via timeout_ms", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "test_execute",
        arguments: {
          command: "node",
          args: ["-e", "setInterval(()=>{}, 1000)"],
          timeout_ms: 1_000,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as { timed_out: boolean; signal: string | null };
    expect(c.timed_out).toBe(true);
    // killed via SIGTERM (or SIGKILL if escalated)
    expect(["SIGTERM", "SIGKILL"]).toContain(c.signal);
  });

  it("test_analyze detects pytest-style failures and counts them", async () => {
    const { client } = await connectProject();
    const stdout = [
      "tests/test_a.py::test_one PASSED",
      "tests/test_b.py::test_two PASSED",
      "FAILED tests/test_c.py::test_three",
      "FAILED tests/test_d.py::test_four",
      "===== 2 failed, 2 passed in 0.42s =====",
    ].join("\n");
    const env = parseResult(
      await client.callTool({
        name: "test_analyze",
        arguments: {
          stdout,
          stderr: "",
          exit_code: 1,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as {
      passed: boolean;
      failure_count: number;
      suspected_runner: string;
      reported: Array<{ line: string }>;
    };
    expect(c.passed).toBe(false);
    expect(c.failure_count).toBe(2);
    expect(c.suspected_runner).toBe("pytest");
    expect(c.reported[0]?.line).toContain("tests/test_c.py::test_three");
  });

  it("test_analyze returns passed=true on exit_code=0 and no failure signatures", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "test_analyze",
        arguments: {
          stdout: "ok — all tests passed",
          stderr: "",
          exit_code: 0,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    expect((env.content as { passed: boolean }).passed).toBe(true);
  });

  it("test_analyze reports the 'no known signature' note when exit != 0 but nothing matches", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "test_analyze",
        arguments: {
          stdout: "some random log output nothing to see",
          stderr: "",
          exit_code: 1,
          expand: true,
        },
      }),
    );
    const c = env.content as { passed: boolean; note: string | null };
    expect(c.passed).toBe(false);
    expect(c.note).toMatch(/No known failure signature/);
  });
});
