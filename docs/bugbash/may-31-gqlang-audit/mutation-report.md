# May-31 bugbash hellgates — mutation-test report

**Question asked of every critical hellgate:** *if I revert the production fix it
claims to guard, does the hellgate go RED?* A gate that stays GREEN under the
revert is a **blind spot** — it asserts something the fix did not actually change,
so it would never catch a regression. (This is exactly how the `turn.cancel`
controller-registration-window bug survived its first pass: the original hellgate
slept 5 ms and *stepped over* the window, so reverting the fix left it green.)

## How to reproduce / re-run

```
bun run tools/dev/mutation-check.ts            # all critical hellgates
bun run tools/dev/mutation-check.ts t03-h8     # one entry by id substring
```

The harness (`tools/dev/mutation-check.ts`) encodes the critical-hellgate list.
For each entry it (1) asserts the fix text is still present (a drifted/renamed fix
is a HARD error, never a silent "blind spot"), (2) applies a surgical revert to the
production src, (3) runs the guarding hellgate filtered to the case it guards,
(4) asserts it now FAILS, and (5) **always restores the src** in a `finally`.
Exit code is non-zero if any blind spot remains, so it can run as a CI proof rail.

## Result: 15/15 critical hellgates are REAL proof rails (0 blind spots remaining)

Two were blind under the *initial* mutation and were resolved before commit — one
by **strengthening the test** (a genuine test blind spot) and one by **fixing the
mutation target** (the test was already real; the first revert was too shallow).

| # | Mutation id | Sev | Hellgate file | Guards which fix | RED on revert? | Action |
|---|-------------|-----|---------------|------------------|----------------|--------|
| 1 | `t03-reducer-cancel-not-inert` | CRITICAL | `src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts` | T03 L5 C-1 — reducer `turn.cancel` is no longer an inert no-op (transitions state + emits `cancel_turn`) | YES | real |
| 2 | `t03-cancel-aborts-live-controller` | CRITICAL | kernel-cancel.hellgate | T03 — `turn.cancel` aborts the SAME signal the in-flight host turn observes (controller published under session id) | YES | real |
| 3 | `t03-r2h1-preregister-before-append` | HIGH | kernel-cancel.hellgate | **R2 H1** — controller pre-registered BEFORE the awaited event-log write, so a window `turn.cancel` reaches it (the bug that survived round 1) | YES | real |
| 4 | `t03-h8-aborted-signal-shortcircuit` | HIGH | kernel-cancel.hellgate | T03 H-8 — already-aborted `ctx.signal` short-circuits at the DISPATCH boundary | YES* | **strengthened test** (was blind) |
| 5 | `t03-m5-oncommitted-no-throw-sink` | HIGH | kernel-cancel.hellgate | T03 M-5 — a throwing `onCommitted`/observer must not redefine a completed turn into `turn.failed` | YES | real |
| 6 | `t03-lease-turn-scoped-clear` | HIGH | `src/host/runtime/internal/__tests__/approval-lease-isolation.hellgate.test.ts` | T03 L5 H-1 — an approved grant is cleared at turn-scope exit (no leak to a later turn) | YES | real |
| 7 | `t03-lease-fail-closed-shell-extract` | HIGH | approval-lease-isolation.hellgate | T03 L5 H-1 — a throwing `extractShellCommand` fails closed (forces a prompt, no broad tool-name grant) | YES | real |
| 8 | `t02-m2-strip-orphan-tool-use` | HIGH | `tests/unit/agent/turn-closeout-hellgate.test.ts` | T02 L1 M2 — refusal strips un-dispatched orphan `tool_use` blocks before persist | YES | real |
| 9 | `t02-h2-append-pending-tool-results` | HIGH | turn-closeout-hellgate | T02 L1 H2 — budget exhaustion at a tool turn appends the matching `tool_result` (no unmatched `tool_use`) | YES | real |
| 10 | `t02-h1-abort-classification` | CRITICAL | turn-closeout-hellgate | T02 L1 H1 — a mid-stream abort classifies as `aborted`, NOT `error`/RUNTIME_UNKNOWN | YES | real |
| 11 | `t05-c1-reuse-single-bump` | CRITICAL | historical V2 Stage1 store | Superseded 2026-07-19: the unconsumed duplicate store was deleted; canonical Phase 1 → Phase 2 owns the live path | N/A | removed |
| 12 | `t08-h1-destructive-reset-protected-branch` | HIGH | `src/permission/__tests__/fail-closed-base.hellgate.test.ts` | T08 L8 H1 — destructive `git reset` on a protected branch is DENIED even with no explicit ref | YES | real |
| 13 | `t08-h3-lexical-traversal` | HIGH | fail-closed-base.hellgate | T08 L8 H3 — lexical `..` traversal cannot escape an allow-root | YES** | **mutation fixed** (test was real) |
| 14 | `t08-h4-empty-writable-roots-deny` | HIGH | fail-closed-base.hellgate | T08 L8 H4 — empty `writableRoots` is DENY, not writable-anywhere | YES | real |
| 15 | `t08-h5-custom-host-mode-defer` | HIGH | fail-closed-base.hellgate | T08 L8 H5 — `custom` host mode is DEFER, never an implicit allow | YES | real |

`*`  — became RED only after the test was strengthened (see below).
`**` — became RED only after the *mutation* was corrected to the genuine pre-fix shape (see below).

## The two blind spots, in detail

### #4 `t03-h8` — a genuine TEST blind spot (test strengthened, production unchanged)

The H-8 hellgate (`cx-5`) asserted only `hostRan === false` for a pre-aborted
`ctx.signal`. There are **two** abort gates: the dispatch-level gate (the headline
H-8 fix — `turn.run` never reaches `runTurn`) and a second, inner gate inside
`runTurn` (it short-circuits an already-aborted turn controller). Reverting the
dispatch gate alone left `cx-5` green because the inner gate still set
`hostRan === false` — a defence-in-depth tautology. Either gate alone satisfied the
old assertion.

**Strengthening (kept at HEAD):** the dispatch gate settles the turn *without ever
entering the turn lifecycle*, so its event log carries ONLY a
`session.state.updated` echo. The inner fallback path emits `turn.started` and
`turn.failed` (via `onTurnAborted`). The hellgate now asserts the emitted event
types contain **neither** `turn.started` **nor** `turn.failed`, pinning the dispatch
gate specifically. Verified: green at HEAD, RED when the dispatch gate is reverted.

### #13 `t08-h3` — a mutation-targeting error (test was already real)

The fail-closed-base hellgate B-section *does* catch the genuine fail-open
(`/repo/../etc/passwd` granted under `/repo`). The first revert only swapped the
leading `resolve()` for raw strings — too shallow, because the downstream
`relative()` + `is-path-inside` BOTH resolve internally (defence in depth), so the
gate stayed green. The mutation was corrected to restore the true PRE-FIX shape (the
old raw byte-PREFIX `pathPrefixMatches`), which the hellgate catches immediately. No
test change was needed — only the proof-rail's revert was made faithful to the
actual pre-fix code.

## Takeaway

Both blind spots share the same root cause and reinforce the bugbash lesson:
**defence-in-depth makes single-gate reverts insufficient to prove a gate.** A
hellgate that asserts only the *end-state* (`hostRan===false`, "denied") can be
satisfied by a redundant downstream layer. The durable fix is to assert the
*distinctive path* of the specific fix (here: the exact event-log shape the dispatch
gate produces; the exact pre-fix string-prefix logic), not just the safe outcome.
The harness is wired into the encoded list so this stays a re-runnable proof rail.
