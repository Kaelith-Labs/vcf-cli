// ship_build — project scope.
//
// Shell out to a configured packager (npm publish / goreleaser /
// electron-builder / pkg / custom) for each requested target. Same
// subprocess discipline as test_execute: demux stdout/stderr tails,
// honor cancellation, enforce per-target timeout, record a `builds`
// row per target.
//
// Per spec §11 and plan: ship_build orchestrates packagers, never
// reinvents them. The caller names a runner command on each target.
// ship_release (auto tag / GitHub release) is deferred to Phase 2.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { assertInsideAllowedRoot } from "../util/paths.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { throwIfCanceled } from "../util/cancellation.js";

const TargetSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .min(1)
      .max(64)
      .describe("target label — used in the audit + builds rows"),
    command: z.string().min(1).max(256),
    args: z.array(z.string().max(512)).max(64).default([]),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4_096)).optional(),
    timeout_ms: z.number().int().min(1_000).max(1_800_000).default(600_000),
  })
  .strict();

const ShipBuildInput = z
  .object({
    targets: z.array(TargetSchema).min(1).max(8),
    stop_on_first_failure: z.boolean().default(true),
    expand: z.boolean().default(true),
  })
  .strict();

interface TargetResult {
  name: string;
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

const TAIL_BYTES = 16 * 1024;

export function registerShipBuild(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "ship_build",
    {
      title: "Ship Build",
      description:
        "Run a sequence of packaging targets (npm publish, goreleaser, electron-builder, pkg, custom). Per-target command is spawned with cwd inside allowed_roots; progress + cancellation honored; timeouts enforced; stdout/stderr tails returned.",
      inputSchema: ShipBuildInput.shape,
    },
    async (args, extra) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "ship_build requires project scope");
        }
        const parsed = ShipBuildInput.parse(args);
        const projectRoot = readProjectRoot(deps);
        if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");
        const signal = extra?.signal as AbortSignal | undefined;

        const results: TargetResult[] = [];
        let anyFailure = false;

        for (const target of parsed.targets) {
          throwIfCanceled(signal);
          const cwd = await assertInsideAllowedRoot(
            target.cwd ?? projectRoot,
            deps.config.workspace.allowed_roots,
          );
          const startedAt = Date.now();
          const result = await runTarget(target, cwd, signal);
          results.push(result);

          const passed = result.exit_code === 0 && !result.timed_out && !result.canceled;
          deps.projectDb
            .prepare(
              `INSERT INTO builds (target, started_at, finished_at, status, output_path)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              `ship:${target.name}`,
              startedAt,
              startedAt + result.duration_ms,
              passed ? "success" : result.canceled ? "canceled" : "failed",
              null,
            );
          if (result.canceled) {
            throw new McpError("E_CANCELED", `ship_build canceled during target '${target.name}'`);
          }
          if (!passed) {
            anyFailure = true;
            if (parsed.stop_on_first_failure) break;
          }
        }

        const summary = anyFailure
          ? `ship_build FAILED: ${results.filter((r) => r.exit_code !== 0 || r.timed_out).length}/${results.length} target(s) failed.`
          : `ship_build OK: ${results.length} target(s) succeeded.`;
        const payload = success(
          [projectRoot],
          summary,
          parsed.expand
            ? { content: { results, any_failure: anyFailure } }
            : {
                expand_hint: "Call ship_build with expand=true for stdout/stderr tails per target.",
              },
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "ship_build",
            scope: "project",
            project_root: projectRoot,
            inputs: {
              ...parsed,
              targets: parsed.targets.map((t) => ({
                ...t,
                env: t.env ? Object.keys(t.env) : [],
              })),
            },
            outputs: {
              ...payload,
              content: {
                any_failure: anyFailure,
                results: results.map((r) => ({
                  ...r,
                  stdout_tail: "<redacted>",
                  stderr_tail: "<redacted>",
                })),
              },
            },
            result_code: anyFailure ? "E_INTERNAL" : "ok",
          });
        } catch {
          /* non-fatal */
        }
        return payload;
      });
    },
  );
}

function runTarget(
  target: z.infer<typeof TargetSchema>,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<TargetResult> {
  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let canceled = false;
    const startedAt = Date.now();

    const child = spawn(target.command, target.args, {
      cwd,
      env: { ...process.env, ...(target.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000);
    }, target.timeout_ms);

    const onAbort = (): void => {
      canceled = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf8");
      if (stdoutBuf.length > TAIL_BYTES) stdoutBuf = stdoutBuf.slice(stdoutBuf.length - TAIL_BYTES);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf8");
      if (stderrBuf.length > TAIL_BYTES) stderrBuf = stderrBuf.slice(stderrBuf.length - TAIL_BYTES);
    });

    const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        name: target.name,
        command: target.command,
        args: target.args,
        cwd,
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
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}
