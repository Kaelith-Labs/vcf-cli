import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cosine,
  normalizeTagScore,
  blend,
  loadEmbeddingCache,
  writeEmbeddingRecord,
  buildEmbeddingInput,
  sha256,
} from "../../src/primers/embed.js";

describe("embed helpers", () => {
  describe("cosine", () => {
    it("returns 1 for identical non-zero vectors", () => {
      expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    });
    it("returns 0 for orthogonal vectors", () => {
      expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    });
    it("returns 0 for empty vectors", () => {
      expect(cosine([], [])).toBe(0);
    });
    it("returns 0 for length mismatch", () => {
      expect(cosine([1, 2], [1, 2, 3])).toBe(0);
    });
    it("is scale-invariant", () => {
      const a = cosine([1, 2, 3], [2, 4, 6]);
      expect(a).toBeCloseTo(1, 6);
    });
  });

  describe("normalizeTagScore", () => {
    it("maps to [0,1]", () => {
      expect(normalizeTagScore(0, 10)).toBe(0);
      expect(normalizeTagScore(5, 10)).toBe(0.5);
      expect(normalizeTagScore(10, 10)).toBe(1);
    });
    it("returns 0 when nothing to normalize against", () => {
      expect(normalizeTagScore(5, 0)).toBe(0);
    });
  });

  describe("blend", () => {
    it("clamps weight into [0,1]", () => {
      expect(blend(0.4, 0.8, -1)).toBe(0.4); // weight → 0, pure tag
      expect(blend(0.4, 0.8, 2)).toBe(0.8); // weight → 1, pure cosine
    });
    it("midpoint weight averages", () => {
      expect(blend(0.2, 0.8, 0.5)).toBeCloseTo(0.5, 6);
    });
  });
});

describe("embedding cache round-trip", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await realpath(await mkdtemp(join(tmpdir(), "vcf-embed-")));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("empty cache returns empty map", async () => {
    const cache = await loadEmbeddingCache(cacheDir, "text-embedding-3-small");
    expect(cache.byId.size).toBe(0);
  });

  it("writes and reads back a record; drops records with mismatched model", async () => {
    await writeEmbeddingRecord(cacheDir, "primers/foo", {
      model: "text-embedding-3-small",
      dim: 3,
      content_sha256: "abc",
      vector: [0.1, 0.2, 0.3],
      updated_at: Date.now(),
    });
    await writeEmbeddingRecord(cacheDir, "primers/bar", {
      model: "mismatched-model",
      dim: 3,
      content_sha256: "def",
      vector: [0.4, 0.5, 0.6],
      updated_at: Date.now(),
    });
    const cache = await loadEmbeddingCache(cacheDir, "text-embedding-3-small");
    expect(cache.byId.size).toBe(1);
    expect(cache.byId.get("primers/foo")).toEqual([0.1, 0.2, 0.3]);
    expect(cache.model).toBe("text-embedding-3-small");
    expect(cache.dim).toBe(3);
  });

  it("walks nested id paths (kinds with subdirectories) and preserves the full id", async () => {
    await writeEmbeddingRecord(cacheDir, "review-system/code/01-x", {
      model: "nomic-embed-text",
      dim: 1,
      content_sha256: "h",
      vector: [0.99],
      updated_at: Date.now(),
    });
    const cache = await loadEmbeddingCache(cacheDir, "nomic-embed-text");
    expect(cache.byId.has("review-system/code/01-x")).toBe(true);
  });
});

describe("buildEmbeddingInput", () => {
  it("joins name + tags + body head", () => {
    const input = buildEmbeddingInput(
      { name: "MCP", tags: ["mcp", "api"], applies_to: ["server"] },
      "body line 1\nbody line 2\n".repeat(500),
    );
    expect(input.startsWith("MCP mcp api server")).toBe(true);
    expect(input.length).toBeLessThanOrEqual(2100);
  });
});

describe("sha256", () => {
  it("is deterministic", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
  });
  it("differs for different input", () => {
    expect(sha256("abc")).not.toBe(sha256("abd"));
  });
});
