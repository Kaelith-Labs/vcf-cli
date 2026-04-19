# @kaelith-labs/cli

**Status:** alpha. MVP shipped. Not yet published to npm (awaiting tag + NPM_TOKEN).

The **Vibe Coding Framework MCP** — an LLM-agnostic Model Context Protocol server + `vcf` CLI for the vibe-coding lifecycle: **capture → spec → init → plan → build → test → review → ship**. Same workflow, any MCP client (Claude Code today; Codex / Gemini Phase 2).

- **Server owns state, files, index, context prep.** Clients own conversation + execution.
- **Token-economy first**: tools default to `{paths, summary}`; `expand=true` gets content.
- **Two scopes**: global (idea / spec / project-init / catalog) and project (full lifecycle).
- **27-stage review subsystem** with carry-forward manifest, stage-entry rules, disposable workspaces.
- **Primer tag-matching** is deterministic (weighted Jaccard); no embeddings in MVP.
- **No hardcoded paths, no ambient network, no auto-update.** Everything through `~/.vcf/config.yaml`.

---

## Install (once published)

```bash
npm install -g @kaelith-labs/cli
```

Two bins land: `vcf` (maintenance CLI) and `vcf-mcp` (stdio MCP server).

## First-run setup

```bash
vcf init
```

This:

- seeds `~/.vcf/config.yaml` (asks y/N for opt-in error reporting, default **off**)
- writes/merges `~/.mcp.json` to launch `vcf-mcp --scope global` from every MCP client session
- creates `~/.vcf/vcf.db` on first tool call

```bash
vcf install-skills claude-code   # → ~/.claude/skills/<name>/SKILL.md
vcf install-skills codex         # → ~/.agents/skills/<name>/SKILL.md  (also read from project-scope .agents/skills/)
vcf install-skills gemini        # → ~/.gemini/commands/<name>.toml    (also read from project-scope .gemini/commands/)
```

Copies the 15-skill pack into the client's skills/commands directory. Claude Code and Codex use the open agent-skills `SKILL.md` format; Gemini CLI uses `.toml` custom slash-commands. Re-running is idempotent — existing entries are skipped so your edits aren't clobbered.

## Lifecycle walk-through

### 1. Capture an idea (global scope)

In Claude Code:

> _"capture this idea: a primer-scraper that pulls newly-added docs from @kaelith-labs/kb and summarizes the diff as an email digest"_

Claude's `capture-idea` skill fires `idea_capture`. The result is `~/vcf/ideas/YYYY-MM-DD-primer-scraper.md` with tagged frontmatter, indexed in the global DB.

### 2. Spec the idea

> _"spec that"_ — `/spec-idea primer-scraper`

Claude's `spec-idea` skill runs `spec_template(project_name, idea_ref)`, fills the 14-section PM-ready template from conversation + the captured idea, then `spec_save`s it to `~/vcf/specs/YYYY-MM-DD-primer-scraper.md`.

### 3. Initialize the project

> _"/initialize-project \"Primer Scraper\" ~/projects/primer-scraper \<spec-path\>"_

`project_init` scaffolds the dir: AGENTS.md / CLAUDE.md / TOOLS.md / MEMORY.md / README.md / CHANGELOG.md (from templates) + plans/ memory/ docs/ skills/ backups/ subdirs + `.vcf/project.db` + `.mcp.json` (auto-wiring `--scope project` for the next session) + `git init` with `post-commit` (daily-log append) and `pre-push` (gitleaks + uncommitted artifact warning) hooks.

### 4. Plan inside the project

Open a new MCP client session in the project directory. The project's `.mcp.json` loads `vcf-mcp --scope project` automatically.

> _"/plan scraper"_

`plan_context` assembles:

- `planner.md` (role overlay + what a good plan must name and forbid)
- `company-standards.md` + `vibe-coding-primer.md`
- **Tag-matched primers** — the engine ranks `@kaelith-labs/kb` entries against the spec's `tech_stack` + `lens` tags (weighted Jaccard; fresher `last_reviewed` wins ties).
- The spec body

Claude writes `plans/scraper-plan.md` / `scraper-todo.md` / `scraper-manifest.md`. `plan_save(advance_state: "planning")` persists and bumps project state.

### 5. Accept the plan → start building

> _"/accept-plan scraper"_ → flips state to `building`.
> _"/build scraper"_ → loops through todo items one at a time.

`build_context` returns `builder.md` + vibe-coding best-practices + the plan files + prior decision log + response log. The builder LLM picks the next unchecked todo, implements, commits (which triggers the `post-commit` hook to append the daily log), and moves on.

Any non-trivial design call → `/log-decision` (ADR-lite at `plans/decisions/YYYY-MM-DD-<slug>.md`).

At phase boundaries the plan named: `/build-swap backend frontend scraper` returns a compaction hint and the frontend best-practice for the fresh session to load.

### 6. Test

> _"/test"_

`test_generate` returns stubs per kind (unit, integration, db, prompt-injection, rate-limit, volume-@-10×-scale, regression). Builder fills them. `test_execute` spawns the runner (pytest, vitest, jest, k6, vegeta, locust) with cancellation + timeout. `test_analyze` detects pytest / vitest / jest / go / cargo / mocha / k6 failure signatures and returns the first N distinct failures.

### 7. Review (27-stage subsystem)

> _"/review code 1"_

`review_prepare` creates a **disposable** `.review-runs/code-1-<ts>/` workspace. It _copies_ (never references) the stage file + reviewer overlay from `@kaelith-labs/kb`, writes a `carry-forward.yaml` seeded from the most recent Stage-0 PASS, snapshots the decision + response logs, and (if `diff_ref` given) writes a scoped git diff.

The reviewer LLM produces `{verdict: PASS|NEEDS_WORK|BLOCK, summary, findings, carry_forward}` → `review_submit`. Report lands at `plans/reviews/code/stage-1-<ts>.md`.

Stage-entry rule: Stage N>1 **requires** Stage N-1 PASS unless `force: true` (audited). Re-running a passed stage creates a new run id and marks the prior row `superseded`.

Builder responds via `/log-response` — disagreements are respected by future reviewers.

### 8. Ship

> _"/ship-audit"_

6 passes: **hardcoded-path** (blocker), **secrets** (blocker; uses gitleaks if installed), **test-data-residue** (blocker), **config-completeness** (blocker), **personal-data** (warning), **stale-security-TODOs** (warning). `fail_fast: true` halts at the first blocker.

> _"/ship-build"_

`ship_build({ targets })` orchestrates packagers in sequence (npm publish, goreleaser, electron-builder, pkg, custom) — never reinvents them. Per-target stdout/stderr tail, cancellation, timeout. Every target lands in `project.db.builds`.

Final `gh release create` is manual in this MVP (`ship_release` lands as a plan/confirm tool in the next iteration).

## Maintenance (CLI-only)

```bash
vcf reindex                  # re-scan plans/ memory/ docs/ into project.db
vcf verify                   # config + allowed_roots + KB + env vars + hooks
vcf register-endpoint \      # append a new LLM endpoint to config.yaml
  --name openai-main \
  --provider openai-compatible \
  --base-url https://api.openai.com/v1 \
  --trust-level public \
  --auth-env-var OPENAI_API_KEY
vcf stale-check              # flag KB entries past review.stale_primer_days
vcf update-primers           # pull latest @kaelith-labs/kb (warn + skip on conflicts)
vcf admin audit --tool idea_capture --format table
```

These are intentionally not MCP tools. Deterministic maintenance that a human or CI runs should be a CLI command, not a tool that burns tokens on every LLM turn.

## Pins

| Pin                        | Version                                           |
| -------------------------- | ------------------------------------------------- |
| MCP spec                   | **2025-11-25**                                    |
| `@modelcontextprotocol/sdk` | **^1.29** (v2 is pre-alpha)                      |
| Node                       | **≥ 20 LTS**                                      |
| Zod                        | **^4**                                            |
| Content package            | `@kaelith-labs/kb` peer dep in range `>=0.0.1-alpha <0.2.0` |

## Non-negotiables (enforced in code, not aspirational)

- `.strict()` Zod inputs; fuzz suite proves every tool rejects every malformed shape with a stable `E_*` code or SDK-level schema error.
- Paths re-validated against `workspace.allowed_roots` after `fs.realpath` (symlink + `..` + URL-encoded + prefix-sibling all rejected).
- Secrets live in env vars; config interpolates `${VAR}` and fails loud with the var _name_ on miss.
- Append-only audit: every tool call emits one row with sha256 of redacted inputs + outputs.
- Disposable review runs; the stage template is never mutated in place.
- Stdout is JSON-RPC only in stdio mode; pino logs to stderr (fd 2). ESLint bans `process.stdout` writes to prevent regressions.

## Phase 2 (explicitly out of this MVP)

- `ship_release` with plan/confirm → `gh release create` (Phase 2 — the `confirm_token` primitive is already shipped)
- `test_generate` full per-dependency matrix
- `vcf update-primers` three-way merge UX
- Codex CLI + Gemini CLI skill packs
- Local-LLM review backend (Ollama / Gemma / Qwen-coder) with per-stage routing
- Brew formula + Scoop manifest
- Embedding-based primer selection

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Links

- KB: [github.com/Kaelith-Labs/vcf-kb](https://github.com/Kaelith-Labs/vcf-kb)
- CHANGELOG: [./CHANGELOG.md](./CHANGELOG.md)
