import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGlobalDb } from "../../src/db/global.js";
import { writeAudit, hashPayload, redact } from "../../src/util/audit.js";

describe("redact", () => {
  it("redacts AWS access keys", () => {
    const out = redact({ key: "AKIAIOSFODNN7EXAMPLE" });
    expect((out as { key: string }).key).toBe("[AWS_ACCESS_KEY]");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJKLMNOPqrstuv";
    expect(redact(jwt)).toBe("[JWT]");
  });

  it("redacts PEM private keys", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEv...stuff...==\n-----END PRIVATE KEY-----";
    expect(redact(pem)).toBe("[PRIVATE_KEY]");
  });

  it("redacts .env-style assignments", () => {
    const result = redact({ note: 'API_KEY="abcdef12345"' }) as { note: string };
    expect(result.note).toContain("API_KEY=[REDACTED]");
  });

  it("walks arrays and objects recursively", () => {
    const out = redact({
      nested: [
        { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJKLMNOPqrstuv" },
      ],
    }) as { nested: Array<{ token: string }> };
    expect(out.nested[0].token).toBe("[JWT]");
  });
});

describe("hashPayload", () => {
  it("hashes null to a deterministic sha256", () => {
    const h = hashPayload(null);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(hashPayload(null));
  });

  it("is stable across key ordering", () => {
    const a = hashPayload({ a: 1, b: 2 });
    const b = hashPayload({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("redacts before hashing — two JWT inputs hash equal", () => {
    const h1 = hashPayload({
      t: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJKLMNOPqrstuv",
    });
    const h2 = hashPayload({
      t: "eyJhbGciOiJIUzI1NiJ9.eyJkaWZmZXJlbnQifQ.xyz1234567890qrstuvwxyzABCDEFG",
    });
    expect(h1).toBe(h2);
  });
});

describe("writeAudit", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "vcf-audit-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("appends a row with hashed payloads", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    writeAudit(db, {
      tool: "idea_capture",
      scope: "global",
      inputs: { content: "hello" },
      outputs: { ok: true, paths: ["/abs/ideas/x.md"] },
      result_code: "ok",
    });
    const row = db
      .prepare("SELECT tool, inputs_hash, outputs_hash, result_code FROM audit")
      .get() as {
      tool: string;
      inputs_hash: string;
      outputs_hash: string;
      result_code: string;
    };
    expect(row.tool).toBe("idea_capture");
    expect(row.inputs_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.outputs_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.result_code).toBe("ok");
    db.close();
  });

  it("two identical payloads produce identical hashes", () => {
    const db = openGlobalDb({ path: join(dir, "vcf.db") });
    const entry = {
      tool: "idea_capture",
      scope: "global" as const,
      inputs: { content: "identical" },
      outputs: { ok: true },
      result_code: "ok",
    };
    writeAudit(db, entry);
    writeAudit(db, entry);
    const rows = db.prepare("SELECT inputs_hash FROM audit ORDER BY id").all() as {
      inputs_hash: string;
    }[];
    expect(rows[0].inputs_hash).toBe(rows[1].inputs_hash);
    db.close();
  });
});
