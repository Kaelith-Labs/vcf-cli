// ship_release — project scope.
//
// Plan/confirm path for cutting a GitHub release. Two-call contract:
//
//   1. First call (no confirm_token): returns a plan — the exact
//      `gh release create` command line, a preview of the release notes,
//      the tag, and a single-use confirm_token with a 60s TTL.
//   2. Second call (confirm_token = <the token from call 1>): actually
//      shells out to `gh release create`. The token is validated with
//      timing-safe comparison, consumed, and refused on reuse.
//
// Destructive: creates a tag on the remote and publishes a release. Pins
// the repo to whatever ref `gh` resolves; the caller is responsible for
// making sure HEAD is clean and pushed.
//
// Non-negotiable: an LLM calling this tool ONCE does not ship anything.
// The plan comes back, the user sees it, the user (or the skill wrapping
// this tool) approves, and only then does the second call execute.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { createConfirmTokenStore, type ConfirmTokenStore } from "../util/confirmToken.js";

// One store per server process — tokens evaporate on restart, which is
// the intended behavior (a new process = new key = invalidate outstanding
// tokens).
let store: ConfirmTokenStore | null = null;
function getStore(): ConfirmTokenStore {
  if (store === null) store = createConfirmTokenStore({ ttlMs: 60_000 });
  return store;
}

const ShipReleaseInput = z
  .object({
    tag: z
      .string()
      .regex(/^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/)
      .describe("semver tag with leading 'v' (e.g. v1.2.3 or v0.0.1-alpha.0)"),
    title: z.string().max(256).optional(),
    notes: z.string().max(20_000).optional(),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
    target: z
      .string()
      .max(128)
      .optional()
      .describe("target branch or full commit SHA (default: remote HEAD)"),
    generate_notes: z
      .boolean()
      .default(true)
      .describe("ask gh to auto-generate notes from commits since last tag"),
    confirm_token: z
      .string()
      .optional()
      .describe("token returned by the prior plan call; omit to request a new plan"),
    expand: z.boolean().default(true),
  })
  .strict();

type Args = z.infer<typeof ShipReleaseInput>;

export function registerShipRelease(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "ship_release",
    {
      title: "Cut a GitHub Release (plan/confirm)",
      description:
        "Plan or execute `gh release create`. Call once without confirm_token to receive the exact command + single-use token (60s TTL). Call again with the token to execute. The server refuses to run twice on the same token and refuses a mismatched input payload.",
      inputSchema: ShipReleaseInput.shape,
    },
    async (args: Args) => {
      return runTool(async () => {
        if (!deps.projectDb) {
          throw new McpError("E_STATE_INVALID", "ship_release requires project scope");
        }
        const parsed = ShipReleaseInput.parse(args);
        const projectRoot = readProjectRoot(deps);
        if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

        // The plan payload the confirm_token binds to. We strip confirm_token
        // + expand so the user can toggle verbosity / pass the token back
        // without invalidating the plan.
        const planPayload = {
          tag: parsed.tag,
          title: parsed.title ?? null,
          notes: parsed.notes ?? null,
          draft: parsed.draft,
          prerelease: parsed.prerelease,
          target: parsed.target ?? null,
          generate_notes: parsed.generate_notes,
          project_root: projectRoot,
        };
        const cmd = buildGhArgs(parsed, projectRoot);

        // Plan-only call.
        if (parsed.confirm_token === undefined) {
          const token = getStore().issue(planPayload);
          const payload = success<unknown>(
            [projectRoot],
            `ship_release plan: \`gh release create ${cmd.args.join(" ")}\` in ${projectRoot}. Single-use confirm_token issued (TTL 60s).`,
            parsed.expand
              ? {
                  content: {
                    plan: planPayload,
                    command: { name: "gh", args: cmd.args, cwd: projectRoot },
                    confirm_token: token,
                    notes_source: parsed.generate_notes
                      ? "gh --generate-notes"
                      : parsed.notes
                        ? "caller-provided"
                        : "(empty)",
                  },
                }
              : {
                  expand_hint:
                    "Call ship_release with expand=true to receive the exact command + confirm_token.",
                },
          );
          try {
            writeAudit(deps.globalDb, {
              tool: "ship_release",
              scope: "project",
              project_root: projectRoot,
              inputs: { ...parsed, confirm_token: null },
              outputs: { ...payload, content: { ...planPayload, confirm_token: "<redacted>" } },
              result_code: "ok",
            });
          } catch {
            /* non-fatal */
          }
          return payload;
        }

        // Confirm call — validate the token or refuse.
        try {
          getStore().consume(parsed.confirm_token, planPayload);
        } catch (err) {
          throw err instanceof McpError
            ? err
            : new McpError("E_CONFIRM_REQUIRED", (err as Error).message);
        }

        // Execute.
        const result = await new Promise<{
          exit_code: number | null;
          stdout_tail: string;
          stderr_tail: string;
          duration_ms: number;
        }>((resolve) => {
          const startedAt = Date.now();
          let stdoutBuf = "";
          let stderrBuf = "";
          const child = spawn(cmd.command, cmd.args, {
            cwd: projectRoot,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const TAIL = 16 * 1024;
          child.stdout.on("data", (c: Buffer) => {
            stdoutBuf += c.toString("utf8");
            if (stdoutBuf.length > TAIL) stdoutBuf = stdoutBuf.slice(stdoutBuf.length - TAIL);
          });
          child.stderr.on("data", (c: Buffer) => {
            stderrBuf += c.toString("utf8");
            if (stderrBuf.length > TAIL) stderrBuf = stderrBuf.slice(stderrBuf.length - TAIL);
          });
          child.on("error", (err) => {
            stderrBuf += `\n[spawn error] ${(err as Error).message}\n`;
            resolve({
              exit_code: null,
              stdout_tail: stdoutBuf,
              stderr_tail: stderrBuf,
              duration_ms: Date.now() - startedAt,
            });
          });
          child.on("close", (code) => {
            resolve({
              exit_code: code,
              stdout_tail: stdoutBuf,
              stderr_tail: stderrBuf,
              duration_ms: Date.now() - startedAt,
            });
          });
        });

        const passed = result.exit_code === 0;
        const summary = passed
          ? `ship_release: ${parsed.tag} created (${result.duration_ms}ms).`
          : `ship_release: gh exited ${result.exit_code ?? "null"} — release NOT created.`;

        // Record as a build row so portfolio_status picks it up.
        deps.projectDb
          .prepare(
            `INSERT INTO builds (target, started_at, finished_at, status, output_path)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            `ship_release:${parsed.tag}`,
            Date.now() - result.duration_ms,
            Date.now(),
            passed ? "success" : "failed",
            null,
          );

        const payload = success<unknown>(
          [projectRoot],
          summary,
          parsed.expand ? { content: result } : {},
        );
        try {
          writeAudit(deps.globalDb, {
            tool: "ship_release",
            scope: "project",
            project_root: projectRoot,
            inputs: { ...parsed, confirm_token: "<consumed>" },
            outputs: {
              ...payload,
              content: { ...result, stdout_tail: "<redacted>", stderr_tail: "<redacted>" },
            },
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

function buildGhArgs(parsed: Args, _projectRoot: string): { command: "gh"; args: string[] } {
  const args: string[] = ["release", "create", parsed.tag];
  if (parsed.title !== undefined) args.push("--title", parsed.title);
  if (parsed.notes !== undefined) args.push("--notes", parsed.notes);
  if (parsed.draft) args.push("--draft");
  if (parsed.prerelease) args.push("--prerelease");
  if (parsed.target !== undefined) args.push("--target", parsed.target);
  if (parsed.generate_notes && parsed.notes === undefined) args.push("--generate-notes");
  return { command: "gh", args };
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

/** Test-only: reset the in-memory token store. */
export function __resetShipReleaseStoreForTests(): void {
  store = null;
}
