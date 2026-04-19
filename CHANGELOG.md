# Changelog

All notable changes to `@kaelith-labs/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). MCP spec compatibility and SDK version pin are called out per release.

## [Unreleased]

### Added

- **Codex CLI skill pack** (15 skills) + `vcf install-skills codex` —
  installs into `~/.agents/skills/` (Codex's user-scope skills location per
  [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills)).
  Same SKILL.md format as the Claude Code pack (open agent-skills standard);
  only the invocation hint differs (`$capture-idea` vs `/capture-idea`).
- **Gemini CLI skill pack** (15 commands) + `vcf install-skills gemini` —
  installs into `~/.gemini/commands/` as flat `<name>.toml` custom
  slash-commands per
  [geminicli.com/docs/cli/custom-commands](https://geminicli.com/docs/cli/custom-commands/).
  Each command exposes a `description` for `/help` and a `prompt` that
  instructs Gemini to call the matching MCP tool.
- **`test_generate` per-dependency matrix.** The tool now fans fannable
  kinds (`db`, `prompt-injection`, `rate-limit`, `volume`) across a
  `dependencies: string[]` input so the returned stubs name concrete
  pitfalls for postgres / redis / mysql / sqlite / mongodb / dynamodb,
  openai / anthropic / gemini / ollama, stripe / sendgrid / github,
  http / websocket / grpc / db-pool / queue. Non-fannable kinds (`unit`,
  `integration`, `regression`) remain single-stub. The spec-required 10×
  scale-target math still drives the volume stubs.
- **`vcf update-primers` three-way merge.** The MVP warn+skip path is
  replaced with a real three-way merge using `git merge-file` and an
  ancestor cache at `~/.vcf/kb-ancestors/`. Outcomes per file:
  `added` / `in-sync` / `local-only` (upstream unchanged since last sync,
  keep edits) / `fast-forward` (local unchanged since last sync, adopt
  upstream) / `auto-merged` (both moved, different regions) / `conflict`
  (both moved, same region — markers written in place; no ancestor at
  all — `.upstream` sibling written). Exits 7 when any conflict remains.
  The spec's allowed MVP warn+skip behavior is now strictly better
  without changing the invocation surface.

### Changed

- `vcf install-skills` now accepts `claude-code`, `codex`, and `gemini`
  (two nested-markdown layouts + one flat-TOML layout); unknown clients
  exit with a supported-list error.
- `test_generate` input: **`dependency: string?` → `dependencies: string[]`**
  (max 32, kebab-case). Stubs now include a `dependency` field on each
  entry so callers can route files by concrete tech rather than just kind.
  Unknown deps fall through to the kind's generic template.

## [0.0.1-alpha.0] — 2026-04-19

Initial alpha. All 13 milestones of the VCF-MCP MVP plan landed.

### Added

- **Server + CLI** (`@kaelith-labs/cli`) with dual bins (`vcf`, `vcf-mcp`), ESM,
  Node ≥ 20, Apache-2.0.
- **Two-scope MCP surface**: global (idea_capture/search/get,
  spec_template/save/get/suggest_primers, project_init, config_get,
  endpoint_list, model_list, primer_list) + project (portfolio_status,
  plan_*, build_*, decision_log_*, response_log_add, test_*, review_*,
  ship_audit, ship_build).
- **27-stage review subsystem** with carry-forward manifest, stage-entry
  rules, re-run supersession semantics, and disposable run workspaces.
- **Primer tag-matching engine** (deterministic weighted Jaccard) feeding
  `spec_suggest_primers` and `plan_context`.
- **Test pipeline** with stdout/stderr-tail capture, cancellation, timeout.
- **Ship audit**: hardcoded-path / secrets / test-data residue /
  personal-data / config-completeness / stale-security-TODO passes.
- **Ship build**: multi-target packager orchestration.
- **`vcf` maintenance CLI**: init, reindex, verify, register-endpoint,
  stale-check, update-primers, install-skills, admin audit.
- **Claude Code skill pack** (15 skills) + `vcf install-skills claude-code`.
- **Full KB corpus** via `@kaelith-labs/kb` peer dep: 25 primers, 41 best-practices,
  21 lenses, 27 review stages, 3 reviewer configs, 2 standards.
- **Opt-in error reporting** (default off, user-prompted on `vcf init`).
- **Append-only audit** with sha256-of-redacted hashing of every tool
  call's inputs + outputs.

### Pins

- MCP spec: **2025-11-25**
- `@modelcontextprotocol/sdk`: **^1.29**
- Node: **>= 20 LTS**
- Zod: **^4.0**

### Not in this release (Phase 2)

- `ship_release` (plan/confirm via `gh release create`).
- `test_generate` full per-dependency matrix.
- `vcf update-primers` three-way merge UX.
- Codex CLI / Gemini CLI skill packs.
- Local-LLM review backend (Ollama / Gemma / Qwen-coder).
- Brew formula + Scoop manifest.
- Embedding-based primer selection.
