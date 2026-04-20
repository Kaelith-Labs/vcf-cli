// project_init auto-registers into the global registry.
// plan_save mirrors state_cache + projects depends_on from plan
// frontmatter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { listProjects, getProjectByRoot } from "../../src/util/projectRegistry.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  content?: unknown;
  paths?: string[];
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("auto-registration in project_init + state mirror in plan_save", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-auto-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-autoh-")));
    await mkdir(join(home, ".vcf"), { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  function baseConfig() {
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

  async function connectGlobal(globalDb: ReturnType<typeof openGlobalDb>) {
    const config = baseConfig();
    const resolved: ResolvedScope = { scope: "global" };
    const server = createServer({ scope: "global", resolved, config, globalDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return client;
  }

  it("project_init (default register=true) adds the project to the global registry", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);
    const target = join(workRoot, "demo");
    const env = parseResult(
      await client.callTool({
        name: "project_init",
        arguments: { name: "Demo Project", target_dir: target, expand: true },
      }),
    );
    expect(env.ok).toBe(true);
    const registered = getProjectByRoot(globalDb, target);
    expect(registered).not.toBeNull();
    expect(registered?.name).toBe("demo-project");
    expect(registered?.state_cache).toBe("draft");
  });

  it("project_init with register=false does NOT add to the registry", async () => {
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const client = await connectGlobal(globalDb);
    const target = join(workRoot, "demo2");
    const env = parseResult(
      await client.callTool({
        name: "project_init",
        arguments: {
          name: "Demo Two",
          target_dir: target,
          register: false,
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);
    expect(listProjects(globalDb)).toHaveLength(0);
  });

  it("plan_save mirrors state_cache to the registry and projects depends_on from frontmatter", async () => {
    // Set up a registered project with a project.db directly (skip project_init
    // for simplicity in this focused test).
    const globalDb = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    const projectDir = join(workRoot, "app");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
    const projectDb = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    projectDb
      .prepare(
        `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
         VALUES (1, 'app', ?, 'draft', ?, ?)`,
      )
      .run(projectDir, now, now);
    // Pre-register so setProjectState / setProjectDependsOn have something to hit.
    globalDb
      .prepare(
        `INSERT INTO projects (name, root_path, state_cache, depends_on_json, registered_at, last_seen_at)
         VALUES ('app', ?, 'draft', '[]', ?, ?)`,
      )
      .run(projectDir, now, now);

    // Connect a project-scope server.
    const resolved: ResolvedScope = {
      scope: "project",
      vcfDir: join(projectDir, ".vcf"),
      projectDbPath: join(projectDir, ".vcf", "project.db"),
    };
    const server = createServer({
      scope: "project",
      resolved,
      config: baseConfig(),
      globalDb,
      projectDb,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);

    // plan_save with depends_on frontmatter on the plan.
    const plan = [
      "---",
      "title: Do the thing",
      "depends_on: [other-project, another]",
      "---",
      "# Plan",
      "This is a substantive plan body that clears the 64-char minimum.",
    ].join("\n");
    const todo = "- [ ] do the thing properly";
    const manifest = "- src/file.ts: the thing we are building";
    const env = parseResult(
      await client.callTool({
        name: "plan_save",
        arguments: {
          name: "m1",
          plan,
          todo,
          manifest,
          advance_state: "building",
          expand: true,
        },
      }),
    );
    expect(env.ok).toBe(true);

    const registered = getProjectByRoot(globalDb, projectDir);
    expect(registered?.state_cache).toBe("building");
    expect(registered?.depends_on).toEqual(["other-project", "another"]);
  });
});
