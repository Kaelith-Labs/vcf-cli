// test_analyze — project scope.
//
// Turn a captured test run (stdout/stderr + exit code) into a summary the
// LLM can reason about. The summary is lossy by design — token economy
// ruling: we surface the first N distinct failure lines plus counts, not
// the whole stream.
//
// Pattern-matching is runner-agnostic. We search for a handful of well-
// known failure signatures (pytest FAILED, vitest × marker, jest FAIL,
// Go FAIL, Rust FAILED, k6 checks failed). Anything else falls back to
// "terminal exit_code != 0" reporting with the tail preserved.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const TestAnalyzeInput = z
  .object({
    stdout: z.string().max(512_000).default(""),
    stderr: z.string().max(512_000).default(""),
    exit_code: z.number().int().nullable().default(null),
    max_failures: z.number().int().min(1).max(100).default(10),
    expand: z.boolean().default(true),
  })
  .strict();

interface AnalyzeResult {
  passed: boolean;
  failure_count: number;
  reported: Array<{ runner: string; line: string }>;
  suspected_runner: string;
  note: string | null;
}

const PATTERNS: Array<{ runner: string; regex: RegExp }> = [
  { runner: "pytest", regex: /^FAILED\s+(.+)$/gm },
  { runner: "pytest", regex: /^E\s+(.+Error.+)$/gm },
  { runner: "vitest", regex: /^\s+×\s+(.+)$/gm },
  { runner: "jest", regex: /^\s+●\s+(.+)$/gm },
  { runner: "go", regex: /^--- FAIL:\s+(.+)$/gm },
  { runner: "cargo", regex: /^test\s+(\S+)\s+\.\.\.\s+FAILED$/gm },
  { runner: "mocha", regex: /^\s+\d+\)\s+(.+)$/gm },
  { runner: "k6", regex: /^.*✗\s+(.+)$/gm },
];

export function registerTestAnalyze(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_analyze",
    {
      title: "Analyze Test Output",
      description:
        "Summarize a captured test run. Detects well-known runner failure signatures (pytest/vitest/jest/go/cargo/k6/mocha); returns the first `max_failures` distinct failure lines. Lossy by design — tail is in test_execute's output.",
      inputSchema: TestAnalyzeInput.shape,
    },
    async (args: z.infer<typeof TestAnalyzeInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "test_analyze requires project scope");
        }
        const parsed = TestAnalyzeInput.parse(args);
        const combined = `${parsed.stdout}\n${parsed.stderr}`;
        const matches: Array<{ runner: string; line: string }> = [];
        const seen = new Set<string>();
        let suspected = "unknown";
        for (const { runner, regex } of PATTERNS) {
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(combined)) !== null) {
            const line = (m[1] ?? "").trim();
            if (line.length === 0 || seen.has(line)) continue;
            seen.add(line);
            matches.push({ runner, line });
            if (suspected === "unknown") suspected = runner;
            if (matches.length >= parsed.max_failures) break;
          }
          if (matches.length >= parsed.max_failures) break;
        }

        const passed = parsed.exit_code === 0 && matches.length === 0;
        const note =
          !passed && matches.length === 0
            ? "No known failure signature matched; inspect the raw tail from test_execute."
            : null;

        const result: AnalyzeResult = {
          passed,
          failure_count: matches.length,
          reported: matches,
          suspected_runner: suspected,
          note,
        };

        const payload = success(
          [],
          passed
            ? `Tests passed (exit=${parsed.exit_code}, 0 failure signatures).`
            : `Tests failed: ${matches.length} reported, exit=${parsed.exit_code ?? "?"}${
                note ? "; " + note : ""
              }.`,
          parsed.expand
            ? { content: result }
            : { expand_hint: "Call test_analyze with expand=true for the failure list." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "test_analyze",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: {
              ...parsed,
              stdout: `<${parsed.stdout.length}B>`,
              stderr: `<${parsed.stderr.length}B>`,
            },
            outputs: payload,
            result_code: "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
