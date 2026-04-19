---
name: reindex
description: Rebuild the project's SQLite artifact index via `vcf reindex`. Triggers on "reindex", "rebuild the index", "/reindex".
---

# Reindex

Refresh `project.db.artifacts` after hand-edits to files under `plans/`, `memory/`, or `docs/`.

## When to use

- User invokes `/reindex`.
- After a manual edit outside the MCP tool surface (e.g. the user opened plans/ in an editor and rewrote a plan).

## What to do

This is a CLI-only path, not an MCP tool. Tell the user to run:

```
vcf reindex
```

…from the project directory (or `vcf reindex --project <path>`).

## Rules

- This is intentionally CLI-only. Running it as an MCP tool would re-read everything on every LLM call and blow the token budget.
- The operation is idempotent — running it twice produces no diff.
