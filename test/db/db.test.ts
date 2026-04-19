import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGlobalDb, openProjectDb } from "../helpers/db-cleanup.js";

describe("global DB", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-dbg-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("creates expected tables on fresh init", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as { name: string }).name);
    expect(tables).toContain("ideas");
    expect(tables).toContain("specs");
    expect(tables).toContain("primers");
    expect(tables).toContain("endpoints");
    expect(tables).toContain("model_aliases");
    expect(tables).toContain("audit");
    expect(tables).toContain("schema_migrations");
    db.close();
  });

  it("is idempotent on second open", () => {
    const p = join(dir, "vcf.db");
    openGlobalDb({ path: p }).close();
    openGlobalDb({ path: p }).close(); // no throw
    const db = openGlobalDb({ path: p });
    const rows = db.prepare("SELECT version FROM schema_migrations").all();
    expect(rows.length).toBe(1); // only v1 applied, not N times
    db.close();
  });

  it("insert + read round-trips an idea row", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    db.prepare(
      `INSERT INTO ideas (path, slug, tags, created_at, frontmatter_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("/abs/ideas/2026-04-18-cool.md", "cool", JSON.stringify(["ai", "cli"]), Date.now(), "{}");
    const row = db.prepare("SELECT slug FROM ideas").get() as { slug: string };
    expect(row.slug).toBe("cool");
    db.close();
  });

  it("enforces audit.scope CHECK constraint", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    expect(() =>
      db
        .prepare(
          `INSERT INTO audit (ts, tool, scope, inputs_hash, outputs_hash, result_code)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(Date.now(), "idea_capture", "bogus", "sha256:a", "sha256:b", "ok"),
    ).toThrow();
    db.close();
  });
});

describe("project DB", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-dbp-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  });

  it("creates expected tables on fresh init", () => {
    const db = openProjectDb({ path: join(dir, "project.db") });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as { name: string }).name);
    for (const t of [
      "project",
      "artifacts",
      "review_runs",
      "decisions",
      "response_log",
      "builds",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("enforces the project singleton row constraint", () => {
    const db = openProjectDb({ path: join(dir, "project.db") });
    const now = Date.now();
    db.prepare(
      `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
       VALUES (1, 'demo', '/abs/demo', 'draft', ?, ?)`,
    ).run(now, now);
    // second row should violate CHECK(id = 1)
    expect(() =>
      db
        .prepare(
          `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
           VALUES (2, 'demo2', '/abs/demo2', 'draft', ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
    db.close();
  });

  it("enforces review_runs.verdict enum", () => {
    const db = openProjectDb({ path: join(dir, "project.db") });
    const now = Date.now();
    expect(() =>
      db
        .prepare(
          `INSERT INTO review_runs (id, type, stage, status, started_at, verdict)
           VALUES ('code-1', 'code', 1, 'submitted', ?, 'MAYBE')`,
        )
        .run(now),
    ).toThrow();
    db.close();
  });
});
