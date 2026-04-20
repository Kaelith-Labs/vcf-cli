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
import { existsSync, statSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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
      "# VCF-MCP config. See docs/STABILITY.md for the schema contract.",
      "# Edit with care — loader validates on every run and refuses invalid files.",
      "version: 1",
      "",
      "workspace:",
      "  allowed_roots:",
      `    - ${workspaceRoot}`,
      `    - ${homedir()}/projects`,
      `  ideas_dir: ${workspaceRoot}/ideas`,
      `  specs_dir: ${workspaceRoot}/specs`,
      "",
      "endpoints:",
      "  # Seed entry: a local Ollama. Replace or extend with your own endpoints.",
      "  # `vcf register-endpoint` appends new blocks safely.",
      "  - name: local-ollama",
      "    provider: openai-compatible",
      "    base_url: http://127.0.0.1:11434/v1",
      "    trust_level: local",
      "",
      "kb:",
      `  root: ${homedir()}/.vcf/kb`,
      "  # Third-party primer packs. `vcf pack add --name <slug> --path <abs>` splices in.",
      "  packs: []",
      "",
      "review:",
      "  # Add categories here (e.g. accessibility, performance) and drop matching",
      "  # stage files under kb/review-system/<name>/ — no code change required.",
      '  categories: ["code", "security", "production"]',
      "  auto_advance_on_pass: true",
      "  stale_primer_days: 180",
      "",
      "telemetry:",
      `  error_reporting_enabled: ${telemetryEnabled ? "true" : "false"}`,
      "",
      "audit:",
      "  # Set to true to also store redacted JSON of each tool call's inputs/outputs",
      "  # (columns added to the audit table). Hashes are always written regardless.",
      "  full_payload_storage: false",
      "",
      "# Optional: embedding-based primer selection. Requires `vcf embed-kb` to populate.",
      "# Uncomment + point `endpoint` at one of the endpoints above.",
      "# embeddings:",
      "#   endpoint: local-ollama",
      "#   model: nomic-embed-text",
      "#   blend_weight: 0.5",
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

function classifyKind(filePath: string): string {
  // Normalize backslashes to forward-slashes so the directory-probe checks
  // below behave identically on Windows (path.sep='\\') and POSIX.
  const p = filePath.replace(/\\/g, "/");
  if (p.includes("/plans/decisions/")) return "decision";
  if (p.endsWith("-plan.md")) return "plan";
  if (p.endsWith("-todo.md")) return "todo";
  if (p.endsWith("-manifest.md")) return "manifest";
  if (p.endsWith("-spec.md")) return "spec";
  if (p.includes("/memory/daily-logs/")) return "daily-log";
  if (p.includes("/plans/reviews/")) return "review-report";
  return "doc";
}

// ---- vcf verify ------------------------------------------------------------

interface VerifyFinding {
  section: string;
  level: "ok" | "warn" | "error";
  detail: string;
}

async function runVerify(opts: { format?: string } = {}): Promise<void> {
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

    // Each registered KB pack: does its root exist, and does the kb/
    // subdir have any entries?
    for (const pack of config.kb.packs) {
      try {
        const st = statSync(pack.root);
        if (!st.isDirectory()) {
          findings.push({
            section: "kb-packs",
            level: "error",
            detail: `pack '${pack.name}' root ${pack.root} is not a directory`,
          });
          continue;
        }
        const packKb = join(pack.root, "kb");
        if (!existsSync(packKb)) {
          findings.push({
            section: "kb-packs",
            level: "warn",
            detail: `pack '${pack.name}' has no kb/ subdir at ${packKb} — entries will be empty`,
          });
          continue;
        }
        const packEntries = await loadKb(packKb);
        findings.push({
          section: "kb-packs",
          level: packEntries.length > 0 ? "ok" : "warn",
          detail:
            packEntries.length > 0
              ? `pack '${pack.name}' has ${packEntries.length} entr(y|ies) at ${pack.root}`
              : `pack '${pack.name}' is empty at ${pack.root}`,
        });
      } catch (e) {
        findings.push({
          section: "kb-packs",
          level: "error",
          detail: `pack '${pack.name}' at ${pack.root}: ${(e as Error).message}`,
        });
      }
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
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  if (opts.format === "json") {
    // Structured output for automation (n8n, cron, CI). stdout, not stderr,
    // so pipelines can `| jq` cleanly. Non-zero exit on any error-level
    // finding stays in place.
    process.stdout.write(JSON.stringify({ ok: errs === 0, errs, warns, findings }, null, 2) + "\n");
  } else {
    for (const f of findings) {
      process.stderr.write(`  [${f.level.toUpperCase().padEnd(5)}] ${f.section}: ${f.detail}\n`);
    }
  }
  if (errs > 0) {
    err(`verify failed: ${errs} error(s)`, 3);
  }
  if (opts.format !== "json") log("verify ok");
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

interface StaleRecord {
  id: string;
  pack?: string;
  days_old: number;
  updated: string;
  path: string;
}

async function runStaleCheck(opts: { format?: string } = {}): Promise<void> {
  const config = await loadConfigOrExit();
  const entries = await loadKb(config.kb.root, config.kb.packs);
  const thresholdMs = config.review.stale_primer_days * 86_400_000;
  const now = Date.now();
  const stale: StaleRecord[] = [];
  const undated: string[] = [];
  for (const e of entries) {
    const when = e.last_reviewed ?? e.updated;
    if (!when) {
      undated.push(e.id);
      continue;
    }
    const ts = Date.parse(when);
    if (!Number.isFinite(ts)) continue;
    if (now - ts > thresholdMs) {
      const daysOld = Math.floor((now - ts) / 86_400_000);
      const rec: StaleRecord = {
        id: e.id,
        days_old: daysOld,
        updated: when,
        path: e.path,
      };
      if (e.pack !== undefined) rec.pack = e.pack;
      stale.push(rec);
    }
  }
  if (opts.format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          threshold_days: config.review.stale_primer_days,
          total: entries.length,
          stale_count: stale.length,
          undated_count: undated.length,
          stale,
          undated,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  for (const id of undated) {
    process.stderr.write(`  [WARN] ${id}: no last_reviewed / updated frontmatter\n`);
  }
  for (const r of stale) {
    process.stderr.write(`  [STALE] ${r.id}: ${r.days_old} days old (updated=${r.updated})\n`);
  }
  log(
    `stale-check: ${stale.length} stale / ${entries.length} total (threshold ${config.review.stale_primer_days}d)`,
  );
}

// ---- vcf health -----------------------------------------------------------
//
// Ping each configured endpoint and report reachability. Designed for
// scheduled automation: `--format json` emits a structured report for
// n8n / cron / CI; default text mode is operator-readable.
//
// The probe is deliberately tiny: HEAD the base_url (OpenAI-compatible
// servers almost always respond to it even without auth), fall back to
// GET on 405/501. Any 2xx or 4xx response counts as "reachable" — 4xx
// from `/v1/` is expected when you haven't authenticated. 5xx / network
// errors / timeouts count as unreachable.

interface HealthResult {
  name: string;
  base_url: string;
  reachable: boolean;
  status?: number;
  duration_ms: number;
  error?: string;
}

async function pingEndpoint(url: string, timeoutMs: number): Promise<number | string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", signal: ctrl.signal });
    }
    return res.status;
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") return "timeout";
    return err.message || "unknown";
  } finally {
    clearTimeout(timer);
  }
}

async function runHealth(opts: { format?: string; timeoutMs?: number } = {}): Promise<void> {
  const config = await loadConfigOrExit();
  const timeout = opts.timeoutMs ?? 5000;
  const results: HealthResult[] = [];
  for (const ep of config.endpoints) {
    const startedAt = Date.now();
    const probe = await pingEndpoint(ep.base_url, timeout);
    const duration = Date.now() - startedAt;
    const result: HealthResult = {
      name: ep.name,
      base_url: ep.base_url,
      reachable: typeof probe === "number" && probe < 500,
      duration_ms: duration,
    };
    if (typeof probe === "number") result.status = probe;
    else result.error = probe;
    results.push(result);
  }
  const unreachable = results.filter((r) => !r.reachable);
  if (opts.format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          ok: unreachable.length === 0,
          total: results.length,
          unreachable_count: unreachable.length,
          endpoints: results,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const r of results) {
      const tag = r.reachable ? "OK" : "DOWN";
      const detail = r.reachable
        ? `HTTP ${r.status} (${r.duration_ms}ms)`
        : `${r.error ?? `HTTP ${r.status ?? "?"}`} (${r.duration_ms}ms)`;
      process.stderr.write(`  [${tag.padEnd(4)}] ${r.name.padEnd(20)} ${r.base_url}  ${detail}\n`);
    }
    log(`health: ${unreachable.length} unreachable / ${results.length} total`);
  }
  if (unreachable.length > 0) process.exit(9);
}

// ---- vcf pack (add / list / remove) ---------------------------------------
//
// Manage third-party KB packs — community primer/best-practice/lens
// extensions that live alongside the main @kaelith-labs/kb content.
// Each pack is a directory with a `kb/` subtree mirroring the main KB
// layout. Pack entries load with IDs prefixed `@<name>/...` so they
// can never shadow main-KB files.
//
// These commands splice into `kb.packs:` in config.yaml (same pattern
// as register-endpoint). No MCP equivalent — registration is a
// deterministic operator action, not an LLM path.

async function runPackAdd(opts: { name: string; path: string }): Promise<void> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  let body = "";
  try {
    body = await readFile(path, "utf8");
  } catch {
    err(`config not found at ${path} — run 'vcf init' first`, 2);
  }
  const absRoot = resolvePath(opts.path);
  // We need a `kb:` block with either a `packs:` sub-key or none yet.
  // Simplest path: append to the end if no packs; splice under an
  // existing packs: header otherwise.
  if (/^\s{2}packs:\s*$/m.test(body)) {
    // Existing packs: block — insert after it.
    const entry = [`    - name: ${opts.name}`, `      root: ${absRoot}`].join("\n");
    const updated = body.replace(/^(\s{2}packs:\s*\n)/m, `$1${entry}\n`);
    if (updated === body) err("could not splice into kb.packs block; edit manually", 4);
    await writeFile(`${path}.bak`, body, "utf8");
    await writeFile(path, updated, "utf8");
  } else if (/^kb:\s*$/m.test(body)) {
    // kb: block exists but no packs: sub-key — append one under it.
    // We assume kb: block is contiguous (common case); splice before the
    // next top-level key or EOF.
    const kbStart = body.search(/^kb:\s*$/m);
    // Find end of kb block: next line starting at col 0 that's not
    // whitespace-continuation, OR EOF.
    const lines = body.split("\n");
    let lineIdx = 0;
    let charIdx = 0;
    while (charIdx < kbStart) {
      charIdx += lines[lineIdx]!.length + 1;
      lineIdx++;
    }
    // Find end of kb block.
    let endIdx = lineIdx + 1;
    while (endIdx < lines.length) {
      const l = lines[endIdx]!;
      if (l.length > 0 && !l.startsWith(" ") && !l.startsWith("\t")) break;
      endIdx++;
    }
    const insertion = ["  packs:", `    - name: ${opts.name}`, `      root: ${absRoot}`];
    lines.splice(endIdx, 0, ...insertion);
    const updated = lines.join("\n");
    await writeFile(`${path}.bak`, body, "utf8");
    await writeFile(path, updated, "utf8");
  } else {
    err("config.yaml has no 'kb:' key — edit the file manually", 4);
  }
  log(`registered KB pack '${opts.name}' → ${absRoot} (backup at ${path}.bak)`);
  try {
    await loadConfig(path);
    log("config re-validated");
  } catch (e) {
    err(`config failed re-validation: ${(e as Error).message} — restoring from backup`, 5);
  }
}

async function runPackList(): Promise<void> {
  const config = await loadConfigOrExit();
  if (config.kb.packs.length === 0) {
    log("no KB packs registered");
    return;
  }
  for (const p of config.kb.packs) {
    process.stderr.write(`  ${p.name.padEnd(24)}  ${p.root}\n`);
  }
  log(`${config.kb.packs.length} pack(s) registered`);
}

async function runPackRemove(name: string): Promise<void> {
  const path = process.env["VCF_CONFIG"] ?? DEFAULT_CONFIG_PATH();
  let body = "";
  try {
    body = await readFile(path, "utf8");
  } catch {
    err(`config not found at ${path}`, 2);
  }
  // Remove the matching `- name: <name>` entry and its indented root line.
  // Regex: `    - name: <name>\n      root: ...\n` — both indented under packs.
  const pattern = new RegExp(
    `^\\s{4}- name:\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\n\\s{6}root:[^\\n]*\\n`,
    "m",
  );
  if (!pattern.test(body)) {
    err(`pack '${name}' not found in ${path}`, 2);
  }
  const updated = body.replace(pattern, "");
  await writeFile(`${path}.bak`, body, "utf8");
  await writeFile(path, updated, "utf8");
  log(`removed KB pack '${name}' (backup at ${path}.bak)`);
  try {
    await loadConfig(path);
    log("config re-validated");
  } catch (e) {
    err(`config failed re-validation: ${(e as Error).message} — restoring from backup`, 5);
  }
}

// ---- vcf project (register / list / scan / unregister / refresh) ----------
//
// Cross-project registry maintenance. `project_init` (MCP tool) auto-
// registers new projects; these commands cover pre-existing projects
// and explicit deregistration. Operates against the global DB only —
// the authoritative per-project state lives in each project.db.

async function runProjectRegister(opts: { path: string; name?: string }): Promise<void> {
  const { openGlobalDb } = await import("./db/global.js");
  const { upsertProject } = await import("./util/projectRegistry.js");
  const { openProjectDb } = await import("./db/project.js");
  const absRoot = resolvePath(opts.path);
  const projectDbPath = join(absRoot, ".vcf", "project.db");
  if (!existsSync(projectDbPath)) {
    err(`${absRoot} is not an initialized VCF project (no .vcf/project.db)`, 2);
  }
  // Read name + state from the project.db so registration matches the
  // project's own metadata. Falls back to the dir basename for name and
  // 'draft' for state if the row is missing (shouldn't happen on a
  // properly-initialized project).
  const pdb = openProjectDb({ path: projectDbPath });
  const row = pdb.prepare("SELECT name, state FROM project WHERE id = 1").get() as
    | { name: string; state: string }
    | undefined;
  pdb.close();
  const name =
    opts.name ??
    (row ? slugifyBasic(row.name) : slugifyBasic(absRoot.split("/").pop() ?? "project"));
  const state = row?.state ?? null;

  const globalDb = openGlobalDb({ path: resolvePath(homedir(), ".vcf", "vcf.db") });
  try {
    upsertProject(globalDb, { name, root_path: absRoot, state });
    log(`registered project '${name}' → ${absRoot}`);
  } finally {
    globalDb.close();
  }
}

async function runProjectList(): Promise<void> {
  const { openGlobalDb } = await import("./db/global.js");
  const { listProjects } = await import("./util/projectRegistry.js");
  const globalDb = openGlobalDb({ path: resolvePath(homedir(), ".vcf", "vcf.db") });
  try {
    const rows = listProjects(globalDb);
    if (rows.length === 0) {
      log(
        "no projects registered — use `vcf project register <path>` or `vcf project scan <root>`",
      );
      return;
    }
    for (const p of rows) {
      const age = p.last_seen_at
        ? `${Math.floor((Date.now() - p.last_seen_at) / 1000)}s ago`
        : "never";
      process.stderr.write(
        `  ${p.name.padEnd(24)} ${(p.state_cache ?? "—").padEnd(10)} ${p.root_path} (seen ${age})\n`,
      );
    }
    log(`${rows.length} project(s) registered`);
  } finally {
    globalDb.close();
  }
}

async function runProjectScan(opts: { root: string }): Promise<void> {
  const { openGlobalDb } = await import("./db/global.js");
  const { upsertProject } = await import("./util/projectRegistry.js");
  const { openProjectDb } = await import("./db/project.js");
  const absRoot = resolvePath(opts.root);
  if (!existsSync(absRoot)) {
    err(`root ${absRoot} does not exist`, 2);
  }
  // Walk up to 4 dirs deep looking for .vcf/project.db. Cheap enough
  // for typical workspace trees; users with deeper hierarchies can
  // register manually.
  const found: Array<{ root: string; name: string; state: string }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    const dbCandidate = join(dir, ".vcf", "project.db");
    if (existsSync(dbCandidate)) {
      const pdb = openProjectDb({ path: dbCandidate });
      const row = pdb.prepare("SELECT name, state FROM project WHERE id = 1").get() as
        | { name: string; state: string }
        | undefined;
      pdb.close();
      if (row) found.push({ root: dir, name: slugifyBasic(row.name), state: row.state });
      return; // don't recurse into a project's own tree
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  await walk(absRoot, 0);
  if (found.length === 0) {
    log(`no VCF projects found under ${absRoot}`);
    return;
  }
  const globalDb = openGlobalDb({ path: resolvePath(homedir(), ".vcf", "vcf.db") });
  try {
    for (const p of found) {
      upsertProject(globalDb, { name: p.name, root_path: p.root, state: p.state });
      process.stderr.write(`  registered '${p.name}' → ${p.root}\n`);
    }
    log(`scan: ${found.length} project(s) registered`);
  } finally {
    globalDb.close();
  }
}

async function runProjectUnregister(name: string): Promise<void> {
  const { openGlobalDb } = await import("./db/global.js");
  const { unregisterProject } = await import("./util/projectRegistry.js");
  const globalDb = openGlobalDb({ path: resolvePath(homedir(), ".vcf", "vcf.db") });
  try {
    const dropped = unregisterProject(globalDb, name);
    if (dropped) log(`unregistered project '${name}' (files untouched)`);
    else err(`no project named '${name}' in registry`, 2);
  } finally {
    globalDb.close();
  }
}

async function runProjectRefresh(): Promise<void> {
  const { openGlobalDb } = await import("./db/global.js");
  const { listProjects, setProjectState } = await import("./util/projectRegistry.js");
  const { openProjectDb } = await import("./db/project.js");
  const globalDb = openGlobalDb({ path: resolvePath(homedir(), ".vcf", "vcf.db") });
  try {
    const rows = listProjects(globalDb);
    let refreshed = 0;
    for (const p of rows) {
      const pdbPath = join(p.root_path, ".vcf", "project.db");
      if (!existsSync(pdbPath)) {
        process.stderr.write(
          `  [MISSING] ${p.name}: ${pdbPath} not found — consider unregistering\n`,
        );
        continue;
      }
      const pdb = openProjectDb({ path: pdbPath });
      const row = pdb.prepare("SELECT state FROM project WHERE id = 1").get() as
        | { state: string }
        | undefined;
      pdb.close();
      if (row) {
        setProjectState(globalDb, p.root_path, row.state);
        refreshed++;
      }
    }
    log(`refresh: ${refreshed}/${rows.length} project state(s) updated`);
  } finally {
    globalDb.close();
  }
}

/** Minimal slug helper — strictly the registry name shape. */
function slugifyBasic(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 128) || "project"
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
  const pkgSkillsDir = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "skills", client);
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
//
// Three-way merge (Phase-2 upgrade over the MVP's warn+skip):
//
//   1. An ancestor snapshot of the upstream KB at last sync lives under
//      ~/.vcf/kb-ancestors/<same relative layout>. First run without an
//      ancestor: the upstream tree is adopted as the baseline (local edits
//      survive; we just can't auto-merge the first delta).
//   2. For each upstream file <rel>:
//        local    = ${kbRoot}/<rel>
//        ancestor = ~/.vcf/kb-ancestors/<rel>
//      Outcome rules:
//        - local missing                     → copy upstream, seed ancestor   [added]
//        - local == upstream                 → seed ancestor if needed         [in-sync]
//        - ancestor missing                  → two sides diverged with no base → conflict (preserve local, write .upstream sibling)
//        - ancestor == upstream              → upstream unchanged, local edits kept [local-only]
//        - ancestor == local                 → local untouched, upstream moved → adopt upstream [fast-forward]
//        - both sides moved from ancestor    → `git merge-file -p local ancestor upstream`
//            • clean merge (exit 0) → write merged local, re-seed ancestor    [auto-merged]
//            • conflict markers (exit 1) → write merged local + keep old ancestor [conflict]
//
// `git merge-file` is a no-new-dep choice: git is already required by the
// framework (project_init runs `git init`; git hooks are part of the KB).
// Using it keeps diff3 semantics identical to what every developer expects.

interface MergeOutcome {
  rel: string;
  kind: "added" | "in-sync" | "local-only" | "fast-forward" | "auto-merged" | "conflict";
  note?: string;
}
interface MergeReport {
  outcomes: MergeOutcome[];
  counts: Record<MergeOutcome["kind"], number>;
}

export async function mergePrimerTree(opts: {
  kbRoot: string;
  upstreamRoot: string;
  ancestorRoot: string;
  /** Optional override for tests; defaults to real git. */
  runGitMergeFile?: (local: string, ancestor: string, upstream: string) => { exitCode: number };
}): Promise<MergeReport> {
  const { kbRoot, upstreamRoot, ancestorRoot } = opts;
  const runMerge = opts.runGitMergeFile ?? defaultRunGitMergeFile;
  await mkdir(kbRoot, { recursive: true });
  await mkdir(ancestorRoot, { recursive: true });

  const outcomes: MergeOutcome[] = [];
  const counts: Record<MergeOutcome["kind"], number> = {
    added: 0,
    "in-sync": 0,
    "local-only": 0,
    "fast-forward": 0,
    "auto-merged": 0,
    conflict: 0,
  };

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
      const localPath = join(kbRoot, rel);
      const ancestorPath = join(ancestorRoot, rel);

      // Case 1: local missing — straight copy, seed ancestor.
      if (!existsSync(localPath)) {
        await mkdir(dirname(localPath), { recursive: true });
        await copyFile(full, localPath);
        await mkdir(dirname(ancestorPath), { recursive: true });
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "added" });
        counts.added++;
        continue;
      }

      const [upBuf, localBuf] = await Promise.all([readFile(full), readFile(localPath)]);
      const upHash = sha256(upBuf);
      const localHash = sha256(localBuf);

      // Case 2: already in sync.
      if (upHash === localHash) {
        await mkdir(dirname(ancestorPath), { recursive: true });
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "in-sync" });
        counts["in-sync"]++;
        continue;
      }

      // Case 3: no ancestor — can't tell who changed. Preserve local; write
      // .upstream sibling so the user can diff by hand.
      if (!existsSync(ancestorPath)) {
        await writeFile(`${localPath}.upstream`, upBuf);
        outcomes.push({
          rel,
          kind: "conflict",
          note: "no ancestor baseline; local kept, upstream written to .upstream sibling",
        });
        counts.conflict++;
        continue;
      }

      const ancestorBuf = await readFile(ancestorPath);
      const ancestorHash = sha256(ancestorBuf);

      // Case 4: upstream unchanged since last sync — keep local edits.
      if (ancestorHash === upHash) {
        outcomes.push({ rel, kind: "local-only" });
        counts["local-only"]++;
        continue;
      }

      // Case 5: local unchanged since last sync — fast-forward.
      if (ancestorHash === localHash) {
        await copyFile(full, localPath);
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "fast-forward" });
        counts["fast-forward"]++;
        continue;
      }

      // Case 6: both sides diverged — true three-way merge via git merge-file.
      const { exitCode } = runMerge(localPath, ancestorPath, full);
      if (exitCode === 0) {
        // Clean auto-merge — local now holds the merged content. Re-seed ancestor.
        await copyFile(full, ancestorPath);
        outcomes.push({ rel, kind: "auto-merged" });
        counts["auto-merged"]++;
      } else {
        // Conflict markers written into localPath by git merge-file -p ...
        // we did NOT use -p because we want in-place edit; instead we passed
        // the files directly and git writes markers. Keep ancestor unchanged
        // so the user can re-run after resolving.
        outcomes.push({
          rel,
          kind: "conflict",
          note: "git merge-file emitted conflict markers — resolve in place, then re-run",
        });
        counts.conflict++;
      }
    }
  }

  return { outcomes, counts };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function defaultRunGitMergeFile(
  local: string,
  ancestor: string,
  upstream: string,
): { exitCode: number } {
  // In-place three-way merge. Git writes merged content (with conflict
  // markers on collision) to <local> and exits 0 on clean, >0 on conflict.
  const res = spawnSync(
    "git",
    ["merge-file", "-L", "local", "-L", "ancestor", "-L", "upstream", local, ancestor, upstream],
    {
      encoding: "utf8",
    },
  );
  return { exitCode: typeof res.status === "number" ? res.status : -1 };
}

async function runUpdatePrimers(): Promise<void> {
  const config = await loadConfigOrExit();
  const kbRoot = config.kb.root;
  const ancestorRoot = resolvePath(homedir(), ".vcf", "kb-ancestors");
  let upstreamRoot: string | null = null;
  const candidates = [
    resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "vcf-kb", "kb"),
    resolvePath(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      "@kaelith-labs",
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
  log(`update-primers: ${kbRoot} ← ${upstreamRoot} (ancestor: ${ancestorRoot})`);

  const report = await mergePrimerTree({ kbRoot, upstreamRoot, ancestorRoot });
  for (const o of report.outcomes) {
    if (o.kind === "conflict" || o.kind === "auto-merged") {
      process.stderr.write(`  [${o.kind.toUpperCase()}] ${o.rel}${o.note ? ` — ${o.note}` : ""}\n`);
    }
  }
  const c = report.counts;
  log(
    `update-primers: ${c.added} added, ${c["fast-forward"]} fast-forward, ${c["auto-merged"]} auto-merged, ${c["local-only"]} kept-local, ${c["in-sync"]} in-sync, ${c.conflict} conflict(s)`,
  );
  if (c.conflict > 0) {
    process.exit(7);
  }
}

// ---- vcf embed-kb ----------------------------------------------------------
//
// Populate the embedding cache that spec_suggest_primers blends against the
// tag matcher. Config block `embeddings: { endpoint, model, blend_weight,
// cache_dir? }` picks the target. Re-runs are idempotent — entries whose
// content hash matches the cached record are skipped.

async function runEmbedKb(opts: { only?: string; force?: boolean }): Promise<void> {
  const config = await loadConfigOrExit();
  if (!config.embeddings) {
    err(
      "no embeddings block in config — add `embeddings: { endpoint, model }` under the top-level to enable blended matching",
      2,
    );
  }
  const endpoint = config.endpoints.find((e) => e.name === config.embeddings!.endpoint);
  if (!endpoint) {
    err(`embeddings.endpoint '${config.embeddings!.endpoint}' missing from endpoints[]`, 2);
  }
  const kbRoot = config.kb.root;
  const { loadKb } = await import("./primers/load.js");
  const entries = await loadKb(kbRoot);
  const allowedKinds = new Set(["primer", "best-practice", "lens", "standard"]);
  const filteredByKind = entries.filter((e) => allowedKinds.has(e.kind));
  const filtered = opts.only ? filteredByKind.filter((e) => e.kind === opts.only) : filteredByKind;
  if (filtered.length === 0) {
    log("embed-kb: nothing to embed (KB empty or filter excludes everything)");
    return;
  }

  // Resolve API key if needed.
  let apiKey: string | undefined;
  if (endpoint.auth_env_var) {
    apiKey = process.env[endpoint.auth_env_var];
    if (!apiKey && endpoint.trust_level !== "local") {
      err(`env var ${endpoint.auth_env_var} unset; endpoint '${endpoint.name}' needs it`, 3);
    }
  }

  const cacheDir = config.embeddings!.cache_dir ?? resolvePath(homedir(), ".vcf", "embeddings");
  await mkdir(cacheDir, { recursive: true });

  const { callEmbeddings, LlmError } = await import("./util/llmClient.js");
  const { buildEmbeddingInput, writeEmbeddingRecord, sha256 } = await import("./primers/embed.js");

  log(
    `embed-kb: ${filtered.length} entr(y|ies) via ${endpoint.name} (model=${config.embeddings!.model})`,
  );

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of filtered) {
    const cacheFile = join(cacheDir, `${entry.id}.json`);
    const body = await readFile(entry.path, "utf8");
    const input = buildEmbeddingInput(entry, body);
    const hash = sha256(input);

    if (!opts.force && existsSync(cacheFile)) {
      try {
        const existing = JSON.parse(await readFile(cacheFile, "utf8")) as {
          content_sha256?: string;
          model?: string;
        };
        if (existing.content_sha256 === hash && existing.model === config.embeddings!.model) {
          skipped++;
          continue;
        }
      } catch {
        // corrupt cache entry — fall through and regenerate
      }
    }

    try {
      const [vector] = await callEmbeddings({
        baseUrl: endpoint.base_url,
        apiKey,
        model: config.embeddings!.model,
        inputs: [input],
      });
      if (!vector || vector.length === 0) {
        failed++;
        process.stderr.write(`  ${entry.id}: empty vector\n`);
        continue;
      }
      await writeEmbeddingRecord(cacheDir, entry.id, {
        model: config.embeddings!.model,
        dim: vector.length,
        content_sha256: hash,
        vector,
        updated_at: Date.now(),
      });
      embedded++;
    } catch (e) {
      failed++;
      const msg = e instanceof LlmError ? `${e.kind}: ${e.message}` : (e as Error).message;
      process.stderr.write(`  ${entry.id}: ${msg}\n`);
    }
  }

  log(
    `embed-kb: ${embedded} embedded, ${skipped} unchanged, ${failed} failed (cache: ${cacheDir})`,
  );
  if (failed > 0) process.exit(8);
}

// ---- vcf admin audit -------------------------------------------------------

async function runAdminAudit(opts: {
  tool?: string;
  project?: string;
  since?: string;
  format: string;
  full?: boolean;
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
  const extra = opts.full ? ", inputs_json, outputs_json" : "";
  const rows = globalDb
    .prepare(
      `SELECT id, ts, tool, scope, project_root, client_id, inputs_hash, outputs_hash, endpoint, result_code${extra}
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
    inputs_json?: string | null;
    outputs_json?: string | null;
  }>;

  if (opts.format === "json") {
    // stdout so `vcf admin audit --format json | jq` works. The CLI is not
    // the MCP stdio transport (that's src/mcp.ts).
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else if (opts.format === "csv") {
    const header = opts.full
      ? "id,ts,tool,scope,project_root,client_id,inputs_hash,outputs_hash,endpoint,result_code,inputs_json,outputs_json\n"
      : "id,ts,tool,scope,project_root,client_id,inputs_hash,outputs_hash,endpoint,result_code\n";
    process.stdout.write(header);
    for (const r of rows) {
      const base = [
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
      ];
      const full = opts.full
        ? [csvEscape(r.inputs_json ?? ""), csvEscape(r.outputs_json ?? "")]
        : [];
      process.stdout.write([...base, ...full].join(",") + "\n");
    }
  } else {
    // table
    for (const r of rows) {
      process.stderr.write(
        `${new Date(r.ts).toISOString()}  ${r.scope.padEnd(7)} ${r.tool.padEnd(26)} ${r.result_code.padEnd(16)} ${r.project_root ?? "-"}\n`,
      );
      if (opts.full && (r.inputs_json || r.outputs_json)) {
        process.stderr.write(`  inputs:  ${r.inputs_json ?? "(null)"}\n`);
        process.stderr.write(`  outputs: ${r.outputs_json ?? "(null)"}\n`);
      }
    }
    log(
      `admin audit: ${rows.length} row(s)${opts.full ? " (--full: includes redacted payloads when available)" : ""}`,
    );
  }
  globalDb.close();
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
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
    // stdout (not stderr) so shell pipelines and smoke tests that grep
    // version output work. Prefix matches the package + tap + bucket name
    // (vcf-cli) so downstream regex in the brew formula `test do` block
    // and the packaging/smoke-tests/ scripts all agree on one format.
    process.stdout.write(`vcf-cli ${VERSION} (MCP spec ${MCP_SPEC_VERSION})\n`);
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
  .option("--format <fmt>", "text (default) | json", "text")
  .action(async (opts: { format?: string }) => {
    try {
      await runVerify(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

program
  .command("health")
  .description("Ping each configured endpoint and report reachability. Exits 9 if any unreachable.")
  .option("--format <fmt>", "text (default) | json", "text")
  .option("--timeout-ms <ms>", "per-endpoint HTTP timeout", (v) => parseInt(v, 10), 5000)
  .action(async (opts: { format?: string; timeoutMs?: number }) => {
    try {
      await runHealth(opts);
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
  .option("--format <fmt>", "text (default) | json", "text")
  .action(async (opts: { format?: string }) => {
    try {
      await runStaleCheck(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

const pack = program
  .command("pack")
  .description("Manage third-party KB packs (community primer extensions).");

pack
  .command("add")
  .description("Register a KB pack directory under kb.packs in config.yaml.")
  .requiredOption("--name <slug>", "unique pack slug (lowercase alphanumeric + hyphen)")
  .requiredOption(
    "--path <absolute-path>",
    "absolute path to the pack root (directory containing kb/)",
  )
  .action(async (opts: { name: string; path: string }) => {
    try {
      await runPackAdd(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

pack
  .command("list")
  .description("List registered KB packs.")
  .action(async () => {
    try {
      await runPackList();
    } catch (e) {
      err((e as Error).message);
    }
  });

pack
  .command("remove")
  .description("Unregister a KB pack from config.yaml.")
  .argument("<name>", "pack slug to remove")
  .action(async (name: string) => {
    try {
      await runPackRemove(name);
    } catch (e) {
      err((e as Error).message);
    }
  });

const project = program
  .command("project")
  .description("Cross-project registry — projects tracked by portfolio_graph + project_list.");

project
  .command("register")
  .description("Add a pre-existing VCF project to the global registry.")
  .requiredOption("--path <absolute-path>", "absolute path to the project root")
  .option("--name <slug>", "override the project's stored name with this slug")
  .action(async (opts: { path: string; name?: string }) => {
    try {
      await runProjectRegister(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("list")
  .description("Show registered projects, state_cache, and last-seen timestamps.")
  .action(async () => {
    try {
      await runProjectList();
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("scan")
  .description("Walk a directory tree for .vcf/project.db dirs and bulk-register them.")
  .requiredOption("--root <absolute-path>", "root to scan (up to 4 dirs deep)")
  .action(async (opts: { root: string }) => {
    try {
      await runProjectScan(opts);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("unregister")
  .description("Drop a project from the registry (does not touch the project's files).")
  .argument("<name>", "registered project slug")
  .action(async (name: string) => {
    try {
      await runProjectUnregister(name);
    } catch (e) {
      err((e as Error).message);
    }
  });

project
  .command("refresh")
  .description("Re-read state_cache from each registered project's project.db.")
  .action(async () => {
    try {
      await runProjectRefresh();
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

program
  .command("embed-kb")
  .description(
    "Precompute embedding vectors for primers/best-practices/lenses/standards. Requires a `config.embeddings` block. Idempotent: unchanged entries are skipped. Cache lives under ~/.vcf/embeddings/ unless overridden.",
  )
  .option("--only <kind>", "restrict to one kind (primer | best-practice | lens | standard)")
  .option("--force", "re-embed even when content hash matches the cached record", false)
  .action(async (opts: { only?: string; force?: boolean }) => {
    try {
      await runEmbedKb(opts);
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
  .option(
    "--full",
    "include redacted inputs/outputs JSON (only populated when config.audit.full_payload_storage is true)",
    false,
  )
  .action(
    async (opts: {
      tool?: string;
      project?: string;
      since?: string;
      format: string;
      full?: boolean;
    }) => {
      try {
        await runAdminAudit(opts);
      } catch (e) {
        err((e as Error).message);
      }
    },
  );

// Only parse argv when this file is run as the CLI entrypoint — otherwise
// importing it from a test (or another module) would trigger a spurious
// command parse against vitest's argv. `pathToFileURL` handles Windows
// drive-letter paths (C:\...) where a naïve `file://` prefix would break.
//
// argv[1] must be resolved through realpath first: Homebrew, Scoop, and
// npm all install the `vcf` binary as a symlink into a versioned
// Cellar / shim directory, so argv[1] is the symlink path while
// import.meta.url is the symlink *target*. Comparing the URLs naïvely
// fails and main() never runs — the binary silently exits 0 on every
// invocation. realpathSync canonicalizes both sides of the comparison.
const entryUrl = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return "";
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // Fallback if realpath fails (e.g. bundled single-file binary) —
    // compare on the raw argv path, matching the pre-realpath behavior.
    return pathToFileURL(argv1).href;
  }
})();
if (import.meta.url === entryUrl) {
  program.parseAsync(process.argv).catch((e: unknown) => {
    err(e instanceof Error ? e.message : String(e));
  });
}
