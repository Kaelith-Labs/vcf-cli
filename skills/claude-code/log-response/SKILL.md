---
name: log-response
description: Append a builder-to-reviewer stance to the response log via response_log_add. Triggers on "respond to review", "/log-response".
---

# Log Response

Record the builder's stance (agree / disagree) on a specific reviewer finding.

## When to use

- User invokes `/log-response` or says *"respond to that finding"*, *"I disagree with stage 2 finding 4"*.
- Always after a review has produced findings. Never invent findings to respond to.

## What to do

1. Identify the `review_run_id` (visible in the review report's frontmatter, or via `review_history`).
2. Ask the user: agree or disagree? And the note — required whenever `stance = disagree`, recommended otherwise.
3. Call `response_log_add({ review_run_id, stance, note, expand: true })`.
4. Tell the user the response is appended to `plans/reviews/response-log.md` and will be read by every subsequent `review_prepare` pass.

## Rules

- Notes on `disagree` must explain *why* the design choice stands — that's what the next reviewer uses to avoid re-opening the same thread.
- Append-only: never edit a prior entry; add a new one that references the earlier `review_run_id`.
