---
name: ship-build
description: Orchestrate packager targets via ship_build. Triggers on "ship it", "build release", "/ship-build".
---

# Ship Build

Run one or more packaging targets (npm publish / goreleaser / electron-builder / pkg / custom) in sequence.

## When to use

- User invokes `/ship-build`.
- Only after `/ship-audit` is clean.

## What to do

1. Propose a `targets[]` array based on the project. Examples:
   - `[{name: "npm", command: "npm", args: ["publish"]}]`
   - `[{name: "linux", command: "goreleaser", args: ["release", "--clean"], timeout_ms: 600_000}]`
2. Confirm with the user — these run real commands with real side effects.
3. Call `ship_build({ targets, stop_on_first_failure: true, expand: true })`.
4. Report `any_failure`, exit codes, and stdout/stderr tails per target.

## Rules

- `stop_on_first_failure: true` is the default for a reason — don't override casually.
- Never embed secrets in `env:` — pass the env var name via shell inheritance.
- `ship_release` (git tag + GitHub release) is Phase 2. Run `gh release create` manually on green build.
