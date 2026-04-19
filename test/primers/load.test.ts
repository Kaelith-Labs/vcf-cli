import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKb, loadKbCached, clearKbCache } from "../../src/primers/load.js";

describe("loadKb", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-kb-")));
    await mkdir(join(root, "primers"), { recursive: true });
    await mkdir(join(root, "best-practices"), { recursive: true });
    await mkdir(join(root, "unknown"), { recursive: true });

    await writeFile(
      join(root, "primers", "a.md"),
      [
        "---",
        "type: primer",
        "primer_name: a",
        "category: tools",
        "version: 1",
        "updated: 2026-04-18",
        'tags: ["typescript", "cli"]',
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    await writeFile(
      join(root, "best-practices", "b.md"),
      [
        "---",
        "type: best-practices",
        "best_practice_name: b",
        "category: ai",
        "version: 1",
        "updated: 2026-04-18",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    await writeFile(join(root, "unknown", "x.md"), "no frontmatter here");
    await writeFile(join(root, "primers", "no-fm.md"), "not frontmatter");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    clearKbCache();
  });

  it("loads entries from known kind dirs only", async () => {
    const entries = await loadKb(root);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["best-practices/b", "primers/a"]);
  });

  it("parses inline list tags", async () => {
    const entries = await loadKb(root);
    const a = entries.find((e) => e.id === "primers/a");
    expect(a?.tags).toEqual(["typescript", "cli"]);
  });

  it("cached loader returns the same array on repeat calls", async () => {
    clearKbCache();
    const first = await loadKbCached(root);
    const second = await loadKbCached(root);
    expect(second).toBe(first);
  });

  it("cached loader returns empty array for a missing KB root (non-fatal)", async () => {
    clearKbCache();
    const entries = await loadKbCached("/nonexistent/kb/root/xyz");
    expect(entries).toEqual([]);
  });
});
