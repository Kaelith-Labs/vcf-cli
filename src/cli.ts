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
    process.stderr.write(JSON.stringify(rows, null, 2) + "\n");
  } else if (opts.format === "csv") {
    const header = opts.full
      ? "id,ts,tool,scope,project_root,client_id,inputs_hash,outputs_hash,endpoint,result_code,inputs_json,outputs_json\n"
      : "id,ts,tool,scope,project_root,client_id,inputs_hash,outputs_hash,endpoint,result_code\n";
    process.stderr.write(header);
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
      process.stderr.write([...base, ...full].join(",") + "\n");
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
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  program.parseAsync(process.argv).catch((e: unknown) => {
    err(e instanceof Error ? e.message : String(e));
  });
}
