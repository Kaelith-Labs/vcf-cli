# Stability Policy

`@kaelith-labs/cli` is in **alpha** (versions `0.x.y-alpha.z`). Interfaces may change between any two alpha releases. This document describes the long-term stability commitment that will apply **once 1.0 ships**.

## Scope of the promise

The 1.0 stability contract covers three surfaces:

| Surface | Contract |
|---|---|
| **MCP tool surface** — tool names, input schemas, and envelope shape | Additive changes only within a major version. Breaking changes require a major bump. Per-tool behavior matters too: a tool that starts returning a different `code` on the same input is a breaking change. |
| **CLI commands + flags** (`vcf`) | Same rules as MCP tools. New flags are additive; removed flags break. `--format json` outputs are stable within a major. |
| **Config file (`config.yaml`)** | `version:` field at the top. Current schema is `version: 1`. A breaking schema change bumps this number and the loader refuses mismatched versions with a stable error code. |

## Explicitly NOT stable

These can change at any point, even in a patch release:

- Internal module layout under `src/` (anything not re-exported from the package entry).
- Log messages, error message wording (though **error codes** `E_*` are stable).
- The SQLite schema. Migrations handle upgrades automatically; external tools should not read `~/.vcf/vcf.db` directly — use `vcf admin audit` / MCP tools.
- The exact bytes of generated artifacts (review reports, stubs). Structure is stable; cosmetic output may shift.

## Error codes

Codes prefixed `E_` form a stable enum:

| Code | Meaning |
|---|---|
| `E_SCOPE_DENIED` | Path is outside `workspace.allowed_roots`. |
| `E_PATH_NOT_ABSOLUTE` | Path argument isn't absolute. |
| `E_PATH_INVALID` | Path is empty or unparseable. |
| `E_PATH_ENCODED_ESCAPE` | Path contains URL-encoded traversal (`%2e%2e` etc.). |
| `E_SCOPE_EMPTY` | `allowed_roots` is empty. |
| `E_CONFIG_MISSING_ENV` | Config references an env var that isn't set. |
| `E_NOT_FOUND` | Named resource doesn't exist (spec, plan, run_id, …). |
| `E_STATE_INVALID` | Tool called in the wrong scope or against invalid state (e.g. Stage 3 before Stage 2 passed). |
| `E_VALIDATION` | Input violated a runtime rule not expressible in the schema (e.g. review type not in `config.review.categories`). |
| `E_CANCELED` | Tool was canceled via the MCP `signal`. |
| `E_ENDPOINT_UNREACHABLE` | LLM endpoint could not be reached. |
| `E_CONFIRM_REQUIRED` | Destructive tool needs a `confirm_token` (or the supplied one is invalid / reused). |
| `E_INTERNAL` | Unexpected server error. Retryable. |

Meanings may sharpen in edge cases; codes themselves won't be renamed.

## Envelope shape (stable at 1.0)

Every tool returns one of:

```jsonc
// success
{ "ok": true, "paths": [...], "summary": "...", "expand_hint": "...", "content": ... }

// failure
{ "ok": false, "code": "E_*", "message": "...", "detail": ..., "retryable": boolean }
```

- `content` is only present when the caller passes `expand: true`. `paths + summary` are the default.
- `detail` is tool-specific; its shape is part of that tool's contract.
- `retryable` is a hint. Callers should honor it but are free to retry anyway.

## Tool list (as of 0.1.0-alpha.0)

**Global scope** — always loaded:
- `idea_capture`, `idea_search`, `idea_get`
- `spec_template`, `spec_save`, `spec_get`, `spec_suggest_primers`
- `project_init`
- `config_get`, `endpoint_list`, `primer_list`, `model_list`, `pack_list`
- `project_list`, `portfolio_graph`
- `vcf_ping`

**Project scope** — loaded inside an initialized project:
- `portfolio_status`
- `plan_context`, `plan_save`, `plan_get`
- `build_context`, `build_swap`, `decision_log_add`, `decision_log_list`
- `test_generate`, `test_execute`, `test_analyze`
- `review_prepare`, `review_submit`, `review_execute`, `review_history`, `response_log_add`
- `ship_audit`, `ship_build`, `ship_release`

33 tools total. Tool count + names are stable within the 1.x line.

## Deprecation policy (1.0+)

When a tool or flag is deprecated:

1. It continues to work for at least one full minor version.
2. Calling it emits a `warning` log notification on stderr with a migration hint.
3. The deprecation is listed in CHANGELOG.md under `### Deprecated`.
4. Removal happens in the next major version (bump from 1.x to 2.0).

## Support horizon

- Each **major** version gets bug fixes + security patches for **12 months** after the next major ships.
- No LTS track yet — pin to a minor version if you need stability across a project's lifecycle.

## How to depend on VCF-MCP safely

- Pin `@kaelith-labs/cli` to a **minor** range (e.g. `^1.2.0`) for library code.
- For automation / CI, pin an exact version (`1.2.3`) and upgrade deliberately.
- For Claude Code / Codex / Gemini skill packs, bump when you adopt new tools; the skill installer is versioned with `@kaelith-labs/cli`.
- KB content (`@kaelith-labs/kb`) versions independently; check its CHANGELOG for primer additions/removals.

## What triggers 1.0

- Core tool surface used in production by at least one project end-to-end.
- Cross-platform CI (ubuntu + macos + windows) green continuously for two weeks.
- Brew + Scoop install paths smoke-tested on real macOS + Windows machines.
- No open Phase-2-blocker items.
- This document reviewed and agreed to by the project lead.
