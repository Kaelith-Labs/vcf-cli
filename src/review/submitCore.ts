// Shared review-submission persistence.
//
// Both `review_submit` (client-LLM wrote the verdict) and `review_execute`
// (server-side LLM wrote the verdict) end in the same persistence step:
// render a report markdown, write it to plans/reviews/<type>/, update the
// review_runs row, and persist the merged carry-forward. This module is the
// one place that logic lives.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { isoCompactNow } from "../util/ids.js";
import { McpError } from "../errors.js";
import {
  CARRY_FORWARD_SECTIONS,
  type CarryForward,
  type CarryForwardSection,
  emptyCarryForward,
  mergeCarryForward,
  renderYaml,
} from "./carryForward.js";

export const VERDICTS = ["PASS", "NEEDS_WORK", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type Severity = "info" | "warning" | "blocker";

export interface Finding {
  file?: string | undefined;
  line?: number | undefined;
  severity: Severity;
  description: string;
  required_change?: string | undefined;
}

export interface CarryForwardEntryInput {
  section: CarryForwardSection;
  severity: Severity;
  text: string;
}

export interface Submission {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  carry_forward: CarryForwardEntryInput[];
}

export interface ReviewRunRow {
  id: string;
  type: string;
  stage: number;
  status: string;
  carry_forward_json: string;
}

export interface PersistArgs {
  projectDb: DatabaseType;
  allowedRoots: readonly string[];
  projectRoot: string;
  run: ReviewRunRow;
  submission: Submission;
}

export interface PersistResult {
  reportPath: string;
  merged: CarryForward;
  now: number;
}

export async function persistReviewSubmission(args: PersistArgs): Promise<PersistResult> {
  const { projectDb, allowedRoots, projectRoot, run, submission } = args;

  if (run.status !== "pending" && run.status !== "running") {
    throw new McpError("E_STATE_INVALID", `review run "${run.id}" is ${run.status}; cannot submit`);
  }

  const prior = parseCarryForward(run.carry_forward_json);
  const next = groupCarryForward(submission.carry_forward, run.stage);
  const merged = mergeCarryForward(prior, next);

  const reportsDir = join(projectRoot, "plans", "reviews", run.type);
  await assertInsideAllowedRoot(reportsDir, allowedRoots);
  await mkdir(reportsDir, { recursive: true });
  const now = Date.now();
  const ts = isoCompactNow(new Date(now));
  const reportPath = join(reportsDir, `stage-${run.stage}-${ts}.md`);
  await writeFile(reportPath, renderReport(run, submission, merged), "utf8");

  const runWorkspace = join(projectRoot, ".review-runs", run.id);
  if (existsSync(runWorkspace)) {
    await writeFile(join(runWorkspace, "carry-forward.yaml"), renderYaml(merged), "utf8");
  }

  projectDb
    .prepare(
      `UPDATE review_runs
       SET status = 'submitted',
           verdict = ?,
           finished_at = ?,
           report_path = ?,
           carry_forward_json = ?
       WHERE id = ?`,
    )
    .run(submission.verdict, now, reportPath, JSON.stringify(merged), run.id);

  projectDb.prepare("UPDATE project SET updated_at = ? WHERE id = 1").run(now);

  return { reportPath, merged, now };
}

// ---- helpers ---------------------------------------------------------------

export function parseCarryForward(raw: string): CarryForward {
  try {
    const parsed = JSON.parse(raw) as Partial<CarryForward>;
    return {
      architecture: parsed.architecture ?? [],
      verification: parsed.verification ?? [],
      security: parsed.security ?? [],
      compliance: parsed.compliance ?? [],
      supportability: parsed.supportability ?? [],
      release_confidence: parsed.release_confidence ?? [],
    };
  } catch {
    return emptyCarryForward();
  }
}

function groupCarryForward(
  entries: CarryForwardEntryInput[],
  stage: number,
): Partial<CarryForward> {
  const out: Partial<CarryForward> = {};
  for (const e of entries) {
    if (!out[e.section]) out[e.section] = [];
    out[e.section]!.push({ stage, severity: e.severity, text: e.text });
  }
  return out;
}

export function renderReport(
  run: { id: string; type: string; stage: number },
  submit: Submission,
  cf: CarryForward,
): string {
  const parts: string[] = [];
  parts.push("---");
  parts.push(`type: review-report`);
  parts.push(`review_type: ${run.type}`);
  parts.push(`stage: ${run.stage}`);
  parts.push(`verdict: ${submit.verdict}`);
  parts.push(`run_id: ${run.id}`);
  parts.push(`created_at: ${new Date().toISOString()}`);
  parts.push("---");
  parts.push("");
  parts.push(`# ${run.type} — Stage ${run.stage} — ${submit.verdict}`);
  parts.push("");
  parts.push("## Summary");
  parts.push("");
  parts.push(submit.summary.trim());
  parts.push("");
  if (submit.findings.length > 0) {
    parts.push("## Findings");
    parts.push("");
    for (const f of submit.findings) {
      const loc = f.file
        ? `${f.file}${f.line !== undefined ? ":" + f.line : ""}`
        : "_location unspecified_";
      parts.push(`- **${f.severity}** — \`${loc}\` — ${f.description.trim()}`);
      if (f.required_change) parts.push(`  - required: ${f.required_change.trim()}`);
    }
    parts.push("");
  }
  parts.push("## Carry-forward");
  parts.push("");
  for (const section of CARRY_FORWARD_SECTIONS) {
    parts.push(`### ${section}`);
    parts.push("");
    if (cf[section].length === 0) {
      parts.push("_none_");
    } else {
      for (const e of cf[section]) {
        parts.push(`- (stage ${e.stage}, ${e.severity}) ${e.text.trim()}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n") + "\n";
}
