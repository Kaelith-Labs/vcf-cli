# Changelog

All notable changes to `@kaelith-labs/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). MCP spec compatibility and SDK version pin are called out per release.

## [Unreleased]

### Added

- **Cross-project dependency graph** (Phase 3):
  - New global DB table `projects` (migration v3) tracks name +
    root_path + state_cache + depends_on + timestamps. Opt-in —
    `project_init` auto-registers unless `register: false` is passed.
  - New MCP tools: **`project_list`** (all registered projects) and
    **`portfolio_graph`** (projects + active blockers + unblocked-
    if-ships reverse map, derived from each plan's `depends_on:`
    frontmatter).
  - New CLI: `vcf project register/list/scan/unregister/refresh`.
    `scan` bulk-discovers `.vcf/project.db` dirs under a root.
  - State stays current automatically: `plan_save` + `review_prepare`
    mirror the new state into the registry; every project-scope tool
    call bumps `last_seen_at` via a hook in `writeAudit`.
  - Plan frontmatter gains optional `depends_on: [slug, …]` (or
    multi-line YAML list form). `plan_save` projects it into the
    registry — no separate indexing step.
  - Purely informational: the graph does not block state transitions;
    `ship_audit` does not consult it.
- **KB plugin protocol** — `config.kb.packs: [{name, root}]` registers
  third-party primer packs. Loader walks each pack's `<root>/kb/` and
  tags entries with `pack=<name>`; IDs are namespaced `@<name>/...` so
  pack content can never shadow main-KB files. `vcf pack add/list/remove`
  manage the registry. `primer_list` surfaces the `pack` field. New
  **`pack_list` MCP tool** (global scope) returns name + root + entry
  count per pack — lets agents discover the extension surface. `vcf
  verify` gained a `kb-packs` section that checks each pack root exists.
- **`vcf health` command** — probes each configured endpoint (HEAD,
  falls back to GET on 405/501) with a 5s default timeout, reports
  reachability. Exits 9 if any endpoint is down. `--format json` for
  automation pipelines.
- **`--format json` on `vcf verify` and `vcf stale-check`** — structured
  output on stdout (not stderr) so reports pipe cleanly into `jq` /
  n8n / cron scripts. `admin audit --format json` was also switched
  from stderr to stdout (latent bug — it was unpipe-able).
- **n8n workflow templates** under `packaging/n8n/workflows/`: weekly
  stale-check, hourly endpoint health, weekly KB-update notification.
  Each is a ready-to-import JSON with a Slack webhook placeholder; see
  `packaging/n8n/README.md` for the import walkthrough and cron
  equivalents for users not running n8n.

### Changed

- **`vcf init` seed config** now writes a commented template including
  `kb.packs: []`, explicit `review:` block, `audit.full_payload_storage`,
  and a commented-out `embeddings:` block. Easier for new users to see
  what knobs exist without reading the schema source.

### Fixed

- **`ship_release`** now enforces `timeout_ms` (default 60s, max 10 min)
  on the `gh` subprocess. Previously the spawn had no timeout, which
  on Linux CI failed fast with auth errors but on Windows Node 22 CI
  hung indefinitely. Real users get the same protection — a hung `gh`
  can't leak the handler forever.

## [0.1.0-alpha.0] — 2026-04-19

Milestone release rolling up the Phase-2 wave: server-side LLM review,
embedding-based primer selection, sub-agent review skill, full Windows
+ macOS CI matrix, and user-defined reviewer categories.

### Added

- **Homebrew tap + Scoop bucket** — install paths beyond npm:
  - `brew tap kaelith-labs/vcf && brew install vcf-cli` (formula in
    [Kaelith-Labs/homebrew-vcf](https://github.com/Kaelith-Labs/homebrew-vcf))
  - `scoop bucket add kaelith-labs https://github.com/Kaelith-Labs/scoop-vcf && scoop install vcf-cli`
    (manifest in [Kaelith-Labs/scoop-vcf](https://github.com/Kaelith-Labs/scoop-vcf))
  Both pin the current alpha tarball for reproducibility. Scoop
  auto-updates via `checkver` on the npm `alpha` dist-tag; Homebrew is
  manual until we cut 1.0.
- **Full-audit mode** (`config.audit.full_payload_storage`, default
  `false`) — when enabled, audit rows also store the *redacted* JSON of
  each tool call's inputs and outputs in two new nullable columns
  (`inputs_json`, `outputs_json`). The same redaction pass that runs
  before hashing runs before storage, so secrets don't leak; the risk
  delta vs. hash-only is that the shape of the payload is visible.
  `vcf admin audit --full` surfaces these columns in table / json / csv
  output. Migration v2 adds the columns non-destructively.
- **Custom reviewer categories** — `review.categories` in `config.yaml`
  is now fully honored at runtime. Add `"accessibility"` (or any slug)
  to the list, drop a stage file under
  `kb/review-system/accessibility/0N-*.md` with matching `review_type:`
  frontmatter, and `review_prepare`/`review_history` accept it end-to-end.
  Unknown types are rejected with `E_VALIDATION` that names the
  configured set so typos surface immediately.
- **Full cross-platform CI matrix** — ubuntu/macos/windows × Node 20/22
  on every push and PR. Re-enabled after resolving two Windows-only
  failure classes: (1) path separator + `realpath` canonicalization
  in tests; (2) SQLite `.db` / `-wal` / `-shm` OS-level locks blocking
  `fs.rm` in `afterEach`. Fixed via an explicit `closeTrackedDbs()`
  helper that tests call at the start of their cleanup, before `rm`.
  Windows cells run in ~70–130s; Linux/macOS in ~25–40s.
- **`review_execute` MCP tool** — server-side review pass against any
  configured OpenAI-compatible endpoint (Ollama `/v1`, OpenRouter, OpenAI
  itself, CLIProxyAPI, LiteLLM, Together, Groq, LM Studio, …). Given a
  `run_id` from `review_prepare` + an endpoint name, the server composes
  the prompt from the disposable workspace, redacts outgoing content,
  calls `/chat/completions`, parses a `{verdict, summary, findings,
  carry_forward}` JSON response, and persists via the shared submit
  core — same path `review_submit` uses.
  - API keys resolve from env at call time (config stores the env-var
    name via `auth_env_var`); rotation needs no server restart.
  - Trust-level gate: `trust_level='public'` endpoints require explicit
    `allow_public_endpoint: true`.
  - Cancellation via MCP SDK signal + `timeout_ms` (default 180s).
  - Audit row records run_id / endpoint / model / outcome only — never
    prompt content, response body, or API key.
- **`/review-execute` skill** in all three packs (claude-code, codex,
  gemini) with endpoint-picking guidance.
- **Shared `src/review/submitCore.ts`** — the render-report + DB-update
  persistence both `review_submit` and `review_execute` call.
- **`src/util/llmClient.ts`** — native-`fetch` OpenAI-compatible client
  with URL-redacted error messages and no raw-body surfacing.

### Changed

- `review_submit` now delegates persistence to `submitCore` (behavior
  unchanged).
- MCP tool count: 28 → 29 (review_execute added).

### Notes

- Native Anthropic / Gemini / OAuth-linked accounts are *not* in this
  tool. The OpenAI-compatible shape covers Ollama + OpenRouter + gateway
  proxies, which is what Phase-2 expected; adapters for native protocols
  are future work.
- The "client sub-agent" path (Claude Code spawning Sonnet, Codex
  spawning a nested model) remains a *client* concern — driven by the
  existing `/review` skill, not `review_execute`.

### Added — embedding-based primer selection

- **Config: optional `embeddings: { endpoint, model, blend_weight?, cache_dir? }`**
  block. `endpoint` references a declared `endpoints[]` entry (schema
  refine fails loud on typo). `blend_weight` ∈ [0,1]: 0 = pure tag
  Jaccard, 1 = pure cosine, default 0.5.
- **`vcf embed-kb` CLI command** — walks primers / best-practices /
  lenses / standards, POSTs each to the configured `/embeddings` surface
  (Ollama + OpenRouter + OpenAI + LiteLLM + Nomic all speak it), writes
  records under `~/.vcf/embeddings/<entry-id>.json`. Idempotent: entries
  whose content SHA matches the cached record are skipped. Exits 8 if
  any failures.
- **Blended `spec_suggest_primers`** — when embeddings are configured
  and the cache is populated, the tool embeds the query live (tag join),
  computes cosine against each cached entry, and blends with the
  normalized tag score. Falls back to tag-only automatically on: no
  config block, empty cache, endpoint unreachable, live embed failure,
  missing vector for a specific entry. Response now includes
  `scoring: "tag" | "blended"` so callers can see which signal won.
- **`callEmbeddings`** added to `src/util/llmClient.ts` — matches the
  OpenAI-compatible `/embeddings` response shape, same URL-redacted
  error handling as `callChatCompletion`.
- Tests: 15 new unit cases for `src/primers/embed.ts` (cosine, blend,
  cache round-trip, build-embedding-input, sha256) + 4 integration
  cases for `spec_suggest_primers` blended scoring (including all three
  fallback branches).
- 178 tests green (was 162).
- **`/review-subagent` skill** (claude-code + codex + gemini) — completes
  the three-path review story: `/review` (parent agent reviews in-context),
  `/review-subagent` (parent spawns a fresh sub-agent that calls MCP
  tools itself, report file lands in the same `plans/reviews/` tree),
  `/review-execute` (server calls a configured HTTP endpoint, no client
  LLM). The skill is client-side prose — the MCP server already supports
  all three via the existing `review_prepare` + `review_submit` pair.
  The sub-agent prompt optionally pulls `plans/<plan-name>-manifest.md`
  when available (not an error if missing), then drives the disposable
  workspace end-to-end on its own.
- `/review` skill gains a "Variants" section listing all three paths.

## [0.0.2-alpha.0] — 2026-04-19

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
