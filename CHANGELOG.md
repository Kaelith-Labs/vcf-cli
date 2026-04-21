# Changelog

All notable changes to `@kaelith-labs/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). MCP spec compatibility and SDK version pin are called out per release.

## [0.3.1] — 2026-04-21

**Hardening pass — real bugs + workaround cleanup.** No public-API changes;
every CLI flag, MCP tool, and config shape is identical to 0.3.0.

### Fixed

- **Audit-on-error invariant across all 28 MCP tools.** Previously only
  `test_execute` wrote an audit row on the sad path. Every other tool's
  fallback `.catch()` was unreachable because `runTool` already swallows
  errors. `E_CANCELED`, `E_STATE_INVALID`, and Zod-validation failures
  now persist to `~/.vcf/vcf.db.audit` so `vcf admin audit` can replay
  a failed session.
- **`upsertProject` TOCTOU race.** Two concurrent registrations on the
  same `root_path` could both miss the SELECT and race to INSERT, with
  the second failing at the UNIQUE constraint. Replaced SELECT-then-
  INSERT with a single atomic `INSERT ... ON CONFLICT DO UPDATE`.
- **SIGKILL escalation timer leak in `test_execute` and `ship_build`.**
  When a child process exited between SIGTERM and the 2s SIGKILL
  escalation, the inner timer's callback stayed pinned to closure state
  until it fired uselessly. Both now clear the escalation handle when
  the process finishes cleanly.
- **`vcf init` now accepts `--telemetry` / `--no-telemetry`** and
  auto-defaults to `false` when stdin is not a TTY. CI pipelines and
  unattended provisioning no longer need a `printf 'n\\n' |` hack.

### Changed

- **`VERSION` constant auto-derived from `package.json`.** Previously
  `src/version.ts` was a hardcoded string that drifted three releases
  behind reality once already. Now uses the ESM JSON import
  (`with { type: "json" }`) so `vcf version` can never lie again.
- **`DatabaseSync` row shapes validated at the data boundary.**
  Replaced `as unknown as T[]` casts in `projectRegistry`, `idea_get`,
  `idea_search`, `spec_get` with a shared Zod-parsing `queryRow` /
  `queryAll` helper in `src/util/db.ts`. A dropped/renamed column now
  throws loudly rather than silently producing `undefined`.
- **Vitest `poolOptions` migrated to the v4 top-level shape**
  (`maxWorkers: 1, isolate: false`). Silences the every-test
  deprecation warning.
- **Shared `src/util/ids.ts`** now owns the filesystem-safe compact-ISO
  timestamp generator. `review_prepare` and `submitCore` both use it;
  the second-resolution pattern in `submitCore` is now ms-resolution
  too, closing the class of "two writes in the same second collided
  on a UNIQUE constraint" bug.

### Documentation

- `docs/STABILITY.md` now documents CLI exit codes — particularly that
  `vcf health` exits `9` (not `1`) when endpoints are unreachable, so
  CI can accept exit 0 OR 9 without eating real crashes.

## [0.3.0] — 2026-04-21

**Drop `alpha` tag.** Four-platform smoke coverage (macOS, Windows ARM64,
Windows x64, Linux) all green on `0.3.0-alpha.0`. No code changes from that
cut — only the prerelease suffix is removed and the `latest` dist-tag will
now advance as releases ship.

### Smoke coverage added in this cut

- `packaging/smoke-tests/smoke-linux.sh` — npm-global install path on Linux,
  mirrors the macOS/Windows scripts (16 checks, runs in ~3s).
- Windows x64 validation via a KVM-hosted Win11 25H2 VM. Closes the
  architecture-gap followup filed alongside the ARM64 smoke: `node:sqlite`
  works identically on x64 Windows, no native compile.

## [0.3.0-alpha.0] — 2026-04-21

**Migrate off `better-sqlite3` to `node:sqlite`.** Eliminates every native-addon
install-path failure class in one change.

### Why

The 2026-04-20 Surface smoke test surfaced a hard block on Windows ARM64 +
Node 24: `better-sqlite3@11.10`'s `prebuild-install` couldn't locate the
matching prebuilt binary despite it existing on GitHub releases. Upstream
research (better-sqlite3 #1463, #655, PR #1446, archived `prebuild-install`
repo) showed this is a known, multi-year-stalled issue — not something a
formula tweak can route around.

Node 22.5 introduced a built-in SQLite module (`node:sqlite`), unflagged
since 22.13, at Stability 1.2 RC since Node 25.7. Migrating gives us:
- Zero native compile — no `prebuild-install`, no `node-gyp`, no MSVC
  dependency on Windows, no Xcode on macOS
- Works identically on every platform Node runs on: Windows x64, Windows
  ARM64, macOS Intel, macOS ARM, Linux glibc, Linux musl
- Smaller install footprint
- No peer dependency on `@types/better-sqlite3`

### Changed

- **Dependency:** removed `better-sqlite3` (and `@types/better-sqlite3`
  devDep). No runtime additions — `node:sqlite` ships with Node itself.
- **`engines.node`:** bumped `>=20` → `>=22.13`. Node 22 is active LTS
  through October 2027.
- **CI matrix:** dropped Node 20, kept 22 and added 24. Matrix stays
  Ubuntu + macOS + Windows.
- **DB layer** (`src/db/global.ts`, `src/db/project.ts`, `src/db/migrate.ts`):
  - `new Database(path, opts)` → `new DatabaseSync(path, opts)`
  - `opts.readonly` → `opts.readOnly` (API naming)
  - `db.pragma("journal_mode = WAL")` → `db.exec("PRAGMA journal_mode = WAL")`
  - `db.transaction(fn)` → explicit `BEGIN / COMMIT / ROLLBACK` in migrate.ts
    (node:sqlite has no wrapper helper; the migration path's one usage was
    trivial to convert)
  - Foreign keys on by default now (node:sqlite default) — kept the
    explicit `PRAGMA foreign_keys = ON` anyway so the contract is clear.
- **Type imports:** every `Database as DatabaseType from "better-sqlite3"`
  rewritten to `DatabaseSync as DatabaseType from "node:sqlite"`.
  Sites: `src/server.ts`, `src/review/submitCore.ts`, `src/util/audit.ts`,
  `src/util/projectRegistry.ts`, `test/helpers/db-cleanup.ts`.
- **Stmt return-type casts:** `node:sqlite`'s typed return is
  `Record<string, SQLOutputValue>`, stricter than better-sqlite3's generic.
  Added `as unknown as RowType[]` where needed at known-safe call sites
  (idea_search, spec_get, idea_get, projectRegistry.listProjects).

### Build infrastructure

- **tsup:** esbuild strips the `node:` protocol prefix on built-ins when
  bundling for Node. For `node:sqlite` that breaks runtime (no bare
  `sqlite` alias exists in Node's builtin map). Added a post-build
  `onSuccess` hook that rewrites `from 'sqlite'` back to
  `from "node:sqlite"` across `dist/*.js`.
- **vitest:** bumped to ^4.1.4 (from ^2.1.9). Vite 5 + vitest 2 didn't
  handle `node:sqlite` resolution because the module predates their
  built-in map. Vitest 4 / Vite 6 resolves it correctly.
- **tsup target:** `node20` → `node22` to match the new engines floor.

### Known followups (not blocking 0.3.0)

- `node:sqlite` still emits `ExperimentalWarning` on Node 22/24. Stability-2
  lands in Node 25.7 (April 2027 LTS). Cosmetic — doesn't affect the MCP
  stdio protocol. Filed as followup 7.
- Windows x64 VM smoke not yet run — only Windows ARM64 was tested this
  pass. Filed as followup 6.

## [0.2.1-alpha.0] — 2026-04-20

Three install-path bugs found during the first real Homebrew smoke run on
macOS 26.3.1, all blocking `vcf` from doing anything when installed via
`brew install` or any other symlink-based install path.

### Fixed

- **CLI entrypoint guard fails on symlink invocation.** `src/cli.ts`
  compared `import.meta.url` against `pathToFileURL(process.argv[1]).href`
  to decide whether to run `parseAsync`. Homebrew, Scoop, and npm all
  install the `vcf` binary as a symlink into a versioned Cellar / shim
  directory, so argv[1] was the symlink while import.meta.url was the
  target — the URLs never matched, main never ran, and every invocation
  silently exited 0 with no output. Fix: canonicalize argv[1] via
  `fs.realpathSync` before the comparison. Regression test in
  `test/integration/cli-symlink-entrypoint.test.ts` spawns the built
  `dist/cli.js` via a real symlink and asserts version output reaches
  stdout.
- **`vcf version` wrote to stderr and used the wrong prefix.** Output is
  now on stdout (so shell pipelines and smoke tests can grep it) and
  formatted as `vcf-cli <version> (MCP spec <spec>)` to match the brew
  formula's `test do` block, the Scoop package name, and the install-path
  smoke scripts.
- **`src/version.ts` was stale at 0.0.2-alpha.0** — the M0 stub comment
  promised a build-time pipeline that never landed. Synced manually to
  0.2.1-alpha.0; a proper build-time auto-sync is filed in
  `plans/2026-04-20-followups.md` item 4.

### Pipeline

- Homebrew tap formula was also updated to use `std_npm_args(prefix:)` —
  Homebrew dropped `Language::Node.std_npm_install_args` in a recent
  release, causing `brew install vcf-cli` to fail with `NameError:
  uninitialized constant Language::Node`. Change lives in
  `Kaelith-Labs/homebrew-vcf`.

## [0.2.0-alpha.0] — 2026-04-20

Phase-3 feature wave. Cross-project visibility, third-party KB
extensibility, scheduled-automation surface, Windows reliability fix.

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
