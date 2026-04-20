// Append-only audit writer.
//
// Contract:
// - every tool call emits exactly one audit row
// - inputs and outputs are *hashed* (sha256) — MVP never stores raw payloads
// - a `redact` pass runs before hashing so the hash itself doesn't encode
//   secret shape (helpful when a downstream operator runs the CLI audit
//   query and correlates by hash)
// - the row always includes tool, scope, project_root (nullable), client_id,
//   endpoint (nullable), and a result_code ('ok' or E_*)
//
// We store audit rows in the **global** DB even for project-scope tools so
// that a single `vcf admin audit` query can reconstruct history across all
// projects the user has touched. Project-local DB also has its own audit
// slice in later milestones if needed.

import { createHash } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { touchProject } from "./projectRegistry.js";

export type AuditScope = "global" | "project" | "cli";

export interface AuditEntryInput {
  tool: string;
  scope: AuditScope;
  project_root?: string | null;
  client_id?: string | null;
  inputs: unknown;
  outputs: unknown;
  endpoint?: string | null;
  result_code: string; // 'ok' or a stable E_* code
  ts?: number;
}

/** Redaction pattern table. Matches in order; first match wins. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // AWS access keys (AKIA / ASIA prefix, 16-char trailing)
  [/AKIA[0-9A-Z]{16}/g, "[AWS_ACCESS_KEY]"],
  [/ASIA[0-9A-Z]{16}/g, "[AWS_STS_KEY]"],
  // AWS secret-ish things (40-char base64-alike on same line as "secret")
  [/(?<=secret[^\n]*)[A-Za-z0-9/+=]{40}/gi, "[AWS_SECRET]"],
  // JWT
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[JWT]"],
  // PEM private keys
  [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |)PRIVATE KEY-----[\s\S]*?-----END [^-]+-----/g,
    "[PRIVATE_KEY]",
  ],
  // .env-style assignments: KEY="secret" or KEY=secret
  [/\b([A-Z_][A-Z0-9_]{2,})\s*=\s*(["']?)[^\s"'\n]+\2/g, "$1=[REDACTED]"],
];

/**
 * Redact an arbitrary value recursively. Strings are scanned for secret
 * shapes; arrays and objects are walked. Primitives other than string pass
 * through.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function redactString(s: string): string {
  let out = s;
  for (const [pat, replacement] of SECRET_PATTERNS) out = out.replace(pat, replacement);
  return out;
}

/**
 * Hash a redacted, JSON-stringified value. Stable across runs because the
 * JSON is key-sorted first. A null / undefined input hashes to the same
 * deterministic string so audit rows always have a value.
 */
export function hashPayload(value: unknown): string {
  const redacted = redact(value);
  const canonical = stableStringify(redacted);
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map(
          (k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  }
  return "null";
}

// Module-level flag: when true, every writeAudit call also stores the
// redacted JSON of inputs + outputs. Set once at server/CLI startup via
// setFullAuditMode(config.audit.full_payload_storage). Off by default so
// behavior matches the MVP "hashes only" contract unless the user opts
// in.
let FULL_AUDIT_MODE = false;

export function setFullAuditMode(enabled: boolean): void {
  FULL_AUDIT_MODE = enabled;
}

export function isFullAuditMode(): boolean {
  return FULL_AUDIT_MODE;
}

function canonicalRedactedJson(value: unknown): string {
  return stableStringify(redact(value));
}

/**
 * Append a single audit row. Called by every tool handler immediately after
 * the envelope has been produced.
 */
export function writeAudit(db: DatabaseType, entry: AuditEntryInput): void {
  const stmt = db.prepare(
    `INSERT INTO audit
       (ts, tool, scope, project_root, client_id, inputs_hash, outputs_hash, endpoint, result_code, inputs_json, outputs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    entry.ts ?? Date.now(),
    entry.tool,
    entry.scope,
    entry.project_root ?? null,
    entry.client_id ?? null,
    hashPayload(entry.inputs),
    hashPayload(entry.outputs),
    entry.endpoint ?? null,
    entry.result_code,
    FULL_AUDIT_MODE ? canonicalRedactedJson(entry.inputs) : null,
    FULL_AUDIT_MODE ? canonicalRedactedJson(entry.outputs) : null,
  );
  // Cross-project registry hook: bump last_seen_at for the current
  // project. No-op if the project isn't registered (silent — the
  // registry is opt-in). Wrapped to never throw into the tool path.
  if (entry.project_root) {
    try {
      touchProject(db, entry.project_root);
    } catch {
      /* non-fatal */
    }
  }
}
