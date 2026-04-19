import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePrimerTree } from "../src/cli.js";

// The `mergePrimerTree` helper underpins `vcf update-primers`. Each test
// builds an upstream tree, a local KB, and (when relevant) an ancestor
// snapshot, then asserts the merge outcomes plus the on-disk final state.

async function writeAt(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

describe("update-primers three-way merge", () => {
  let root: string;
  let upstream: string;
  let kb: string;
  let ancestor: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-merge-")));
    upstream = join(root, "upstream");
    kb = join(root, "kb");
    ancestor = join(root, "ancestor");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("adds upstream files that have no local counterpart", async () => {
    await writeAt(upstream, "primers/new.md", "# new primer\n");

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts.added).toBe(1);
    expect(await readFile(join(kb, "primers/new.md"), "utf8")).toBe("# new primer\n");
    // Ancestor seeded for future merges.
    expect(await readFile(join(ancestor, "primers/new.md"), "utf8")).toBe("# new primer\n");
  });

  it("keeps local edits when upstream is unchanged (ancestor == upstream)", async () => {
    await writeAt(upstream, "primers/x.md", "v1\n");
    await writeAt(ancestor, "primers/x.md", "v1\n");
    await writeAt(kb, "primers/x.md", "v1\nlocal edit\n");

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts["local-only"]).toBe(1);
    expect(await readFile(join(kb, "primers/x.md"), "utf8")).toBe("v1\nlocal edit\n");
  });

  it("fast-forwards when local is unchanged (ancestor == local)", async () => {
    await writeAt(upstream, "primers/x.md", "v2\n");
    await writeAt(ancestor, "primers/x.md", "v1\n");
    await writeAt(kb, "primers/x.md", "v1\n");

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts["fast-forward"]).toBe(1);
    expect(await readFile(join(kb, "primers/x.md"), "utf8")).toBe("v2\n");
    expect(await readFile(join(ancestor, "primers/x.md"), "utf8")).toBe("v2\n");
  });

  it("reports in-sync when local == upstream and seeds the ancestor", async () => {
    await writeAt(upstream, "primers/x.md", "same\n");
    await writeAt(kb, "primers/x.md", "same\n");

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts["in-sync"]).toBe(1);
    expect(await readFile(join(ancestor, "primers/x.md"), "utf8")).toBe("same\n");
  });

  it("auto-merges cleanly when local and upstream touch different regions", async () => {
    // Classic three-way: one side edits the top, the other edits the bottom.
    const base = "line1\nline2\nline3\nline4\nline5\n";
    const local = "LINE1-local\nline2\nline3\nline4\nline5\n";
    const upstreamV2 = "line1\nline2\nline3\nline4\nLINE5-upstream\n";

    await writeAt(upstream, "primers/x.md", upstreamV2);
    await writeAt(ancestor, "primers/x.md", base);
    await writeAt(kb, "primers/x.md", local);

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts["auto-merged"]).toBe(1);
    const merged = await readFile(join(kb, "primers/x.md"), "utf8");
    expect(merged).toContain("LINE1-local");
    expect(merged).toContain("LINE5-upstream");
    // Ancestor re-seeded to the upstream version.
    expect(await readFile(join(ancestor, "primers/x.md"), "utf8")).toBe(upstreamV2);
  });

  it("emits conflict markers when both sides edit the same lines", async () => {
    const base = "line1\nline2\nline3\n";
    const local = "line1\nlocal-touched\nline3\n";
    const upstreamV2 = "line1\nupstream-touched\nline3\n";

    await writeAt(upstream, "primers/x.md", upstreamV2);
    await writeAt(ancestor, "primers/x.md", base);
    await writeAt(kb, "primers/x.md", local);

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts.conflict).toBe(1);
    const merged = await readFile(join(kb, "primers/x.md"), "utf8");
    expect(merged).toMatch(/<{7} local/);
    expect(merged).toMatch(/={7}/);
    expect(merged).toMatch(/>{7} upstream/);
    // Ancestor NOT updated — user resolves + re-runs.
    expect(await readFile(join(ancestor, "primers/x.md"), "utf8")).toBe(base);
  });

  it("treats a missing ancestor as conflict and writes a .upstream sibling", async () => {
    await writeAt(upstream, "primers/x.md", "upstream\n");
    await writeAt(kb, "primers/x.md", "local\n");
    // No ancestor file.

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts.conflict).toBe(1);
    // Local untouched.
    expect(await readFile(join(kb, "primers/x.md"), "utf8")).toBe("local\n");
    // Upstream written to sibling.
    expect(await readFile(join(kb, "primers/x.md.upstream"), "utf8")).toBe("upstream\n");
  });

  it("walks nested directories end-to-end", async () => {
    await writeAt(upstream, "primers/foo.md", "a\n");
    await writeAt(upstream, "best-practices/nested/bar.md", "b\n");
    await writeAt(upstream, "review-system/code/01-x.md", "c\n");

    const report = await mergePrimerTree({
      kbRoot: kb,
      upstreamRoot: upstream,
      ancestorRoot: ancestor,
    });

    expect(report.counts.added).toBe(3);
    expect(await readFile(join(kb, "primers/foo.md"), "utf8")).toBe("a\n");
    expect(await readFile(join(kb, "best-practices/nested/bar.md"), "utf8")).toBe("b\n");
    expect(await readFile(join(kb, "review-system/code/01-x.md"), "utf8")).toBe("c\n");
  });
});
