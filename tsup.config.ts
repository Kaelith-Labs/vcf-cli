import { defineConfig } from "tsup";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    server: "src/server.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Post-build: restore the `node:` prefix on built-in imports that have no
  // bare alias (`sqlite`, `test`, `sea`). tsup strips the prefix during its
  // resolve pass even though the underlying esbuild preserves it correctly
  // when invoked directly — it's a known tsup limitation that `external:`
  // and `esbuildOptions.packages: "external"` do NOT route around:
  //   - https://github.com/egoist/tsup/issues/417   (tracking issue)
  //   - https://github.com/evanw/esbuild/issues/3821  (upstream)
  //   - https://github.com/remix-run/remix/issues/5954  (same class)
  // This post-build sed is the community-standard workaround. The regex
  // covers every built-in that lacks a bare alias so adding a new
  // `node:test` / `node:sea` import later doesn't silently break.
  async onSuccess() {
    const PREFIXLESS = ["sqlite", "test", "sea"].join("|");
    const re = new RegExp(`from ['"](${PREFIXLESS})['"]`, "g");
    const distDir = "dist";
    for (const name of await readdir(distDir)) {
      if (!name.endsWith(".js")) continue;
      const path = join(distDir, name);
      const src = await readFile(path, "utf8");
      const patched = src.replace(re, (_, m) => `from "node:${m}"`);
      if (patched !== src) await writeFile(path, patched, "utf8");
    }
  },
});
