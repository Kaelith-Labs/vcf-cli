import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `node:sqlite` isn't in Vite 5's hard-coded built-in list (it
    // predates the Node-builtin sqlite module), so the default resolver
    // tries to bundle it and fails. Tell vitest to treat anything with
    // the `node:` prefix as external so Node's native loader handles it.
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
    // Windows holds exclusive locks on open SQLite files; afterEach
    // cleanup can need several seconds of rm retries before handles
    // release. 30s gives comfortable headroom without masking real hangs.
    hookTimeout: 30_000,
    // node:sqlite locks + the MCP SDK's in-memory transport do not play
    // well with vitest's default worker pool; concurrent workers can
    // wedge on SIGTERM. A single forked process is plenty fast for this
    // surface. Vitest 4 flattened `poolOptions.forks.singleFork` to
    // top-level `maxWorkers: 1, isolate: false` (see migration guide).
    pool: "forks",
    maxWorkers: 1,
    isolate: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
