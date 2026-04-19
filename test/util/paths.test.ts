import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertInsideAllowedRoot, PathError, canonicalizeRoots } from "../../src/util/paths.js";

// Each test uses a freshly-created temp tree so the realpath checks operate
// on actual inodes. We cannot test symlink-escape without real symlinks.
describe("assertInsideAllowedRoot", () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "vcf-paths-")));
    allowed = join(root, "allowed");
    outside = join(root, "outside");
    await mkdir(allowed, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(allowed, "inside.txt"), "ok");
    await writeFile(join(outside, "secret.txt"), "nope");
    // Symlink from inside-allowed pointing to outside.
    await symlink(join(outside, "secret.txt"), join(allowed, "linked-out"));
    // A legitimate nested file.
    await mkdir(join(allowed, "nested"), { recursive: true });
    await writeFile(join(allowed, "nested", "deep.txt"), "deep");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("accepts a path inside the allowed root", async () => {
    const out = await assertInsideAllowedRoot(join(allowed, "inside.txt"), [allowed]);
    expect(out).toBe(resolve(allowed, "inside.txt"));
  });

  it("accepts a deeper nested path", async () => {
    const out = await assertInsideAllowedRoot(join(allowed, "nested", "deep.txt"), [allowed]);
    expect(out.endsWith("deep.txt")).toBe(true);
  });

  it("rejects a path outside the allowed root", async () => {
    await expect(
      assertInsideAllowedRoot(join(outside, "secret.txt"), [allowed]),
    ).rejects.toMatchObject({ code: "E_SCOPE_DENIED" });
  });

  it("rejects a symlink inside allowed that points outside", async () => {
    // The symlink itself lives inside allowed, but realpath resolves to
    // `outside/secret.txt`. This must be rejected — the EscapeRoute CVE
    // class.
    await expect(
      assertInsideAllowedRoot(join(allowed, "linked-out"), [allowed]),
    ).rejects.toMatchObject({ code: "E_SCOPE_DENIED" });
  });

  it("rejects relative paths", async () => {
    await expect(assertInsideAllowedRoot("relative/path", [allowed])).rejects.toMatchObject({
      code: "E_PATH_NOT_ABSOLUTE",
    });
  });

  it("rejects an empty string", async () => {
    await expect(assertInsideAllowedRoot("", [allowed])).rejects.toMatchObject({
      code: "E_PATH_INVALID",
    });
  });

  it("rejects URL-encoded traversal", async () => {
    await expect(
      assertInsideAllowedRoot(join(allowed, "%2e%2e", "outside.txt"), [allowed]),
    ).rejects.toMatchObject({ code: "E_PATH_ENCODED_ESCAPE" });
  });

  it("rejects '..' attempts that resolve outside the root", async () => {
    const escaping = resolve(allowed, "..", "outside", "secret.txt");
    await expect(assertInsideAllowedRoot(escaping, [allowed])).rejects.toMatchObject({
      code: "E_SCOPE_DENIED",
    });
  });

  it("does not match prefix-sibling roots (/allowed vs /allowed2)", async () => {
    // Create a sibling dir whose name is a prefix collision.
    const sibling = join(root, "allowed-sibling");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "x.txt"), "x");
    await expect(assertInsideAllowedRoot(join(sibling, "x.txt"), [allowed])).rejects.toMatchObject({
      code: "E_SCOPE_DENIED",
    });
  });

  it("rejects when allowed_roots is empty", async () => {
    await expect(assertInsideAllowedRoot(join(allowed, "inside.txt"), [])).rejects.toMatchObject({
      code: "E_SCOPE_EMPTY",
    });
  });

  it("accepts a path that doesn't exist yet but resolves inside root", async () => {
    // A `write_file` flow needs to validate before the file exists.
    const toCreate = join(allowed, "will-create-later.txt");
    const out = await assertInsideAllowedRoot(toCreate, [allowed]);
    expect(out.endsWith("will-create-later.txt")).toBe(true);
  });
});

describe("canonicalizeRoots", () => {
  it("resolves symlinks in roots", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vcf-roots-")));
    const real = join(root, "real");
    const link = join(root, "link");
    await mkdir(real, { recursive: true });
    await symlink(real, link, "dir");
    const [out] = await canonicalizeRoots([link]);
    expect(out).toBe(real);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("throws on non-absolute roots", async () => {
    await expect(canonicalizeRoots(["relative"])).rejects.toBeInstanceOf(PathError);
  });
});
