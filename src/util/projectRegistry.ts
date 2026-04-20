// Cross-project registry — read/write helpers over the global-DB
// `projects` table (migration v3). Used by:
//   - `vcf project register/list/scan/unregister` (CLI)
//   - `project_init` (auto-register on project creation)
//   - `project_list` + `portfolio_graph` MCP tools
//   - `writeAudit` (touch last_seen_at on every project-scope tool call)
//
// Design notes:
//   - Registry is *authoritative* for "what projects exist" only. A
//     project's own `project.db` stays the source of truth for state
//     and metadata; the registry mirrors `state_cache` for fast lookup.
//   - `depends_on` is authored in the project's plan frontmatter and
//     projected here on every `plan_save`.
//   - Unregistering does not delete the project — it only removes the
//     global-DB row.

import type { Database as DatabaseType } from "better-sqlite3";

export interface ProjectRow {
  name: string;
  root_path: string;
  state_cache: string | null;
  depends_on: string[];
  registered_at: number;
  last_seen_at: number;
}

interface DbRow {
  name: string;
  root_path: string;
  state_cache: string | null;
  depends_on_json: string;
  registered_at: number;
  last_seen_at: number;
}

function rowOf(r: DbRow): ProjectRow {
  let deps: string[] = [];
  try {
    const parsed = JSON.parse(r.depends_on_json) as unknown;
    if (Array.isArray(parsed)) deps = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // corrupt JSON — treat as no dependencies rather than failing the query
  }
  return {
    name: r.name,
    root_path: r.root_path,
    state_cache: r.state_cache,
    depends_on: deps,
    registered_at: r.registered_at,
    last_seen_at: r.last_seen_at,
  };
}

/**
 * Insert or update a project row. Keyed by `root_path` — re-registering
 * a project at the same path updates its name (useful after rename).
 * Returns the canonical name stored.
 */
export function upsertProject(
  db: DatabaseType,
  args: { name: string; root_path: string; state?: string | null },
): string {
  const now = Date.now();
  // Manual upsert so we can preserve registered_at on conflict.
  const existing = db
    .prepare("SELECT name FROM projects WHERE root_path = ?")
    .get(args.root_path) as { name: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE projects SET name = ?, state_cache = COALESCE(?, state_cache), last_seen_at = ?
       WHERE root_path = ?`,
    ).run(args.name, args.state ?? null, now, args.root_path);
    return args.name;
  }
  db.prepare(
    `INSERT INTO projects (name, root_path, state_cache, depends_on_json, registered_at, last_seen_at)
     VALUES (?, ?, ?, '[]', ?, ?)`,
  ).run(args.name, args.root_path, args.state ?? null, now, now);
  return args.name;
}

/** Remove a project from the registry by name. Returns true iff a row was dropped. */
export function unregisterProject(db: DatabaseType, name: string): boolean {
  const info = db.prepare("DELETE FROM projects WHERE name = ?").run(name);
  return info.changes > 0;
}

/** List all registered projects, newest-registered first. */
export function listProjects(db: DatabaseType): ProjectRow[] {
  const rows = db
    .prepare(
      "SELECT name, root_path, state_cache, depends_on_json, registered_at, last_seen_at FROM projects ORDER BY registered_at DESC",
    )
    .all() as DbRow[];
  return rows.map(rowOf);
}

/** Get one project by name. */
export function getProjectByName(db: DatabaseType, name: string): ProjectRow | null {
  const row = db
    .prepare(
      "SELECT name, root_path, state_cache, depends_on_json, registered_at, last_seen_at FROM projects WHERE name = ?",
    )
    .get(name) as DbRow | undefined;
  return row ? rowOf(row) : null;
}

/** Get one project by root_path. Returns null if not registered. */
export function getProjectByRoot(db: DatabaseType, root_path: string): ProjectRow | null {
  const row = db
    .prepare(
      "SELECT name, root_path, state_cache, depends_on_json, registered_at, last_seen_at FROM projects WHERE root_path = ?",
    )
    .get(root_path) as DbRow | undefined;
  return row ? rowOf(row) : null;
}

/**
 * Bump `last_seen_at` for a project by its root_path. Called from every
 * project-scope tool call via writeAudit. No-op if the project isn't
 * registered (silent — registration is opt-in).
 */
export function touchProject(db: DatabaseType, root_path: string): void {
  db.prepare("UPDATE projects SET last_seen_at = ? WHERE root_path = ?").run(Date.now(), root_path);
}

/** Update the state_cache mirror for a project. No-op if unregistered. */
export function setProjectState(db: DatabaseType, root_path: string, state: string): void {
  db.prepare("UPDATE projects SET state_cache = ?, last_seen_at = ? WHERE root_path = ?").run(
    state,
    Date.now(),
    root_path,
  );
}

/** Update the depends_on projection for a project. No-op if unregistered. */
export function setProjectDependsOn(
  db: DatabaseType,
  root_path: string,
  depends_on: string[],
): void {
  db.prepare("UPDATE projects SET depends_on_json = ?, last_seen_at = ? WHERE root_path = ?").run(
    JSON.stringify(depends_on),
    Date.now(),
    root_path,
  );
}

/**
 * Given the registry, compute the inverse map: "if project X ships, what
 * else becomes unblocked?". Used by `portfolio_graph`.
 */
export function computeUnblockedIfShips(projects: ProjectRow[]): Record<string, string[]> {
  const byName = new Set(projects.map((p) => p.name));
  const out: Record<string, string[]> = {};
  for (const p of projects) {
    for (const dep of p.depends_on) {
      if (!byName.has(dep)) continue; // dep not in registry — skip edge
      if (!out[dep]) out[dep] = [];
      out[dep].push(p.name);
    }
  }
  // Sort the dependent lists for stable output.
  for (const k of Object.keys(out)) out[k]!.sort();
  return out;
}

/**
 * Active blockers: projects with `depends_on` entries where the blocker
 * is registered and not yet 'shipped'. A blocker not in the registry is
 * ignored (we can't know its state).
 */
export interface Blocker {
  blocked: string;
  blocked_by: string;
  reason: string;
}

export function computeBlockers(projects: ProjectRow[]): Blocker[] {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const out: Blocker[] = [];
  for (const p of projects) {
    for (const dep of p.depends_on) {
      const blocker = byName.get(dep);
      if (!blocker) continue; // unregistered blocker: skip
      if (blocker.state_cache === "shipped") continue; // already unblocked
      out.push({
        blocked: p.name,
        blocked_by: dep,
        reason: blocker.state_cache
          ? `depends_on (${blocker.state_cache})`
          : "depends_on (state unknown)",
      });
    }
  }
  return out;
}
