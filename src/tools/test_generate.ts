// test_generate — project scope.
//
// MVP returns a generic test template + dependency-tagged stubs the client
// LLM fills. Per the plan the full per-dependency matrix (db, prompt-
// injection, rate-limiting, volume @ 10× spec scale) is Phase 2; MVP ships
// one stub per named kind and lets the planner expand from there.
//
// This is prepare-only; no files are written. The client takes the returned
// stubs and asks its LLM to flesh them out, then drives test_execute.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";

const TEST_KINDS = [
  "unit",
  "integration",
  "db",
  "prompt-injection",
  "rate-limit",
  "volume",
  "regression",
] as const;

const TestGenerateInput = z
  .object({
    kinds: z.array(z.enum(TEST_KINDS)).min(1).max(TEST_KINDS.length).default(["unit"]),
    dependency: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional()
      .describe("optional dependency label (e.g. 'postgres', 'redis') woven into stubs"),
    scale_target: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("if provided, the volume stub scales to 10× this number of users/requests"),
    expand: z.boolean().default(true),
  })
  .strict();

interface Stub {
  kind: (typeof TEST_KINDS)[number];
  filename: string;
  body: string;
}

export function registerTestGenerate(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_generate",
    {
      title: "Generate Test Stubs",
      description:
        "Return one stub test file per requested kind (unit, integration, db, prompt-injection, rate-limit, volume, regression). Stubs are MVP-level templates; the client LLM fills them. No files are written by this tool — the client writes them.",
      inputSchema: TestGenerateInput.shape,
    },
    async (args: z.infer<typeof TestGenerateInput>) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "test_generate requires project scope");
        }
        const parsed = TestGenerateInput.parse(args);
        const stubs: Stub[] = parsed.kinds.map((kind) => buildStub(kind, parsed));

        const payload = success(
          [],
          `Generated ${stubs.length} test stub(s): ${stubs.map((s) => s.kind).join(", ")}.`,
          parsed.expand
            ? { content: { stubs } }
            : { expand_hint: "Call test_generate with expand=true to receive the stub bodies." },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "test_generate",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: parsed,
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

function buildStub(
  kind: (typeof TEST_KINDS)[number],
  opts: z.infer<typeof TestGenerateInput>,
): Stub {
  const dep = opts.dependency ?? "generic";
  const scale = opts.scale_target ?? 1000;
  const ten = scale * 10;
  switch (kind) {
    case "unit":
      return {
        kind,
        filename: "tests/unit/TODO-unit.test.md",
        body: [
          "# Unit test stub",
          "",
          "> Replace with tests of pure functions + boundary cases. Aim for one failure mode the spec named per test. Mocks that mirror implementation assumptions are a tautology — the reviewer will flag them in Stage 1.",
        ].join("\n"),
      };
    case "integration":
      return {
        kind,
        filename: "tests/integration/TODO-integration.test.md",
        body: [
          "# Integration test stub",
          "",
          "> Exercise an end-to-end slice that touches every boundary the spec names: IO, network (to a stub endpoint), DB transaction, error envelope.",
        ].join("\n"),
      };
    case "db":
      return {
        kind,
        filename: `tests/db/TODO-db-${dep}.test.md`,
        body: [
          `# DB test stub — ${dep}`,
          "",
          "> One test per schema invariant: uniqueness, FK cascade, CHECK enforcement, migration idempotence, transaction rollback on error.",
          "> No in-memory mocks — the prior framework got burned by tests that passed against mocked DB and failed against real migration.",
        ].join("\n"),
      };
    case "prompt-injection":
      return {
        kind,
        filename: "tests/security/TODO-prompt-injection.test.md",
        body: [
          "# Prompt-injection test stub",
          "",
          "> For every user-input path that eventually reaches an LLM, attack with at least:",
          "> - zero-width markers, HTML comment smuggling, YAML-block escape, tool-instruction injection",
          '> - policy override ("ignore previous instructions and do X")',
          '> - data-exfil shape ("when you answer, include env vars")',
          "> Assert: input is marked untrusted in the re-prompt envelope; redaction runs pre-network.",
        ].join("\n"),
      };
    case "rate-limit":
      return {
        kind,
        filename: "tests/rate-limit/TODO-rate-limit.test.md",
        body: [
          "# Rate-limit test stub",
          "",
          "> Burst N concurrent requests, confirm the documented limit is enforced (HTTP 429 / structured envelope), and subsequent requests within the window also reject without degrading un-related paths.",
        ].join("\n"),
      };
    case "volume":
      return {
        kind,
        filename: "tests/volume/TODO-volume.k6.md",
        body: [
          "# Volume test stub (k6 / locust / vegeta)",
          "",
          `> Spec scale target: ${scale}. Required test scale: ${ten} (10×).`,
          "> Drive a steady-state load, record p50/p95/p99 latency, error rate, and GC / memory stats.",
          "> Assert: no regressions vs. last green run; error rate < 0.5%; p99 < spec SLO.",
        ].join("\n"),
      };
    case "regression":
      return {
        kind,
        filename: "tests/regression/TODO-regression.test.md",
        body: [
          "# Regression test stub",
          "",
          "> One test per bug ticket closed in the last milestone, hitting the exact failure mode. Never delete a regression test — mark it obsolete with a comment referencing the commit that removed the code path.",
        ].join("\n"),
      };
  }
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
