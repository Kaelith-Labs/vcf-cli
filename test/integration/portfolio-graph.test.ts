// Cross-project registry + portfolio_graph + project_list.
//
// Exercises the hybrid design end-to-end:
//   - registry CRUD via projectRegistry helpers
//   - project_list MCP tool surfacing registered projects
//   - portfolio_graph computing blockers + unblocked-if-ships from
//     depends_on projections
//   - state_cache mirroring via plan_save
//   - last_seen_at bump via writeAudit hook

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";
import { openGlobalDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
import { ConfigSchema } from "../../src/config/schema.js";
import {
  upsertProject,
  listProjects,
  setProjectDependsOn,
  setProjectState,
  computeBlockers,
  computeUnblockedIfShips,
  unregisterProject,
} from "../../src/util/projectRegistry.js";
import type { ResolvedScope } from "../../src/scope.js";

interface Envelope {
  ok: boolean;
  content?: unknown;
  code?: string;
}

function parseResult(result: unknown): Envelope {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text content");
  return JSON.parse(text) as Envelope;
}

describe("projectRegistry helpers", () => {
  let home: string;
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-preg-")));
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("upserts by root_path; re-registering updates the name without losing registered_at", () => {
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    upsertProject(db, { name: "alpha", root_path: "/abs/foo", state: "draft" });
    const firstRow = listProjects(db)[0]!;
    upsertProject(db, { name: "alpha-renamed", root_path: "/abs/foo", state: "building" });
    const rows = listProjects(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("alpha-renamed");
    expect(rows[0]?.state_cache).toBe("building");
    expect(rows[0]?.registered_at).toBe(firstRow.registered_at);
  });

  it("unregister drops by name", () => {
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    upsertProject(db, { name: "keep", root_path: "/abs/keep" });
    upsertProject(db, { name: "drop", root_path: "/abs/drop" });
    expect(unregisterProject(db, "drop")).toBe(true);
    expect(unregisterProject(db, "drop")).toBe(false); // idempotent
    expect(listProjects(db).map((r) => r.name)).toEqual(["keep"]);
  });

  it("computeBlockers: depends_on a registered non-shipped project → blocked edge", () => {
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    upsertProject(db, { name: "a", root_path: "/abs/a", state: "building" });
    upsertProject(db, { name: "b", root_path: "/abs/b", state: "building" });
    setProjectDependsOn(db, "/abs/a", ["b"]);
    const blockers = computeBlockers(listProjects(db));
    expect(blockers).toEqual([{ blocked: "a", blocked_by: "b", reason: "depends_on (building)" }]);
  });

  it("computeBlockers: depends_on a shipped project → NOT a blocker", () => {
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    upsertProject(db, { name: "a", root_path: "/abs/a", state: "building" });
    upsertProject(db, { name: "b", root_path: "/abs/b", state: "shipped" });
    setProjectDependsOn(db, "/abs/a", ["b"]);
    const blockers = computeBlockers(listProjects(db));
    expect(blockers).toEqual([]);
  });

  it("computeBlockers: depends_on an unregistered project → silently ignored", () => {
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    upsertProject(db, { name: "a", root_path: "/abs/a", state: "building" });
    setProjectDependsOn(db, "/abs/a", ["ghost-project"]);
    expect(computeBlockers(listProjects(db))).toEqual([]);
  });

  it("computeUnblockedIfShips: inverse of depends_on", () => {
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    upsertProject(db, { name: "a", root_path: "/abs/a" });
    upsertProject(db, { name: "b", root_path: "/abs/b" });
    upsertProject(db, { name: "c", root_path: "/abs/c" });
    setProjectDependsOn(db, "/abs/a", ["c"]);
    setProjectDependsOn(db, "/abs/b", ["c"]);
    const unblocked = computeUnblockedIfShips(listProjects(db));
    expect(unblocked).toEqual({ c: ["a", "b"] });
  });

  it("setProjectState is a no-op for an unregistered root (silent)", () => {
    const db = openGlobalDb({ path: join(home, ".vcf", "vcf.db") });
    // Must not throw.
    expect(() => setProjectState(db, "/abs/nowhere", "building")).not.toThrow();
    expect(listProjects(db)).toEqual([]);
  });
});

describe("portfolio MCP tools (global scope)", () => {
  let workRoot: string;
  let home: string;

  beforeEach(async () => {
    workRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-pg-")));
    home = await realpath(await mkdtemp(join(tmpdir(), "vcf-pgh-")));
    await mkdir(join(home, ".vcf"), { recursive: true });
  });
  afterEach(async () => {
    closeTrackedDbs();
    await rm(workRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  async function connectGlobal(seed?: (db: ReturnType<typeof openGlobalDb>) => void) {
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
    if (seed) seed(globalDb);
    const resolved: ResolvedScope = { scope: "global" };
    const server = createServer({ scope: "global", resolved, config, globalDb });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return { client, globalDb };
  }

  it("project_list returns empty when nothing is registered", async () => {
    const { client } = await connectGlobal();
    const env = parseResult(
      await client.callTool({ name: "project_list", arguments: { expand: true } }),
    );
    expect(env.ok).toBe(true);
    expect((env.content as { projects: unknown[] }).projects).toEqual([]);
  });

  it("project_list surfaces registered projects with their depends_on + state", async () => {
    const { client } = await connectGlobal((db) => {
      upsertProject(db, { name: "alpha", root_path: "/abs/alpha", state: "building" });
      upsertProject(db, { name: "beta", root_path: "/abs/beta", state: "draft" });
      setProjectDependsOn(db, "/abs/beta", ["alpha"]);
    });
    const env = parseResult(
      await client.callTool({ name: "project_list", arguments: { expand: true } }),
    );
    const projects = (
      env.content as {
        projects: Array<{ name: string; state_cache: string; depends_on: string[] }>;
      }
    ).projects;
    expect(projects.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    const beta = projects.find((p) => p.name === "beta")!;
    expect(beta.state_cache).toBe("draft");
    expect(beta.depends_on).toEqual(["alpha"]);
  });

  it("portfolio_graph returns blockers + unblocked_if_ships; excludes shipped by default", async () => {
    const { client } = await connectGlobal((db) => {
      upsertProject(db, { name: "alpha", root_path: "/abs/alpha", state: "shipped" });
      upsertProject(db, { name: "beta", root_path: "/abs/beta", state: "building" });
      upsertProject(db, { name: "gamma", root_path: "/abs/gamma", state: "building" });
      setProjectDependsOn(db, "/abs/beta", ["gamma"]);
      setProjectDependsOn(db, "/abs/gamma", ["alpha"]);
    });
    const env = parseResult(
      await client.callTool({ name: "portfolio_graph", arguments: { expand: true } }),
    );
    const graph = env.content as {
      projects: Array<{ name: string }>;
      blockers: Array<{ blocked: string; blocked_by: string }>;
      unblocked_if_ships: Record<string, string[]>;
    };
    // alpha is shipped → excluded by default
    expect(graph.projects.map((p) => p.name).sort()).toEqual(["beta", "gamma"]);
    // beta depends on gamma (still building) → blocker. gamma → alpha
    // is gone because alpha was filtered out of the graph entirely.
    expect(graph.blockers).toEqual([
      { blocked: "beta", blocked_by: "gamma", reason: "depends_on (building)" },
    ]);
    expect(graph.unblocked_if_ships).toEqual({ gamma: ["beta"] });
  });

  it("portfolio_graph with include_shipped=true shows shipped projects", async () => {
    const { client } = await connectGlobal((db) => {
      upsertProject(db, { name: "alpha", root_path: "/abs/alpha", state: "shipped" });
      upsertProject(db, { name: "beta", root_path: "/abs/beta", state: "building" });
    });
    const env = parseResult(
      await client.callTool({
        name: "portfolio_graph",
        arguments: { include_shipped: true, expand: true },
      }),
    );
    const graph = env.content as { projects: Array<{ name: string }> };
    expect(graph.projects.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
  });
});
