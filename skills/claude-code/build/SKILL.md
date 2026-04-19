---
name: build
description: Pull builder context and implement the next todo item via build_context + decision_log_add. Triggers on "build next", "/build".
---

# Build

Execute one slice of the plan. Never two slices at a time.

## When to use

- User invokes `/build [<plan-name>]` or says *"build next"*, *"implement the next item"*.
- Requires project-scope MCP + a saved plan.

## What to do

1. Call `build_context({ plan_name, builder_type, expand: true })`. You receive:
   - `builder_md` (role overlay), `standards_md`, `vibe_best_practice_md`, optional `type_best_practice_md`
   - `plan.{plan,todo,manifest}` bodies
   - `decisions[]` (prior ADRs — do not re-open)
   - `response_log_md` (prior reviewer exchanges — respect disagreements)
2. Pick the **next unchecked item** in the todo list. One.
3. Implement. The builder role forbids:
   - `catch (e) {}` without a comment explaining the swallow
   - unpinned deps
   - mocks whose return shape mirrors implementation assumptions
   - hardcoded paths/URLs/secrets
4. For any design call the plan did not make for you, stop and call `decision_log_add({ title, context, decision, consequences })` before proceeding.
5. Run the relevant local tests. Commit with a subject that describes the slice, not the mechanics.

## Reminders

- The `post-commit` git hook appends to `memory/daily-logs/<date>.md` automatically. Don't edit daily logs by hand.
- Stop on failure: if the tests don't pass, halt, diagnose, report. Do not patch around broken state.
