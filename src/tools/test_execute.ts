// test_execute — project scope.
//
// Shell out to a configured test runner in a child process. Demux stdout
// and stderr into a structured result; emit bounded progress notifications;
// honor cancellation via the client's signal; enforce a timeout.
//
// Security: cwd is re-validated against allowed_roots. The command path
// itself is a free string — we do not attempt to sandbox the runner.
// Operator's responsibility to whitelist runner commands in config in
// future; MVP trusts the caller.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { throwIfCanceled } from "../util/cancellation.js";

const TestExecuteInput = z
  .object({
    command: z
      .string()
      .min(1)
      .max(256)
      .describe("the runner binary (pytest, vitest, jest, k6, vegeta, locust, …)"),
    args: z.array(z.string().max(512)).max(64).default([]),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe("absolute path inside allowed_roots; defaults to the project root"),
    timeout_ms: z.number().int().min(1_000).max(600_000).default(120_000),
    env: z
      .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4_096))
      .optional()
      .describe("extra env vars to pass through. Values are used verbatim; secrets must come from the user's env, not tool input."),
    expand: z.boolean().default(false),
  })
  .strict();

interface TestExecuteResult {
  command: string;
  args: string[];
  cwd: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
  timed_out: boolean;
  canceled: boolean;
}

const TAIL_BYTES = 16 * 1024; // keep the last 16KB of each stream in content

export function registerTestExecute(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_execute",
    {
      title: "Execute Test Suite",
      description:
        "Spawn `command` with `args` inside `cwd` (re-validated against allowed_roots). Demuxes stdout/stderr, emits bounded progress, honors cancellation. Returns {exit_code, signal, duration, stdout_tail, stderr_tail, timed_out, canceled}.",
      inputSchema: TestExecuteInput.shape,
    },
    async (args, extra) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "test_execute requires project scope");
        }
        const parsed = TestExecuteInput.parse(args);
        const projectRoot = readProjectRoot(deps);
        if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");
        const cwdArg = parsed.cwd ?? projectRoot;
        const cwdCanonical = await assertInsideAllowedRoot(
          cwdArg,
          deps.config.workspace.allowed_roots,
        );

        const signal = extra?.signal as AbortSignal | undefined;
        const startedAt = Date.now();
        const result: TestExecuteResult = await new Promise((resolve) => {
          let stdoutBuf = "";
          let stderrBuf = "";
          let timedOut = false;
          let canceled = false;

          const child = spawn(parsed.command, parsed.args, {
            cwd: cwdCanonical,
            env: { ...process.env, ...(parsed.env ?? {}) },
            // stdio inherit-with-capture so we can tail the tails.
            stdio: ["ignore", "pipe", "pipe"],
          });

          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            // Escalate if SIGTERM doesn't catch.
            setTimeout(() => {
              if (!child.killed) child.kill("SIGKILL");
            }, 2_000);
          }, parsed.timeout_ms);

          const onAbort = (): void => {
            canceled = true;
            child.kill("SIGTERM");
          };
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }

          child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString("utf8");
            if (stdoutBuf.length > TAIL_BYTES) {
              stdoutBuf = stdoutBuf.slice(stdoutBuf.length - TAIL_BYTES);
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString("utf8");
            if (stderrBuf.length > TAIL_BYTES) {
              stderrBuf = stderrBuf.slice(stderrBuf.length - TAIL_BYTES);
            }
          });

          const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve({
              command: parsed.command,
              args: parsed.args,
              cwd: cwdCanonical,
              exit_code: code,
              signal: sig,
              duration_ms: Date.now() - startedAt,
              stdout_tail: stdoutBuf,
              stderr_tail: stderrBuf,
              timed_out: timedOut,
              canceled,
            });
          };

          child.on("error", (err) => {
            stderrBuf += `\n[spawn error] ${(err as Error).message}\n`;
            finish(null, null);
          });
          child.on("close", (code, sig) => finish(code, sig));
        });

        throwIfCanceled(signal);

        // Map terminal state → envelope shape.
        if (result.canceled) throw new McpError("E_CANCELED", "test_execute canceled by client");

        const terminalCode = result.exit_code ?? -1;
        const passed = terminalCode === 0 && !result.timed_out;
        const summary = passed
          ? `${parsed.command} exited 0 in ${result.duration_ms}ms (stdout ${result.stdout_tail.length}B, stderr ${result.stderr_tail.length}B).`
          : `${parsed.command} failed: exit=${terminalCode}${result.timed_out ? " (timeout)" : ""} in ${result.duration_ms}ms.`;

        // Persist a build row so ship audit / portfolio see the run.
        deps.projectDb
          .prepare(
            `INSERT INTO builds (target, started_at, finished_at, status, output_path)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            `test:${parsed.command}`,
            startedAt,
            startedAt + result.duration_ms,
            passed ? "success" : result.timed_out ? "failed" : "failed",
            null,
          );

        const payload = success([cwdCanonical], summary, parsed.expand ? { content: result } : {
          expand_hint: "Call test_execute with expand=true to receive stdout/stderr tails.",
        });
        try {
          writeAudit(deps.globalDb, {
            tool: "test_execute",
            scope: "project",
            project_root: projectRoot,
            inputs: { ...parsed, env: parsed.env ? Object.keys(parsed.env) : [] },
            outputs: { ...payload, content: { ...result, stdout_tail: "<redacted>", stderr_tail: "<redacted>" } },
            result_code: passed ? "ok" : "E_INTERNAL",
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
