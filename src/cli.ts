// `vcf` CLI entry — M0 stub.
//
// The maintenance surface (vcf init / reindex / verify / register-endpoint /
// stale-check / update-primers / admin audit) is implemented milestone by
// milestone starting in M3 (init) and finalized in M10. Today it just reports
// its version so the binary install path can be verified end-to-end.
import { Command } from "commander";
import { VERSION } from "./version.js";

const program = new Command();
program
  .name("vcf")
  .description("Vibe Coding Framework CLI — maintenance surface for the VCF-MCP server.")
  .version(VERSION);

program
  .command("version")
  .description("Print the installed vcf version.")
  .action(() => {
    // Logger/audit wiring lands in M1 + M2. For now, stderr keeps the CLI
    // safe to run inside the same process tree as the MCP stdio transport.
    process.stderr.write(`vcf ${VERSION}\n`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`vcf: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
