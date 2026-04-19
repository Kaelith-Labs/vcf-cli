import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openProjectDb } from "../../src/db/project.js";

// M10 exercises the built `vcf` CLI end-to-end. We shell out to
// dist/cli.js so packaging regressions (missing file in "files",
// bad bin shebang, ESM resolution) would surface here too.

const CLI = join(process.cwd(), "dist", "cli.js");

function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("node", [CLI, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? -1,
  };
}

describe("M10 vcf CLI", () => {
  let workRoot: string;
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "vcf-m10-"));
    home = await mkdtemp(join(tmpdir(), "vcf-m10h-"));
    projectDir = join(workRoot, "demo");
    await mkdir(join(projectDir, ".vcf"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  function writeConfig(extra = ""): string {
    const kbRoot = join(home, ".vcf", "kb");
    const body = [
      "version: 1",
      "workspace:",
      `  allowed_roots:`,
      `    - ${workRoot}`,
      `  ideas_dir: ${workRoot}/ideas`,
      `  specs_dir: ${workRoot}/specs`,
      "endpoints:",
      "  - name: local-stub",
      "    provider: local-stub",
      "    base_url: http://127.0.0.1:1",
      "    trust_level: local",
      "kb:",
      `  root: ${kbRoot}`,
      extra,
      "",
    ].join("\n");
    const path = join(home, ".vcf", "config.yaml");
    // ensure dir exists synchronously
    spawnSync("mkdir", ["-p", join(home, ".vcf")]);
    // use node's sync writer

    require("node:fs").writeFileSync(path, body);
    return path;
  }

  it("vcf version prints the pinned version", () => {
    const res = runCli(["version"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/vcf \d+\.\d+\.\d+/);
  });

  it("vcf reindex writes artifact rows for plans/decisions markdown", async () => {
    // Seed a fake project.db + files.
    const db = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const now = Date.now();
    db.prepare(
      `INSERT INTO project (id, name, root_path, state, created_at, updated_at)
       VALUES (1, 'Demo', ?, 'building', ?, ?)`,
    ).run(projectDir, now, now);
    db.close();

    await mkdir(join(projectDir, "plans", "decisions"), { recursive: true });
    await writeFile(join(projectDir, "plans", "demo-plan.md"), "# Plan\n\nbody");
    await writeFile(
      join(projectDir, "plans", "decisions", "2026-04-19-example.md"),
      "# Decision\n",
    );

    const res = runCli(["reindex"], { cwd: projectDir });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/reindex complete: 2/);

    const verify = openProjectDb({ path: join(projectDir, ".vcf", "project.db") });
    const kinds = (
      verify.prepare("SELECT kind FROM artifacts ORDER BY path").all() as { kind: string }[]
    ).map((r) => r.kind);
    expect(kinds.sort()).toEqual(["decision", "plan"]);
    verify.close();
  });

  it("vcf reindex fails E_STATE_INVALID without a project.db", () => {
    const empty = join(workRoot, "empty");
    spawnSync("mkdir", ["-p", empty]);
    const res = runCli(["reindex"], { cwd: empty });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/no project\.db/);
  });

  it("vcf verify reports config load success and endpoint env var status", async () => {
    const cfg = writeConfig();
    const res = runCli(["verify"], { env: { VCF_CONFIG: cfg } });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/config\.yaml loaded and validated/);
    expect(res.stderr).toMatch(/verify ok/);
  });

  it("vcf register-endpoint appends a new block and re-validates", async () => {
    const cfg = writeConfig();
    const res = runCli(
      [
        "register-endpoint",
        "--name",
        "openai-main",
        "--provider",
        "openai-compatible",
        "--base-url",
        "https://api.openai.com/v1",
        "--trust-level",
        "public",
        "--auth-env-var",
        "OPENAI_API_KEY",
      ],
      { env: { VCF_CONFIG: cfg } },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/appended endpoint 'openai-main'/);
    expect(res.stderr).toMatch(/config re-validated/);
    const updated = await readFile(cfg, "utf8");
    expect(updated).toMatch(/name: openai-main/);
    expect(updated).toMatch(/auth_env_var: OPENAI_API_KEY/);
  });

  it("vcf admin audit returns an empty table from a fresh global DB", () => {
    const cfg = writeConfig();
    const res = runCli(["admin", "audit", "--format", "json"], {
      env: { VCF_CONFIG: cfg, HOME: home },
    });
    expect(res.status).toBe(0);
    // Empty audit DB prints []\n
    expect(res.stderr.trim()).toBe("[]");
  });
});
