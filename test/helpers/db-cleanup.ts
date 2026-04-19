// Test-only tracked-DB openers and an explicit close helper.
//
// Why this exists: better-sqlite3 holds an OS-level lock on the `.db`,
// `-wal`, and `-shm` files while the connection is open. On Linux and
// macOS an unlink still succeeds (the inode hangs around until the last
// handle closes). On Windows, unlink *blocks* indefinitely. Tests that
// use `mkdtemp` + `rm(..., { recursive: true, force: true })` in
// afterEach therefore hang or throw EBUSY unless every opened DB has
// been explicitly closed first.
//
// Ordering caveat: vitest runs afterEach hooks innermost-first. A root-
// level afterEach registered by this module fires AFTER the test's own
// describe-scoped afterEach — too late to help. Tests must therefore
// call `closeTrackedDbs()` explicitly at the START of their afterEach,
// before any `rm()` calls.
//
// Usage:
//   import { openGlobalDb, openProjectDb, closeTrackedDbs } from "../helpers/db-cleanup.js";
//   afterEach(async () => {
//     closeTrackedDbs();
//     await rm(tmpRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
//   });

import type { Database as DatabaseType } from "better-sqlite3";
import { openGlobalDb as _openGlobalDb, type OpenGlobalDbOptions } from "../../src/db/global.js";
import {
  openProjectDb as _openProjectDb,
  type OpenProjectDbOptions,
} from "../../src/db/project.js";

const opened: Set<DatabaseType> = new Set();

function track<T extends DatabaseType>(db: T): T {
  opened.add(db);
  return db;
}

export function openGlobalDb(opts: OpenGlobalDbOptions): DatabaseType {
  return track(_openGlobalDb(opts));
}

export function openProjectDb(opts: OpenProjectDbOptions): DatabaseType {
  return track(_openProjectDb(opts));
}

export function closeTrackedDbs(): void {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed or errored; ignore — the rm retry is the backstop.
    }
  }
  opened.clear();
}
