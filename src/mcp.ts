// `vcf-mcp` binary entry — M0 stub.
//
// The real transport wiring (stdio) and `createServer({ scope })` call live in
// M2. Scope auto-detection + exit codes land there too. This stub lets the
// package expose a working `bin` so `.mcp.json` wiring can be tested end-to-end
// from M0 CI without the full surface.
import { Command } from "commander";
import { describeServer, type Scope } from "./server.js";
import { VERSION } from "./version.js";

const program = new Command();
program
  .name("vcf-mcp")
  .description("Vibe Coding Framework MCP server entry.")
  .version(VERSION)
  .requiredOption(
    "--scope <scope>",
    "launch scope: global (idea/spec/catalog) or project (full lifecycle)",
  )
  .action((opts: { scope: string }) => {
    if (opts.scope !== "global" && opts.scope !== "project") {
      process.stderr.write(
        `vcf-mcp: --scope must be "global" or "project" (got "${opts.scope}")\n`,
      );
      process.exit(2);
    }
    const info = describeServer(opts.scope as Scope);
    // M0: no transport yet — print a one-line JSON banner to stderr so the
    // user can confirm the binary is wired. Stdout is reserved for JSON-RPC
    // from M2 onwards and must remain silent here.
    process.stderr.write(`${JSON.stringify({ level: "info", msg: "vcf-mcp starting", info })}\n`);
    // No server loop yet — exit cleanly so CI smoke tests don't hang.
    process.exit(0);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`vcf-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
