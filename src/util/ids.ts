// Shared ID helpers.
//
// `isoCompactNow()` is the single source of truth for filesystem-safe,
// human-readable, monotonic timestamp IDs. Always millisecond resolution:
// two calls in the same second MUST NOT collide, or UNIQUE constraints
// on `review_runs.id` / artifact paths fail with an opaque E_INTERNAL.
//
// Format: YYYYMMDDTHHMMSSmmmZ (20 chars, UTC). Lexicographically sortable.

export function isoCompactNow(d: Date = new Date()): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "$1Z");
}
