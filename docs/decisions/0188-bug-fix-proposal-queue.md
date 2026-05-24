# ADR-0188: Bug-fix proposal queue (debug-trace automated bug-fix loop, Phase 1)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0181 (debug/blame skills trio — `debug-trace` is the producer that calls `capture()` into this queue), ADR-0124 / ADR-0177 (conversation-checkpoint store + LRU swap — sibling capture-and-list primitive shape this slice mirrors), ADR-0118 (shadow ODB — the Phase 2 rollback anchor that auto-apply will hook into)
- **References**: `src/agent/debug-trace-autofix.ts`, `tests/unit/agent-debug-trace-autofix-hellgate.test.ts`, `tools/feature-catalog/features/06-tier1/bug-fix-proposal-queue.yaml`

## Research grounding

`docs/analysis/경쟁사리뷰/code-agent-loop/cursor.md` §2 + skills catalogue: Cursor's only autonomous-feeling fix paths are (a) LSP code actions surfaced as the editor "quick fix" lightbulb (the **user** clicks to apply) and (b) Bugbot review comments on PRs (the **user** decides which to action — `babysit` skill prose explicitly says *"Carefully validate issues reported by Bugbot and only take action on those that are valid"*). There is no autonomous "diagnose-and-apply" inner loop documented in the binary. Devin-style autonomous fix loops, heard via industry news, also terminate in a PR proposal not a direct push. Conservative posture matches the industry pattern: **capture and surface, human applies**.

## Context

ADR-0181 shipped `debug-trace`, which produces ranked `{file:line, cause, fix}` hypotheses as model output text. The natural follow-up is a structured sink — when the skill (or any sibling diagnostic surface) emits a hypothesis, that envelope should be capturable in a typed queue the caller can review programmatically (slash command listing, planner UI, test rig assertion). Today there is no such sink: hypotheses exist only as prose in the transcript.

The temptation is to leap to **auto-apply** — diagnose → edit → run tests → keep or rollback. That requires three load-bearing safety pieces this slice deliberately does NOT take on:

1. **verify-guard wire** — must run the failing scenario before AND after to confirm the fix actually fixes it without regressing the nearest existing tests.
2. **shadow rewind anchor** — must take a `ShadowOdb` snapshot before the edit so a test-regression rollback is byte-precise (ADR-0118).
3. **retry budget cap** — must bound attempts per session (e.g. ≤3 hypotheses tried per error) so a confused model can't thrash a file.

None of those are unsolved problems in this codebase, but bundling them with the queue primitive blurs both contracts. We ship the queue alone and defer auto-apply to a follow-up ADR with its own hellgate.

## Decision

Add a plane-clean primitive `src/agent/debug-trace-autofix.ts` exposing:

- `BugFixHypothesis` — `{cause, fix, confidence}` triple, caller supplies in rank order.
- `BugFixProposal` — `{id, capturedAt, errorSummary, file, line, hypothesisRanked, verifyRail?}`. `verifyRail` is exactOptional-omitted when absent (never `undefined`).
- `BugFixProposalError` — typed error class thrown ONLY on programmer-bug input (missing required fields). Operational misuse (unknown id in `resolve`) returns `false`, never throws.
- `BugFixProposalQueue` — capture / list (newest-first, frozen array) / resolve (boolean) / clear.
- `BugFixProposalQueueOpts` — `maxEntries` (default 50, min 1), `now` (injected clock, default `Date.now`), `idGen` (injected, default `bf-<8hex>` from `node:crypto.randomBytes(4)`).
- `defaultBugFixProposalQueue(opts?)` — Map-backed, insertion-ordered LRU.

The queue freezes both each proposal object and the array returned from `list()` so callers cannot corrupt stored state via the borrowed reference.

## CRITICAL invariant

**This queue does NOT modify source code.** The module imports only `node:crypto` for id generation. There is no `@/storage`, no `@/tool`, no edit pathway. The slice is a typed sink; any caller wanting to mutate files must wire its own apply step on top — and that step belongs to the Phase 2 slice with the safety design above. The invariant is enforced by the import boundary: zero workspace-path symbols cross into this file.

## Hellgate (13 cases)

`tests/unit/agent-debug-trace-autofix-hellgate.test.ts` pins:

| # | Bucket | Pinned invariant |
|---|---|---|
| HELL-1 | capture | happy path; id matches `/^bf-[0-9a-f]+$/`; list has 1 entry with all fields preserved |
| HELL-2 | capture | `capturedAt` uses the INJECTED clock (deterministic timestamp) |
| HELL-3 | capture | `hypothesisRanked` order preserved verbatim — no implicit confidence rerank |
| HELL-4 | capture | empty `errorSummary` / empty `file` / non-positive `line` / fractional `line` all throw `BugFixProposalError` with field-named message |
| HELL-5 | list | multiple captures → newest first |
| HELL-6 | list | empty queue → empty array (no throw) |
| HELL-7 | list | returned array is frozen — `pop()` / `push()` both throw at runtime |
| HELL-8 | resolve | known id → `true`; subsequent list omits the resolved entry |
| HELL-9 | resolve | unknown id → `false`; queue unchanged |
| HELL-10 | resolve | same id twice → second returns `false` (idempotent) |
| HELL-11 | LRU | cap=3 + 4 captures → oldest evicted; resolve on the evicted id → `false` (caller can't distinguish "evicted" from "never existed") |
| HELL-12 | LRU | injected `idGen` controls id text verbatim |
| HELL-13 | determinism | same captures + same clock + same idGen → byte-identical `list()` output via JSON round-trip |

(+ `clear()` smoke test). Verification: `bun test tests/unit/agent-debug-trace-autofix-hellgate.test.ts` → 14 pass / 0 fail / 41 expect() calls.

## Default-OFF

Nobody wires this today. The `debug-trace` skill prose continues to render hypotheses as model output (no behavior change). A future caller — slash router (`/bug-fix-proposals`), planner UI panel, or test rig — opts in by constructing `defaultBugFixProposalQueue()` and passing the port into the skill invocation context. Until then the file is a typed sink waiting for opt-in. Zero token cost, zero behavior change.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Auto-apply in this slice** | Requires verify-guard wire + shadow rewind anchor + retry budget cap (three other primitives, each with its own contract). Bundling them blurs the queue's purpose and ships a primitive too big to audit. Industry posture (Cursor manual quick-fix click + Bugbot review-only) confirms capture-and-surface is the right Phase 1. |
| **SQLite-backed queue** | Persistence is a Phase 2 question (do proposals survive session restart? Per-session or per-repo scope?). In-memory primitive answers the immediate need (per-session listing) without committing to a storage shape. ADR-0124 used the same posture — Map first, swap to backed store later (ADR-0177). |
| **Broadcast event (emit on capture, callers subscribe)** | Adds an event bus dependency to a leaf primitive. Callers can poll `list()` from any cadence they want; for surfaces that need push, an `EventEmitter` adapter is a 5-line wrapper at the consumption site. Keep the primitive small. |
| **Per-error grouping (one entry per `errorSummary`, append hypotheses)** | Forces a primary key choice (`errorSummary` exact match? Levenshtein?). Each `capture()` represents a distinct skill invocation — collapsing them loses the run-time signal. Caller can group at render time if needed. |
| **Drop `verifyRail` field** | Tiny addition, big value — when the skill knows the test command (often the case — `debug-trace` reads stack frames from `parse_test_failure`), preserving it makes Phase 2 auto-apply trivial. Cost: one optional field. |

## Follow-up

- **Phase 2: auto-apply slice** — separate ADR, separate file (`src/agent/debug-trace-autoapply.ts` or similar). Wires verify-guard (must run failing scenario + nearest regression suite), shadow rewind (ADR-0118 snapshot taken before each attempt, restored on regression), and a retry budget cap (`maxAttemptsPerError`, default 3, sourced from session config). HITL tier `always-confirm` by default so the human is in the loop until the system earns trust.
- **PR-emitter bridge** — drain queue → open GitHub PR per proposal for human review. Sibling slice; depends on this queue + a `gh` permission grant.
- **SQLite-backed queue** — when Phase 2 needs cross-session persistence (e.g. "still pending after the session ended"), swap the Map for a lru-cache or sqlite store, parity-tested via a hellgate mirror (the ADR-0177 pattern).
- **`/bug-fix-proposals` slash command** — UI surface for the human to list / inspect / resolve / dismiss queue entries. Trivial once a slash router instantiates the queue at session start.
