import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    server: "src/server.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  shims: false,
  // Keep native modules external so users get the prebuilt binaries at install time.
  external: ["better-sqlite3"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
