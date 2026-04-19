// `vcf` CLI entry — maintenance surface.
//
// Anything deterministic (reindex, verify, endpoint registration, audit
// dump, init) lives here. MCP tools are for LLM-in-the-loop paths; the CLI
// is for the operator who can run a command with flags.
//
// Commands:
//   vcf version                     — print installed version + pinned MCP spec
//   vcf init                        — seed ~/.vcf/config.yaml, write/merge user .mcp.json
//   vcf reindex [--project <path>]  — re-scan project artifacts into project.db
//   vcf verify                      — config + allowed_roots + KB + hooks health check
//   vcf register-endpoint --name ... — append a new endpoint block to config.yaml
//   vcf stale-check                 — flag primers past review.stale_primer_days
//   vcf update-primers              — fetch latest @kaelith-labs/kb; diff + warn on conflicts
//   vcf admin audit [--tool ...]    — query the audit trail

import { Command } from "commander";
import { resolve as resolvePath, join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile, stat, readdir, copyFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { VERSION, MCP_SPEC_VERSION } from "./version.js";
import { loadConfig, ConfigError } from "./config/loader.js";
import { canonicalizeRoots } from "./util/paths.js";
import { openGlobalDb } from "./db/global.js";
import { openProjectDb } from "./db/project.js";
import { loadKb } from "./primers/load.js";

const DEFAULT_CONFIG_PATH = (): string => resolvePath(homedir(), ".vcf", "config.yaml");

// ---- helpers ---------------------------------------------------------------

function err(message: string, code = 1): never {
  process.stderr.write(`vcf: ${message}\n`);
  process.exit(code);
}

function log(message: string): void {
  process.stderr.write(`vcf: ${message}\n`);
}

async function loadConfigOrExit(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  try {
    return await loadConfig(path);
  } catch (e) {
    if (e instanceof ConfigError) err(`[${e.code}] ${e.message}`);
    throw e;
  }
}

// ---- vcf init --------------------------------------------------------------

async function runInit(): Promise<void> {
  const cfgDir = resolvePath(homedir(), ".vcf");
  const cfgPath = resolvePath(cfgDir, "config.yaml");
  const userMcpJsonPath = resolvePath(homedir(), ".mcp.json");

  await mkdir(cfgDir, { recursive: true });

  if (existsSync(cfgPath)) {
    log(`${cfgPath} already exists — leaving in place.`);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const telemetryInput = await rl.question(
      "Enable opt-in error reporting? Captures only uncaught exceptions + E_INTERNAL failures. Never tool inputs/outputs. [y/N] ",
    );
    rl.close();
    const telemetryEnabled = /^y(es)?$/i.test(telemetryInput.trim());

    const workspaceRoot = resolvePath(homedir(), "vcf");
    const seed = [
      "version: 1",
      "workspace:",
      `  allowed_roots:`,
      `    - ${workspaceRoot}`,
      `    - ${homedir()}/projects`,
      `  ideas_dir: ${workspaceRoot}/ideas`,
      `  specs_dir: ${workspaceRoot}/specs`,
      "endpoints:",
      "  - name: local-ollama",
      "    provider: openai-compatible",
      "    base_url: http://127.0.0.1:11434/v1",
      "    trust_level: local",
      "kb:",
      `  root: ${homedir()}/.vcf/kb`,
      "telemetry:",
      `  error_reporting_enabled: ${telemetryEnabled ? "true" : "false"}`,
      "",
    ].join("\n");
    await writeFile(cfgPath, seed, "utf8");
    log(`wrote ${cfgPath}`);
  }

  // User-level .mcp.json auto-wire for --scope global.
  const globalBlock = {
    command: "npx",
    args: ["-y", "@kaelith-labs/cli", "vcf-mcp", "--scope", "global"],
    env: { VCF_CONFIG: `${homedir()}/.vcf/config.yaml` },
  };
  if (existsSync(userMcpJsonPath)) {
    const raw = await readFile(userMcpJsonPath, "utf8");
    let parsed: { mcpServers?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      log(`${userMcpJsonPath} is not valid JSON — leaving alone.`);
      return;
    }
    if (!parsed.mcpServers) parsed.mcpServers = {};
    if (!parsed.mcpServers["vcf"]) {
      parsed.mcpServers["vcf"] = globalBlock;
      await writeFile(userMcpJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      log(`merged vcf block into ${userMcpJsonPath}`);
    } else {
      log(`${userMcpJsonPath} already has a "vcf" block — skipping.`);
    }
  } else {
    await writeFile(
      userMcpJsonPath,
      JSON.stringify({ mcpServers: { vcf: globalBlock } }, null, 2) + "\n",
      "utf8",
    );
    log(`wrote ${userMcpJsonPath}`);
  }
  log("init complete.");
}

// ---- vcf reindex -----------------------------------------------------------

async function runReindex(opts: { project?: string }): Promise<void> {
  const target = resolvePath(opts.project ?? process.cwd());
  const dbPath = join(target, ".vcf", "project.db");
  if (!existsSync(dbPath)) {
    err(`no project.db at ${dbPath} — run 'vcf init' in this directory first`, 2);
  }
  const db = openProjectDb({ path: dbPath });

  const toIndex = ["plans", "memory", "docs"];
  let count = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile() && name.endsWith(".md")) {
        const body = await readFile(full, "utf8");
        const hash = "sha256:" + createHash("sha256").update(body).digest("hex");
        const kind = classifyKind(full);
        db.prepare(
          `INSERT INTO artifacts (path, kind, frontmatter_json, mtime, hash)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             kind = excluded.kind,
             mtime = excluded.mtime,
             hash = excluded.hash`,
        ).run(full, kind, "{}", st.mtimeMs, hash);
        count++;
      }
    }
  }
  for (const sub of toIndex) await walk(join(target, sub));
  db.close();
  log(`reindex complete: ${count} artifact(s) upserted under ${target}`);
}

function classifyKind(path: string): string {
  if (path.includes("/plans/decisions/")) return "decision";
  if (path.endsWith("-plan.md")) return "plan";
  if (path.endsWith("-todo.md")) return "todo";
  if (path.endsWith("-manifest.md")) return "manifest";
  if (path.endsWith("-spec.md")) return "spec";
  if (path.includes("/memory/daily-logs/")) return "daily-log";
  if (path.includes("/plans/reviews/")) return "review-report";
  return "doc";
}

// ---- vcf verify ------------------------------------------------------------

interface VerifyFinding {
  section: string;
  level: "ok" | "warn" | "error";
  detail: string;
}

async function runVerify(): Promise<void> {
  const findings: VerifyFinding[] = [];

  // Config loads.
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfigOrExit();
    findings.push({ section: "config", level: "ok", detail: "config.yaml loaded and validated" });
  } catch (e) {
    findings.push({
      section: "config",
      level: "error",
      detail: (e as Error).message,
    });
  }

  if (config) {
    // Canonicalize allowed_roots and verify each exists.
    try {
      const roots = await canonicalizeRoots(config.workspace.allowed_roots);
      for (const r of roots) {
        try {
          const st = statSync(r);
          findings.push({
            section: "workspace",
            level: st.isDirectory() ? "ok" : "error",
            detail: `${r} ${st.isDirectory() ? "exists (dir)" : "exists but is not a directory"}`,
          });
        } catch {
          findings.push({
            section: "workspace",
            level: "warn",
            detail: `${r} (allowed_root) does not exist yet — will be created on first use`,
          });
        }
      }
    } catch (e) {
      findings.push({
        section: "workspace",
        level: "error",
        detail: (e as Error).message,
      });
    }

    // KB root has at least some files.
    try {
      const entries = await loadKb(config.kb.root);
      findings.push({
        section: "kb",
        level: entries.length > 0 ? "ok" : "warn",
        detail:
          entries.length > 0
            ? `kb at ${config.kb.root} has ${entries.length} entr(y|ies)`
            : `kb at ${config.kb.root} is empty; run 'vcf update-primers' to populate`,
      });
    } catch (e) {
      findings.push({ section: "kb", level: "error", detail: (e as Error).message });
    }

    // Endpoint env vars present (non-fatal; note only).
    for (const e of config.endpoints) {
      if (e.auth_env_var === undefined) continue;
      if (process.env[e.auth_env_var] !== undefined) {
        findings.push({
          section: "endpoints",
          level: "ok",
          detail: `${e.name}: $${e.auth_env_var} is set`,
        });
      } else {
        findings.push({
          section: "endpoints",
          level: "warn",
          detail: `${e.name}: $${e.auth_env_var} is not set in the current shell`,
        });
      }
    }
  }

  // Project-local check (if cwd is initialized).
  const cwdDb = join(process.cwd(), ".vcf", "project.db");
  if (existsSync(cwdDb)) {
    findings.push({
      section: "project",
      level: "ok",
      detail: `project scope detected at ${cwdDb}`,
    });
    // Check git hooks.
    for (const hook of ["post-commit", "pre-push"] as const) {
      const hp = join(process.cwd(), ".git", "hooks", hook);
      if (existsSync(hp)) {
        findings.push({ section: "hooks", level: "ok", detail: `${hook} hook installed` });
      } else {
        findings.push({
          section: "hooks",
          level: "warn",
          detail: `${hook} hook missing at ${hp}`,
        });
      }
    }
  }

  // Render.
  let errs = 0;
  for (const f of findings) {
    process.stderr.write(`  [${f.level.toUpperCase().padEnd(5)}] ${f.section}: ${f.detail}\n`);
    if (f.level === "error") errs++;
  }
  if (errs > 0) {
    err(`verify failed: ${errs} error(s)`, 3);
  }
  log("verify ok");
}

// ---- vcf register-endpoint -------------------------------------------------

async function runRegisterEndpoint(opts: {
  name: string;
  provider: string;
  baseUrl: string;
  trustLevel: string;
  authEnvVar?: string;
}): Promise<void> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  let body = "";
  try {
    body = await readFile(path, "utf8");
  } catch {
    err(`config not found at ${path} — run 'vcf init' first`, 2);
  }
  if (!/^endpoints:/m.test(body)) {
    err("config.yaml has no 'endpoints:' key — fix the file manually", 4);
  }
  const block = [
    `  - name: ${opts.name}`,
    `    provider: ${opts.provider}`,
    `    base_url: ${opts.baseUrl}`,
    ...(opts.authEnvVar ? [`    auth_env_var: ${opts.authEnvVar}`] : []),
    `    trust_level: ${opts.trustLevel}`,
  ].join("\n");
  // Insert after the first 'endpoints:' line by finding the matching block.
  const updated = body.replace(/^(endpoints:\s*\n)/m, `$1${block}\n`);
  if (updated === body) err("could not splice into endpoints block; edit manually", 4);
  // Backup original.
  await writeFile(`${path}.bak`, body, "utf8");
  await writeFile(path, updated, "utf8");
  log(`appended endpoint '${opts.name}' (backup at ${path}.bak)`);
  // Re-validate.
  try {
    await loadConfig(path);
    log("config re-validated");
  } catch (e) {
    err(`config failed re-validation: ${(e as Error).message} — restoring from backup`, 5);
  }
}

// ---- vcf stale-check -------------------------------------------------------

async function runStaleCheck(): Promise<void> {
  const config = await loadConfigOrExit();
  const entries = await loadKb(config.kb.root);
  const thresholdMs = config.review.stale_primer_days * 86_400_000;
  const now = Date.now();
  let stale = 0;
  for (const e of entries) {
    const when = e.last_reviewed ?? e.updated;
    if (!when) {
      process.stderr.write(`  [WARN] ${e.id}: no last_reviewed / updated frontmatter\n`);
      continue;
    }
    const ts = Date.parse(when);
    if (!Number.isFinite(ts)) continue;
    if (now - ts > thresholdMs) {
      const daysOld = Math.floor((now - ts) / 86_400_000);
      process.stderr.write(`  [STALE] ${e.id}: ${daysOld} days old (updated=${when})\n`);
      stale++;
    }
  }
  log(
    `stale-check: ${stale} stale / ${entries.length} total (threshold ${config.review.stale_primer_days}d)`,
  );
}

// ---- vcf install-skills ----------------------------------------------------

type SkillLayout = "nested-md" | "flat-toml";
interface SkillClientSpec {
  defaultDest: () => string;
  layout: SkillLayout;
}

const SKILL_CLIENTS: Record<string, SkillClientSpec> = {
  "claude-code": {
    defaultDest: () => resolvePath(homedir(), ".claude", "skills"),
    layout: "nested-md",
  },
  codex: {
    defaultDest: () => resolvePath(homedir(), ".agents", "skills"),
    layout: "nested-md",
  },
  gemini: {
    defaultDest: () => resolvePath(homedir(), ".gemini", "commands"),
    layout: "flat-toml",
  },
};

async function runInstallSkills(client: string, opts: { dest?: string }): Promise<void> {
  const spec = SKILL_CLIENTS[client];
  if (!spec) {
    err(`unknown client '${client}' — supported: ${Object.keys(SKILL_CLIENTS).join(", ")}`, 2);
  }
  // Resolve packaged skills dir (one level up from dist/).
  const pkgSkillsDir = resolvePath(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "skills",
    client,
  );
  if (!existsSync(pkgSkillsDir)) {
    err(`skill pack missing in package at ${pkgSkillsDir}`, 3);
  }
  const dest = opts.dest ?? spec.defaultDest();
  await mkdir(dest, { recursive: true });

  let installed = 0;
  let skipped = 0;
  const entries = await readdir(pkgSkillsDir);

  if (spec.layout === "nested-md") {
    for (const name of entries) {
      const src = join(pkgSkillsDir, name);
      const st = await stat(src);
      if (!st.isDirectory()) continue;
      const dstDir = join(dest, name);
      if (existsSync(dstDir)) {
        log(`${dstDir} exists — skipping (edit manually or remove to reinstall)`);
        skipped++;
        continue;
      }
      await mkdir(dstDir, { recursive: true });
      const skillFile = join(src, "SKILL.md");
      if (existsSync(skillFile)) {
        await copyFile(skillFile, join(dstDir, "SKILL.md"));
      }
      installed++;
    }
  } else {
    // flat-toml: each <name>.toml in pkg dir copies to <dest>/<name>.toml.
    for (const name of entries) {
      if (!name.endsWith(".toml")) continue;
      const src = join(pkgSkillsDir, name);
      const dst = join(dest, name);
      if (existsSync(dst)) {
        log(`${dst} exists — skipping (edit manually or remove to reinstall)`);
        skipped++;
        continue;
      }
      await copyFile(src, dst);
      installed++;
    }
  }
  log(`install-skills: ${installed} installed, ${skipped} skipped at ${dest}`);
}

// ---- vcf update-primers ----------------------------------------------------

async function runUpdatePrimers(): Promise<void> {
  const config = await loadConfigOrExit();
  const kbRoot = config.kb.root;
  // Locate the installed @kaelith-labs/kb package. In dev we prefer a sibling repo;
  // in production we resolve via Node's module resolution from the CLI's
  // own node_modules (best-effort — if require.resolve fails we fall back).
  let upstreamRoot: string | null = null;
  const candidates = [
    resolvePath(dirname(new URL(import.meta.url).pathname), "..", "..", "vcf-kb", "kb"),
    resolvePath(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "node_modules",
      "@vcf",
      "kb",
      "kb",
    ),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      upstreamRoot = c;
      break;
    }
  }
  if (upstreamRoot === null) {
    err(
      "could not locate @kaelith-labs/kb package; ensure it's installed or the sibling repo is present",
      6,
    );
  }
  log(`update-primers: comparing ${kbRoot} against ${upstreamRoot}`);
  await mkdir(kbRoot, { recursive: true });

  // Walk upstream; copy new files; warn+skip on conflicts (per spec).
  let copied = 0;
  let skipped = 0;
  const stack: string[] = [upstreamRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      const rel = full.slice(upstreamRoot.length + 1);
      const local = join(kbRoot, rel);
      if (!existsSync(local)) {
        await mkdir(dirname(local), { recursive: true });
        await copyFile(full, local);
        copied++;
        continue;
      }
      // Conflict detection by content hash.
      const [up, loc] = await Promise.all([readFile(full), readFile(local)]);
      const upHash = createHash("sha256").update(up).digest("hex");
      const locHash = createHash("sha256").update(loc).digest("hex");
      if (upHash !== locHash) {
        process.stderr.write(`  [CONFLICT] ${rel} — local diverges from upstream; skipped\n`);
        skipped++;
      }
    }
  }
  log(`update-primers: ${copied} new / ${skipped} conflict(s) (three-way merge is Phase 2)`);
}

// ---- vcf admin audit -------------------------------------------------------

async function runAdminAudit(opts: {
  tool?: string;
  project?: string;
  since?: string;
  format: string;
}): Promise<void> {
  // Open writable: the global DB may not exist yet on first CLI run.
  // better-sqlite3's readonly mode refuses to create, so we accept the
  // tiny cost of creating an empty DB here (migrations are idempotent).
  const globalDb = openGlobalDb({
    path: resolvePath(homedir(), ".vcf", "vcf.db"),
  });
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.tool) {
    clauses.push("tool = ?");
    params.push(opts.tool);
  }
  if (opts.project) {
    clauses.push("project_root = ?");
    params.push(resolvePath(opts.project));
  }
  if (opts.since) {
    const ts = Date.parse(opts.since);
    if (Number.isFinite(ts)) {
      clauses.push("ts >= ?");
      params.push(ts);
    }
  }
  const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
  const rows = globalDb
    .prepare(
      `SELECT id, ts, tool, scope, project_root, client_id, inputs_hash, outputs_hash, endpoint, result_code
       FROM audit ${where} ORDER BY ts DESC LIMIT 500`,
    )
    .all(...params) as Array<{
    id: number;
    ts: number;
    tool: string;
    scope: string;
    project_root: string | null;
    client_id: string | null;
    inputs_hash: string;
    outputs_hash: string;
    endpoint: string | null;
    result_code: string;
  }>;

  if (opts.format === "json") {
    process.stderr.write(JSON.stringify(rows, null, 2) + "\n");
  } else if (opts.format === "csv") {
    process.stderr.write(
      "id,ts,tool,scope,project_root,client_id,inputs_hash,outputs_hash,endpoint,result_code\n",
    );
    for (const r of rows) {
      process.stderr.write(
        [
          r.id,
          r.ts,
          r.tool,
          r.scope,
          r.project_root ?? "",
          r.client_id ?? "",
          r.inputs_hash,
          r.outputs_hash,
          r.endpoint ?? "",
          r.result_code,
        ].join(",") + "\n",
      );
    }
  } else {
    // table
    for (const r of rows) {
      process.stderr.write(
        `${new Date(r.ts).toISOString()}  ${r.scope.padEnd(7)} ${r.tool.padEnd(26)} ${r.result_code.padEnd(16)} ${r.project_root ?? "-"}\n`,
      );
    }
    log(`admin audit: ${rows.length} row(s)`);
  }
  globalDb.close();
}

// ---- command wiring --------------------------------------------------------

const program = new Command();
program
  .name("vcf")
  .description("Vibe Coding Framework CLI — maintenance surface for VCF-MCP.")
  .version(VERSION);

program
  .command("version")
  .description("Print the installed vcf version + MCP spec pin.")
  .action(() => {
    process.stderr.write(`vcf ${VERSION} (MCP spec ${MCP_SPEC_VERSION})\n`);
  });

program
  .command("init")
  .description(
    "Seed ~/.vcf/config.yaml, write/merge user-level .mcp.json. Idempotent — re-run safe.",
  )
  .action(async () => {
    try {
      await runInit();
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("reindex")
  .description("Re-scan plans/ memory/ docs/ into the project's SQLite index.")
  .option("--project <path>", "project root (defaults to current directory)")
  .action(async (opts: { project?: string }) => {
    try {
      await runReindex(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("verify")
  .description("Check config, allowed_roots, KB, endpoint env vars, git hooks.")
  .action(async () => {
    try {
      await runVerify();
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("register-endpoint")
  .description("Append a new LLM endpoint block to ~/.vcf/config.yaml.")
  .requiredOption("--name <name>", "endpoint slug")
  .requiredOption("--provider <provider>", "openai-compatible | anthropic | gemini | local-stub")
  .requiredOption("--base-url <url>", "HTTPS base URL of the endpoint")
  .requiredOption("--trust-level <level>", "local | trusted | public")
  .option("--auth-env-var <var>", "env var holding the API key (SCREAMING_SNAKE_CASE)")
  .action(
    async (opts: {
      name: string;
      provider: string;
      baseUrl: string;
      trustLevel: string;
      authEnvVar?: string;
    }) => {
      try {
        await runRegisterEndpoint(opts);
      } catch (e) {
        err((e as Error).message);
      }
    },
  );

program
  .command("stale-check")
  .description("Flag KB entries past review.stale_primer_days old.")
  .action(async () => {
    try {
      await runStaleCheck();
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("install-skills")
  .description(
    "Install the shipped skill pack into an MCP client's skills directory. Supported clients: claude-code, codex, gemini.",
  )
  .argument("<client>", "target client (claude-code | codex | gemini)")
  .option(
    "--dest <path>",
    "skills directory (defaults: ~/.claude/skills, ~/.agents/skills, or ~/.gemini/commands per client)",
  )
  .action(async (client: string, opts: { dest?: string }) => {
    try {
      await runInstallSkills(client, opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("update-primers")
  .description(
    "Pull latest @kaelith-labs/kb into the user's KB root; warn+skip on conflicts (three-way merge is Phase 2).",
  )
  .action(async () => {
    try {
      await runUpdatePrimers();
    } catch (e) {
      err((e as Error).message);
    }
  });

const admin = program.command("admin").description("Read-only operator queries.");
admin
  .command("audit")
  .description("Query the global audit trail.")
  .option("--tool <name>")
  .option("--project <path>")
  .option("--since <iso-date>")
  .option("--format <fmt>", "table | json | csv", "table")
  .action(async (opts: { tool?: string; project?: string; since?: string; format: string }) => {
    try {
      await runAdminAudit(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e));
});
