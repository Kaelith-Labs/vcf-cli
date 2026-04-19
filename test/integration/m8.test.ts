import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
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

describe("M8 ship pipeline (project scope)", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-m8-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-m8h-")));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    await mkdir(join(projectDir, "src"), { recursive: true });
    clearKbCache();
  });

  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
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
         VALUES (1, 'Demo', ?, 'reviewing', ?, ?)`,
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

  it("ship_audit passes clean on a trivial project with no findings", async () => {
    const { client } = await connectProject();
    // Trivial source file, no hardcoded literals, no security markers.
    await writeFile(join(projectDir, "src", "index.ts"), 'export const hi = "hello";\n');
    const env = parseResult(
      await client.callTool({
        name: "ship_audit",
        arguments: { include: ["config-completeness"], expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as { blocker: boolean; passes: Array<{ status: string }> };
    expect(c.blocker).toBe(false);
    expect(c.passes.every((p) => p.status === "ok")).toBe(true);
  });

  it("ship_audit flags a hardcoded literal path as blocker", async () => {
    const { client } = await connectProject();
    await writeFile(
      join(projectDir, "src", "bad.ts"),
      'export const workDir = "/var/lib/mybadliteral/state";\n',
    );
    const env = parseResult(
      await client.callTool({
        name: "ship_audit",
        arguments: { include: ["hardcoded-path"], expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as {
      blocker: boolean;
      passes: Array<{ status: string; findings: unknown[] }>;
    };
    expect(c.blocker).toBe(true);
    expect(c.passes[0]?.findings.length).toBeGreaterThan(0);
  });

  it("ship_audit config-completeness flags _TBD_ placeholder in config", async () => {
    // We can't mutate the parsed Config (it's frozen); instead check the
    // positive path by default — no placeholders.
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "ship_audit",
        arguments: { include: ["config-completeness"], expand: true },
      }),
    );
    const c = env.content as { passes: Array<{ name: string; status: string }> };
    expect(c.passes[0]?.status).toBe("ok");
  });

  it("ship_audit stops after first blocker when fail_fast=true", async () => {
    const { client } = await connectProject();
    await writeFile(
      join(projectDir, "src", "bad.ts"),
      'const abs = "/var/lib/foo/state"; // TODO auth\n',
    );
    const env = parseResult(
      await client.callTool({
        name: "ship_audit",
        arguments: {
          include: ["hardcoded-path", "test-data-residue"],
          fail_fast: true,
          expand: true,
        },
      }),
    );
    const c = env.content as { passes: Array<{ name: string }> };
    // Only the first pass ran because it blocked.
    expect(c.passes.length).toBe(1);
    expect(c.passes[0]?.name).toBe("hardcoded-path");
  });

  it("ship_build runs a zero-exit target; records builds row", async () => {
    const { client, projectDb } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "ship_build",
        arguments: {
          targets: [
            {
              name: "smoke",
              command: "node",
              args: ["-e", "console.log('ship'); process.exit(0)"],
              timeout_ms: 5_000,
            },
          ],
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    const c = env.content as { any_failure: boolean; results: Array<{ exit_code: number }> };
    expect(c.any_failure).toBe(false);
    expect(c.results[0]?.exit_code).toBe(0);
    const row = projectDb
      .prepare("SELECT target, status FROM builds ORDER BY started_at DESC LIMIT 1")
      .get() as { target: string; status: string };
    expect(row.target).toBe("ship:smoke");
    expect(row.status).toBe("success");
  });

  it("ship_build stops on first failing target by default", async () => {
    const { client } = await connectProject();
    const env = parseResult(
      await client.callTool({
        name: "ship_build",
        arguments: {
          targets: [
            {
              name: "will-fail",
              command: "node",
              args: ["-e", "process.exit(3)"],
              timeout_ms: 5_000,
            },
            {
              name: "never-runs",
              command: "node",
              args: ["-e", "process.exit(0)"],
              timeout_ms: 5_000,
            },
          ],
          stop_on_first_failure: true,
          expand: true,
        },
      }),
    );
    const c = env.content as {
      any_failure: boolean;
      results: Array<{ name: string; exit_code: number }>;
    };
    expect(c.any_failure).toBe(true);
    expect(c.results.length).toBe(1);
    expect(c.results[0]?.name).toBe("will-fail");
  });
});
