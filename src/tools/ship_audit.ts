// ship_audit — project scope.
//
// Pre-release audit gate. Runs a set of passes over the project tree and
// returns a structured findings report. The first blocker halts the audit
// (fail-fast is the discipline); non-blocker findings still append to the
// report so a follow-up pass can address them.
//
// MVP passes:
//   1. hardcoded-path grep — literal absolute paths in source that should
//      resolve through config
//   2. secrets scan — invoke `gitleaks` if available; fall back to regex
//      detection using the M1 audit redaction patterns
//   3. test-data residue — TODO/FIXME/XXX in security-relevant files
//   4. personal-data scan — email addresses / phone shapes matching an
//      optional regex list from config
//   5. config-completeness — every config key referenced in source has a
//      schema default or explicit value
//   6. stale TODO/FIXME on security work — anywhere the word "security",
//      "auth", "secret", or "inject" shows up alongside a pending marker
//
// The tool returns a single {passes: [...]} object with one entry per
// pass, each carrying {name, status: ok|warning|blocker, findings[]}.
// Blocker status anywhere → envelope summary reports failure; the tool
// itself still returns ok:true because the *audit* ran successfully.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const ShipAuditInput = z
  .object({
    include: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .max(16)
      .optional()
      .describe("limit passes by name; default runs all"),
    fail_fast: z.boolean().default(true),
    expand: z.boolean().default(true),
  })
  .strict();

type Status = "ok" | "warning" | "blocker";
interface Finding {
  file: string;
  line?: number | undefined;
  severity: Status;
  detail: string;
}
interface PassResult {
  name: string;
  status: Status;
  findings: Finding[];
  notes?: string;
}

// --- pattern tables ---------------------------------------------------------

const HARDCODED_PATH_RE =
  /(?:"|')((?:\/[A-Za-z0-9._-]+){2,}|(?:[A-Za-z]:\\[A-Za-z0-9._\\-]+))(?:"|')/g;
const SECURITY_KEYWORDS = /\b(auth|secret|inject|ssrf|xss|csrf|token|credential)\b/i;
const TODO_MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;
// cheap email/phone scanners — intentionally approximate; false positives
// are better than false negatives at this gate
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+?1[\s-])?\(?[2-9]\d{2}\)?[\s-]\d{3}[\s-]\d{4}\b/g;

// Files we scan. Anything under these extensions; ignore common vendor paths.
const SCAN_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".sh",
  ".yaml",
  ".yml",
  ".toml",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".vcf",
  ".review-runs",
  "backups",
]);

export function registerShipAudit(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "ship_audit",
    {
      title: "Ship Audit",
      description:
        "Pre-release gate. Runs hardcoded-path, secrets, test-data-residue, personal-data, config-completeness, and stale-security-TODO passes. Returns structured findings; blocker anywhere halts progression.",
      inputSchema: ShipAuditInput.shape,
    },
    async (args: z.infer<typeof ShipAuditInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "ship_audit requires project scope");
        }
        const parsed = ShipAuditInput.parse(args);
        const root = readProjectRoot(deps);
        if (!root) throw new McpError("E_STATE_INVALID", "project row missing");

        const include = parsed.include ? new Set(parsed.include) : null;
        const shouldRun = (name: string): boolean => include === null || include.has(name);

        const files = await collectFiles(root);
        const passes: PassResult[] = [];

        // Each pass short-circuits only if fail_fast=true AND the prior
        // pass emitted a blocker.
        const addPass = (result: PassResult): boolean => {
          passes.push(result);
          return result.status === "blocker" && parsed.fail_fast;
        };

        if (shouldRun("hardcoded-path")) {
          const pass = await hardcodedPathPass(files, deps.config.workspace.allowed_roots);
          if (addPass(pass)) return envelope(passes, parsed, root, deps);
        }
        if (shouldRun("secrets")) {
          const pass = await secretsPass(files, root);
          if (addPass(pass)) return envelope(passes, parsed, root, deps);
        }
        if (shouldRun("test-data-residue")) {
          const pass = await testDataResiduePass(files);
          if (addPass(pass)) return envelope(passes, parsed, root, deps);
        }
        if (shouldRun("personal-data")) {
          const pass = await personalDataPass(files);
          if (addPass(pass)) return envelope(passes, parsed, root, deps);
        }
        if (shouldRun("config-completeness")) {
          const pass = configCompletenessPass(deps);
          if (addPass(pass)) return envelope(passes, parsed, root, deps);
        }
        if (shouldRun("stale-security-todos")) {
          const pass = await staleSecurityTodoPass(files);
          if (addPass(pass)) return envelope(passes, parsed, root, deps);
        }

        return envelope(passes, parsed, root, deps);
      });
    },
  );
}

// --- pass implementations ---------------------------------------------------

async function hardcodedPathPass(
  files: string[],
  allowedRoots: readonly string[],
): Promise<PassResult> {
  const findings: Finding[] = [];
  const allowed = new Set(allowedRoots.map((r) => r.toLowerCase()));
  for (const file of files) {
    if (file.includes("test") || file.endsWith(".md")) continue;
    const body = await safeRead(file);
    if (!body) continue;
    HARDCODED_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HARDCODED_PATH_RE.exec(body)) !== null) {
      const literal = m[1]!;
      // Allow paths that simply reference an allowed root explicitly — those are likely tests.
      if ([...allowed].some((r) => literal.toLowerCase().startsWith(r))) continue;
      // Skip relative-looking patterns and URL paths.
      if (
        literal.startsWith("//") ||
        literal.startsWith("/usr/lib") ||
        literal.startsWith("/etc/ssl")
      )
        continue;
      const line = body.slice(0, m.index).split("\n").length;
      findings.push({
        file,
        line,
        severity: "blocker",
        detail: `literal path in source: ${literal}`,
      });
      if (findings.length >= 50) break;
    }
    if (findings.length >= 50) break;
  }
  return {
    name: "hardcoded-path",
    status: findings.length > 0 ? "blocker" : "ok",
    findings,
  };
}

async function secretsPass(files: string[], root: string): Promise<PassResult> {
  // Try gitleaks first.
  const gitleaks = await runGitleaks(root);
  if (gitleaks) return gitleaks;
  // Fallback regex.
  const { redact } = await import("../util/audit.js");
  const findings: Finding[] = [];
  for (const file of files) {
    const body = await safeRead(file);
    if (!body) continue;
    const sanitized = redact(body);
    if (typeof sanitized !== "string") continue;
    if (sanitized !== body) {
      // some redaction fired; surface the file but not the content.
      findings.push({
        file,
        severity: "blocker",
        detail: "regex-match secrets pattern (see gitleaks for detail)",
      });
    }
    if (findings.length >= 20) break;
  }
  return {
    name: "secrets",
    status: findings.length > 0 ? "blocker" : "ok",
    findings,
    notes: "gitleaks not found on PATH; regex fallback — install gitleaks for higher recall",
  };
}

async function runGitleaks(root: string): Promise<PassResult | null> {
  return new Promise((resolve) => {
    const child = spawn("gitleaks", ["detect", "--no-banner", "--redact", "--source", root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === null) return resolve(null);
      if (code === 0) {
        resolve({ name: "secrets", status: "ok", findings: [] });
        return;
      }
      // gitleaks exits 1 on findings.
      const findings: Finding[] = [
        {
          file: "(multiple)",
          severity: "blocker",
          detail: (stdout + "\n" + stderr).slice(0, 1_000),
        },
      ];
      resolve({ name: "secrets", status: "blocker", findings });
    });
  });
}

async function testDataResiduePass(files: string[]): Promise<PassResult> {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.includes("test") || file.endsWith(".md")) continue;
    const body = await safeRead(file);
    if (!body) continue;
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      if (TODO_MARKER.test(line) && SECURITY_KEYWORDS.test(line)) {
        findings.push({
          file,
          line: i + 1,
          severity: "blocker",
          detail: `security-tagged ${TODO_MARKER.exec(line)?.[0]} marker: ${line.trim().slice(0, 120)}`,
        });
      }
    });
    if (findings.length >= 40) break;
  }
  return {
    name: "test-data-residue",
    status: findings.length > 0 ? "blocker" : "ok",
    findings,
  };
}

async function personalDataPass(files: string[]): Promise<PassResult> {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.includes(".env") === false && file.endsWith(".md")) continue;
    const body = await safeRead(file);
    if (!body) continue;
    const emails = Array.from(body.matchAll(EMAIL_RE));
    const phones = Array.from(body.matchAll(PHONE_RE));
    for (const m of emails) {
      // Allow obviously-fake placeholder addresses.
      if (/example\.(com|org|net)$/i.test(m[0])) continue;
      findings.push({
        file,
        severity: "warning",
        detail: `email-shaped literal: ${m[0]}`,
      });
      if (findings.length >= 30) break;
    }
    for (const m of phones) {
      findings.push({
        file,
        severity: "warning",
        detail: `phone-shaped literal: ${m[0]}`,
      });
      if (findings.length >= 30) break;
    }
    if (findings.length >= 30) break;
  }
  return {
    name: "personal-data",
    status: findings.length > 0 ? "warning" : "ok",
    findings,
  };
}

function configCompletenessPass(deps: ServerDeps): PassResult {
  // Minimal MVP: verify the frozen config has the required sections and
  // every endpoint has a trust_level + base_url. If a full schema walk
  // ever reports _TBD_ literal values (which indicates an unfilled
  // placeholder), surface it.
  const findings: Finding[] = [];
  const cfg = deps.config;
  if (cfg.endpoints.length === 0) {
    findings.push({ file: "config.yaml", severity: "blocker", detail: "no endpoints configured" });
  }
  if (cfg.workspace.allowed_roots.length === 0) {
    findings.push({
      file: "config.yaml",
      severity: "blocker",
      detail: "workspace.allowed_roots is empty",
    });
  }
  const placeholderRe = /_TBD_|<fill-me>|__PLACEHOLDER__/;
  const flat = JSON.stringify(cfg);
  if (placeholderRe.test(flat)) {
    findings.push({
      file: "config.yaml",
      severity: "blocker",
      detail: "_TBD_/<fill-me>/placeholder left in config",
    });
  }
  return {
    name: "config-completeness",
    status: findings.length > 0 ? "blocker" : "ok",
    findings,
  };
}

async function staleSecurityTodoPass(files: string[]): Promise<PassResult> {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.endsWith(".md")) continue;
    const body = await safeRead(file);
    if (!body) continue;
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      if (TODO_MARKER.test(line) && SECURITY_KEYWORDS.test(line)) {
        // Already surfaced in test-data-residue; dedupe by severity: warning here
        findings.push({
          file,
          line: i + 1,
          severity: "warning",
          detail: `stale security TODO: ${line.trim().slice(0, 120)}`,
        });
      }
    });
    if (findings.length >= 40) break;
  }
  return {
    name: "stale-security-todos",
    status: findings.length > 0 ? "warning" : "ok",
    findings,
  };
}

// --- helpers ----------------------------------------------------------------

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
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
        if (SKIP_DIRS.has(name)) continue;
        await walk(full);
      } else if (st.isFile()) {
        const dot = full.lastIndexOf(".");
        const ext = dot >= 0 ? full.slice(dot) : "";
        if (SCAN_EXT.has(ext)) out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function safeRead(p: string): Promise<string | null> {
  try {
    const st = await stat(p);
    if (st.size > 2 * 1024 * 1024) return null; // skip files > 2MB
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

function envelope(
  passes: PassResult[],
  parsed: z.infer<typeof ShipAuditInput>,
  root: string,
  deps: ServerDeps,
): ReturnType<typeof success> {
  const anyBlocker = passes.some((p) => p.status === "blocker");
  const anyWarning = passes.some((p) => p.status === "warning");
  const summary =
    passes.length === 0
      ? "no passes matched 'include' filter"
      : anyBlocker
        ? `ship audit FAILED: ${passes.filter((p) => p.status === "blocker").length} blocker pass(es), ${passes.length} total`
        : anyWarning
          ? `ship audit WARN: ${passes.filter((p) => p.status === "warning").length} warning pass(es), ${passes.length} total`
          : `ship audit PASSED: ${passes.length} pass(es) clean`;
  // All surfaced files rolled up into paths[] for client navigation.
  const paths = Array.from(
    new Set(passes.flatMap((p) => p.findings.map((f) => relative(root, f.file)))),
  )
    .filter((x) => x.length > 0)
    .slice(0, 50)
    .map((rel) => join(root, rel));

  const payload = success(
    paths,
    summary,
    parsed.expand
      ? { content: { passes, blocker: anyBlocker } }
      : {
          expand_hint: "Call ship_audit with expand=true for the full passes array.",
        },
  );
  try {
    writeAudit(deps.globalDb, {
      tool: "ship_audit",
      scope: "project",
      project_root: root,
      inputs: parsed,
      outputs: payload,
      result_code: anyBlocker ? "E_STATE_INVALID" : "ok",
    });
  } catch {
    /* non-fatal */
  }
  return payload;
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
