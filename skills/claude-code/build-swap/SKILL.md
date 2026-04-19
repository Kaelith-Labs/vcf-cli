---
name: build-swap
description: Compact the current session and resume as a different builder type via build_swap. Triggers on "swap to frontend", "swap to infra", "/build-swap".
---

# Build Swap

Hand off the builder persona — used at the plan's named swap boundaries (e.g. backend finished → frontend).

## When to use

- User invokes `/build-swap <from> <to> <plan-name>` or says *"swap to frontend"*, *"switch to infra builder"*.
- Only at a boundary the plan named. Don't swap mid-feature.

## What to do

1. Call `build_swap({ from_type, to_type, plan_name, expand: true })`. You receive `compaction_hint` + the target builder type's `best_practice_md` body.
2. Summarize the compaction_hint to the user.
3. Tell the user: end this session now, start a fresh one, and call `/build` again — the new session will pick up the target-type best-practice plus the plan/manifest/decisions.
4. Do **not** continue building in the current session after a swap call. That's the whole point of the boundary.

## Reminders

- `build_swap` does not actually switch your own context — it can't. The client (you) ends the session.
- If there's no matching best-practice in the KB for the target type, the tool returns null and notes it — proceed with generic guidance.
