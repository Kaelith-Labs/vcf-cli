// Test-only tracked-DB openers + an afterEach hook that closes every
// DB opened during a test.
//
// Why this exists: better-sqlite3 holds an OS-level lock on the `.db`,
// `-wal`, and `-shm` files while the connection is open. On Linux and
// macOS an unlink still succeeds (the inode hangs around until the last
// handle closes). On Windows, unlink *blocks* indefinitely. Tests that
// use `mkdtemp` + `rm(..., { recursive: true, force: true })` in
// afterEach therefore hang or throw EBUSY unless every opened DB has
// been explicitly closed first.
//
// Usage:
//   import { openGlobalDb, openProjectDb } from "../helpers/db-cleanup.js";
//   // ...use identically to the src/db/* openers.
// The afterEach below runs automatically once this module is imported
// by any test file — the Set is file-scoped because vitest re-runs
// setup code per test file under singleFork.

import { afterEach } from "vitest";
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

afterEach(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed or errored; ignore — the rm retry is the backstop.
    }
  }
  opened.clear();
});
