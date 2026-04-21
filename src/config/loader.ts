// Config loader: YAML bytes → ${ENV_VAR} interpolation → Zod parse → frozen.
//
// The loader is the one place in the system that turns a file on disk into a
// validated Config. Every other layer (tools, CLI, server) receives the frozen
// result. This keeps "where did this value come from?" debuggable — if it's in
// the Config object, it passed through here.
//
// Fail-loud policy: on missing env vars we surface the var *name*, never a
// partial value (which could leak secret shape). Unknown YAML keys are
// rejected by the schema's `.strict()`, not swallowed.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

// Loader-local error class. Kept here (rather than flattened into the
// central errors module) so M1 is self-contained and unit-testable without
// pulling the full MCP server surface into a config-only test context.
// The string `code` aligns with the stable E_* enum in src/errors.ts.
export class ConfigError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Replace `${VAR}` references with process.env values. Throws ConfigError
 * with code E_CONFIG_MISSING_ENV (never leaking partial values) on miss.
 *
 * Only called on string leaves — numbers, booleans, and arrays pass through.
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_REF, (_, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new ConfigError("E_CONFIG_MISSING_ENV", `env var "${name}" is not set`, { name });
    }
    return resolved;
  });
}

/**
 * Walk a parsed YAML value and apply `interpolateEnv` to every string leaf.
 * Non-string primitives and mixed structures pass through unchanged.
 */
function interpolateTree(node: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof node === "string") return interpolateEnv(node, env);
  if (Array.isArray(node)) return node.map((n) => interpolateTree(n, env));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolateTree(v, env);
    }
    return out;
  }
  return node;
}

/**
 * Deep-freeze an object so no downstream consumer can mutate config in place.
 * Mutation bugs here would be especially bad because config is re-used across
 * many tool calls and re-reading it per-call is wasteful.
 */
function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

export interface LoadConfigOptions {
  /** Override environment for interpolation (tests use this). */
  env?: NodeJS.ProcessEnv;
  /** Skip env interpolation entirely — used when you want to inspect the raw shape. */
  skipEnvInterpolation?: boolean;
}

/**
 * Load and validate a config.yaml from the given absolute path. Returns a
 * frozen, fully-typed Config. Throws ConfigError on any failure (missing
 * file, invalid YAML, missing env var, schema violation).
 */
export async function loadConfig(path: string, opts: LoadConfigOptions = {}): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError("E_CONFIG_READ", `could not read config at ${path}`, {
      cause: (err as Error)?.message,
    });
  }
  return parseConfig(raw, opts);
}

/**
 * Parse and validate a config.yaml *string*. Extracted from `loadConfig` so
 * tests can round-trip without touching the filesystem.
 */
export function parseConfig(raw: string, opts: LoadConfigOptions = {}): Config {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError("E_CONFIG_PARSE", "config.yaml is not valid YAML", {
      cause: (err as Error)?.message,
    });
  }
  const env = opts.env ?? process.env;
  const interpolated = opts.skipEnvInterpolation ? parsed : interpolateTree(parsed, env);
  const result = ConfigSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError("E_CONFIG_VALIDATION", "config.yaml failed schema validation", {
      issues: result.error.issues,
    });
  }
  return deepFreeze(result.data);
}
