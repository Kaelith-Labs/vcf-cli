// Regression test for the silent-exit bug hit during the 2026-04-20 Mac
// smoke run:
//
//   Homebrew, Scoop, and npm all install `vcf` as a symlink into a
//   versioned Cellar / shim dir. When the CLI's "am I the entrypoint"
//   guard compared `pathToFileURL(process.argv[1])` against
//   `import.meta.url`, argv[1] was the symlink path while import.meta.url
//   was the real target — the URLs never matched, `parseAsync` never
//   ran, and `vcf version` exited 0 with no output.
//
// The fix canonicalizes argv[1] through `realpathSync` before comparing.
// This test spawns the built dist/cli.js via a temporary symlink and
// asserts the entrypoint guard actually fires by checking for real stdout
// output from `vcf version`.

import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

describe("CLI entrypoint guard survives symlink invocation", () => {
  const distCli = resolve(__dirname, "..", "..", "dist", "cli.js");

  beforeAll(async () => {
    // This test needs the compiled artifact — `npm run build` produces it.
    // CI builds before running tests; locally, skip with a clear error if
    // dist/cli.js is missing.
    if (!existsSync(distCli)) {
      throw new Error(`dist/cli.js not found at ${distCli}. Run \`npm run build\` first.`);
    }
  });

  it("vcf version prints the version string when invoked via a symlink", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vcf-symlink-"));
    const linked = join(scratch, "vcf");
    try {
      await symlink(distCli, linked);
      await access(linked);
      // We invoke node explicitly so the test works regardless of whether
      // the script's shebang points at a usable node on the test host.
      const { stdout } = await run(process.execPath, [linked, "version"], {
        timeout: 10_000,
      });
      // The real bug: stdout was empty. A passing run prints at least the
      // `vcf-cli <semver>` line.
      expect(stdout).toMatch(/^vcf-cli \d+\.\d+\.\d+/);
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  });

  it("vcf version also works when invoked directly at the realpath", async () => {
    // Baseline — direct invocation should still work after the realpath
    // change.
    const { stdout } = await run(process.execPath, [distCli, "version"], {
      timeout: 10_000,
    });
    expect(stdout).toMatch(/^vcf-cli \d+\.\d+\.\d+/);
  });
});
