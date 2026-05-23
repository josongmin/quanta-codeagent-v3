---
name: get-pr-comments
description: Summarize PR review comments with action items, anchored to file:line. Triggers on "summarize PR review", "what does the review say", "what changes were requested", or after sharing a PR URL with review activity.
userInvocable: true
allowedTools:
  - Bash
  - Read
category: skill
stability: stable
tools:
  - Bash
  - Read
---

# PR review-comment digest

Adapted from Cursor CTK `get-pr-comments` (ADR-0102 absorption batch). The
job is to turn a noisy review thread into a ranked action list — what the
user must actually do — without hallucinating priorities the reviewer did
not state.

## When this skill activates

- The user asks "summarize the PR review" / "what does the review want".
- The user shares a PR URL after review activity.
- A `babysit` loop is `awaiting-review` and needs to surface review state.

## P0 rules

1. **Every action item is anchored to file:line.** A summary without
   anchors is useless; the reviewer's reference is the SSOT.
2. **Distinguish blocking vs nit.** GitHub's `state: CHANGES_REQUESTED` vs
   `COMMENTED` is the canonical signal. Reviewer words like "minor" /
   "optional" / "nit" downgrade to nit; "must" / "required" / "blocking"
   upgrade to blocking.
3. **Outdated comments stay LISTED but tagged.** If the comment's anchor
   line was edited after the comment, mark it `[outdated]`. Do not silently
   drop it — the reviewer may want to confirm it's addressed.
4. **Resolved threads stay tagged.** `isResolved: true` from the GraphQL
   payload means the reviewer pressed "resolve"; surface those at the end
   so the user can sanity-check.
5. **Never paraphrase the reviewer's wording into a different ask.** Quote
   the reviewer verbatim for blocking items; paraphrase only for nits.

## Procedure

1. **Fetch the review threads via GraphQL** (the REST API does not return
   thread anchors): `gh api graphql -F owner=O -F repo=R -F pr=N -f
   query='{ repository { pullRequest { reviewThreads(first: 100) { ...} }}}'`
   pulling `path`, `line`, `originalLine`, `isResolved`, `isOutdated`,
   `comments { author, body }`.
2. **Group by file** in the order the PR diff presents them.
3. **Rank each thread** as blocking | nit | question | resolved using the
   P0 rule signals.
4. **Output one block per thread**:
   ```
   - [blocking] path/file.ts:42 — quote of reviewer ask
       reviewer: @<author>
       resolution: <empty | how the user fixed it>
   ```
5. **Surface the review verdict.** `gh pr view --json reviewDecision` —
   `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED`.

## Outcome enum

- `digested` — every thread classified, blocking items at top, anchors
  attached.
- `partial` — could fetch but some threads missing context (e.g. comment
  on a deleted file); LIST them as `[context-missing]`.
- `blocked` — could not fetch (no `gh` auth, no GitHub remote).
