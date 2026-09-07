# Sep-06 final code audit — closed

> **Status:** COMPLETE — 0 active findings
>
> **Audit baseline HEAD:** `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd`
>
> **Audit baseline upstream:** `origin/main=01a8d8dd16f0b359494379512ddd00be51b7a9e7`
>
> **Final overlay check (2026-09-07):**
> `HEAD=origin/main=0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd`; shared checkout dirty
>
> **Authority:** current TypeScript production path and reachable consumer win over
> the 2026-09-06 prose snapshot.

The final audit retained four real findings from the prior 30-row draft. All four
are now implemented with owner-local regression rails. There is no remaining
Sep-06 implementation queue.

## Final disposition

| ID | Priority | Final status | Canonical repair | Proof |
|---|---:|---|---|---|
| N7 | P1 | resolved | `codexSpecRoute(kind) === "hitl_handoff"` is decisive `no_retry`; message markers cannot resurrect it | `tests/unit/retry-decorator-policy-hellgate.test.ts` |
| N12 | P2 | resolved | DAP decoder has fixed 64 KiB header and 32 MiB body ceilings with bounded resynchronization | `tests/unit/tool/debug/dap-codec.test.ts` |
| S8 | P2 | resolved | `src/shared/mention-text.ts` owns the trimmed first-line projection used by all seven consumers | `tests/unit/mention-first-line-parity-hellgate.test.ts` |
| S9 | P2 | resolved | lock acquisition failure returns typed non-durable and cannot enter read-merge-rename; failed latest writes remain retryable | `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts` plus the two-process permission/trust rails |

## Scope retired from implementation

The other 26 rows from the superseded audit remain closed, conditional, or
ratchet-only. Reappearance requires a new producer→contract→consumer reproduction
or an explicit SEP5-11 trigger. Grep counts, matching basenames, and generic
factory proposals are insufficient.

## Verification receipt

Implemented-source receipts:

```text
retry/recovery focused batch                         122 pass, 0 fail
retry/recovery expanded adversarial batch             266 pass, 0 fail
DAP codec/client/transport/debug_inspect batch        62 pass, 0 fail
mention shared-policy/resolver batch                  73 pass, 0 fail
permission lock + two-process contention batch        16 pass, 0 fail
bun run typecheck                                      exit 0 (114864 ms)
bun run typecheck:all                                  exit 0 (15108 ms, final incremental)
bun run lint && bun run lint:debt                      exit 0
all slice-boundary + parity + god-code batch           593 pass, 0 fail
bun run test:contract                                  13 pass, 0 fail
bun fc validate && bun fc build && bun fc diff         exit 0, no drift
```

The final re-audit strengthened two proof rails: the mention guard now discovers
the complete live-call population through the TypeScript AST, excluding
comments, strings, and unused imports, and proves that a comment-only fake call
cannot hide a deleted consumer; the DAP header test now distinguishes the
bounded decoder from the old unbounded implementation. It
also removed an obsolete 16-kind/7-marker expectation that produced five real
failures under the corrected HITL policy.

The shared checkout retained pre-existing unrelated dirty work, so it was not
used as an authoritative receipt source. Its exact overlay was copied into a
clean detached verification worktree without stashing, resetting, or rewriting
the shared checkout. On that clean snapshot, `bun run test:ci` passed all 21
gates over the exact 3,852-file discovered corpus.

The clean closeout was not rubber-stamped. It first exposed and repaired nine
additional repository-wide defects:

- the new shared mention owner and AST parity hellgate were absent from feature-
  catalog evidence;
- D8 had moved to the closed register while the audit index and SEP5 enrollment
  expectations still described the old conditional state;
- `QUANTA_BENCH_SUBMIT_REVIEW` and `QUANTA_BENCH_VOTE_NORMALIZE` had live
  production reads but their knob schemas had been removed;
- PTY pending-output tail truncation used `slice(-bytes)` and could split a
  UTF-16 surrogate pair;
- the preload closure meta-test created visible temporary directories under the
  discovered `tests/` tree, invalidating concurrent shard snapshots;
- the live web usage E2E hard-coded a 30-second Bun test limit, bypassing the
  authoritative runner's bounded host-pressure timeout scale.
- the transcript-retention E2E still expected `Sweep complete.` for an
  in-memory/no-durable-backend cleanup, contradicting ADR-0379's honest
  no-backend result.
- the mention AST hellgate's `Bun.Glob` patterns were rooted in the ambient cwd,
  so a foreign-cwd runner could inspect the wrong tree; the scan root now derives
  from `import.meta.dir`.
- the PTY escape hellgate treated unknown pre-existing scrollback as public, and
  the fail-closed redaction placeholder could reintroduce terminal controls via
  its hostile origin label; the contract now pins whole-source redaction and the
  redaction owner sanitizes that label before rendering it.

Each defect was repaired at its owner or proof rail and re-run locally before
the final whole-CI receipt. No active Sep-06 implementation row remains.
