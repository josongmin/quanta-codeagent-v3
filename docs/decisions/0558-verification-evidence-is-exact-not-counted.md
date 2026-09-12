# ADR-0558 — Verification evidence is an exact set, never a count

Status: Accepted (2026-09-12)
Slice: `tools/dev/executed-file-set.ts` (new) · `tools/dev/scan-reach-authority.ts` (new) · `tools/dev/lease-quarantine.ts` (new) · `tools/dev/failure-attempt-producer.ts` (new) · `tools/dev/run-test-shards.ts` · `tools/dev/test-shard-receipt.ts` · `tools/dev/scan-reach-baseline.ts` · `tools/dev/verification-required-producers.ts` · `tools/dev/test-shard-lease.ts` · `tools/dev/gate.ts` · `tools/dev/verification-tier.ts` · `tools/dev/verification-matrix.ts` · `tools/dev/verification-receipt-probe.ts`
Feature: `sep12-verification-hardening`
Related: ADR-0503 (knob registry — the same "declared but unreachable" shape) · SEP9 (`sep9-verification-optimization`, which gave these rails their vocabulary)
Hellgate: `tests/unit/dev/executed-file-set.test.ts` · `tests/unit/dev/lease-quarantine.test.ts` · `tests/unit/dev/failure-attempt-producer.test.ts` · `tests/unit/_arch/scan-reach-cli-hellgate.test.ts` · `tests/unit/dev/required-producer-exactness.test.ts`

## Context

Every rail in this repository's verification stack answered its question with a
NUMBER, and each number was satisfiable without the thing it stood for.

- A chunk was accepted when `result.executedFiles === plan.files.length`. Chunk
  36 of this tree plans 146 files; a worker that ran 146 of somebody else's
  exited 0, minted a timing observation, and wrote a reusable cache receipt
  asserting the planned set had passed. The receipt recorded the PLAN and never
  the execution, so nothing downstream could tell.
- A scan-reach receipt was accepted when `manifestSha256.length !== 64`. Any 64
  hex characters passed. `suite` sat in the type and was never compared; there
  was no `tier` at all, so `--suite=full --tier=pr` — 3,941 of 3,965 files at this HEAD —
  minted a receipt the closed-universe consumer accepted. scan-reach is a FLOOR
  ratchet, so a narrower population reports lower reach for ids it never walked.
- A capability lane cleared `1 executed file, 1 executed case`. A `toolchain`
  job where sixteen of seventeen files skipped and one cheap case ran satisfied
  it, and `required` went green over a lane that proved almost nothing.
- A campaign that could not account for its workers printed "refusing to bless
  this run" and then called `lease?.release()` unconditionally. The verdict was
  honest; the handoff was not.

Each of these had a correct implementation sitting beside it, unused.
`gate-dag.ts`, `bounded-child.ts` (whose docstring names `gate.ts`),
`capabilityProducerFloors()` (documented as "the per-group numbers the
fanned-out jobs should carry instead"), `hostCapabilityFingerprint` and the
failure-artifact PRODUCER were all complete, all documented in the past tense as
though wired, and all had zero production consumers.

## Decision

1. **Execution is proved by the exact file set, from the worker's own JUnit.**
   `executed-file-set.ts` is the single owner for both the local shard runner
   and the matrix worker, which previously disagreed — one compared a sorted
   join, the other a length, and they normalised paths differently. Three
   failure kinds are named separately (missing / unexpected / duplicate) because
   a boolean sends someone to re-run 44 chunks blind.

2. **A cache receipt stores the ids and a digest OF those ids** (schema v3 → v4),
   so a HIT restores a checkable verdict rather than a tally, and a v3 receipt
   misses instead of being coerced into a claim it never made.

3. **A scan-reach receipt carries the population it describes and the consumer
   RECOMPUTES it** — suite, tier, membership, tier-policy and capability digests,
   derived from the tree at read time. A narrowed tier cannot mint one at all:
   evidence about a different population is not weaker evidence.

4. **Capability floors are derived from the manifest, per GROUP.** pty 8/8,
   toolchain 10/14, contract 5/5. Groups are checked before totals, because a
   total is satisfiable by over-running one group while another never starts.

5. **A lane that cannot be accounted for is HELD, not handed on.** Not
   releasing is not the fix — the lease is a TCP listener and the kernel frees
   the port on exit — so a quarantine record is written BEFORE the release and
   consulted by acquisition. Liveness is re-derived from the SURVIVORS on every
   read, so a dead keeper cannot strand the lane and a live one cannot hold it
   after the groups exit.

6. **An inherited lease is proved by the owner, not by shape.** The owner's
   listener issues the token and answers for it, which closes fabrication,
   replay and rebind at once. A live ancestor is necessary and not sufficient.

7. **Every top-level child is bounded by one primitive**, with the 12-minute
   inactivity bound the shard watchdog already used and a 4-hour backstop above
   every legitimate campaign observed here. There is one scheduler, not two.

   This claim was first written while the guard behind it banned two SPELLINGS
   rather than the call: `Bun.spawnSync({…})` and `await proc.exited`. Nine
   sibling captures in the same rails — `gate.ts`'s own `git` reads, the matrix
   CLI's `proc.exited` inside a `Promise.all`, the unit-speed-budget re-run, the
   scan-reach harvest — were unbounded when the sentence was written, and the
   guard now bans the call across ten rails. "Every" is load-bearing, and it took
   an adversarial audit to make it true.

8. **A tier is stated, never assumed.** An absent tier used to select the whole
   universe, and which population a command ran depended on an ambient
   environment variable. Both are refused now.

## Consequences

The first campaign run under these rules found, in nine runs, one test file
whose tests were deleted in June and which every campaign since had planned into
a chunk; twelve failing cases across three files whose stubs answered a
readiness probe with a sentinel from an earlier contract; a `bun build` scratch
file that invalidated a campaign and vanished before anyone could look; and a
pair of pty tests where one asserted the wrong thing and its sibling passed
vacuously. None were introduced by this work. A count could not have seen any of
them.

The inactivity watchdog also fired for the first time, on a Bun worker stall
this repository records as unresolved: 720,701ms against a 720,000ms ceiling.
The stall is not fixed. It is bounded, attributed, and no longer able to hang a
campaign indefinitely — which is the difference this ADR is about.

## Alternatives considered

- **Raise the counts instead.** A bigger number is satisfiable by a bigger wrong
  set. The defect is the comparison, not its threshold.
- **Trust the receipt's own digests.** A receipt that carries its own authority
  certifies itself. Recomputation costs one filesystem snapshot (measured 45ms)
  and is the whole difference between a check and an echo.
- **Skip `release()` on a failed drain.** Measured to be inert: the kernel frees
  the listener when the process exits, so the lane is free either way.
- **Wire the DAG scheduler at concurrency > 1 now.** Every gate drives a real
  toolchain, no gate declares the `resources` the scheduler needs, and this
  repository has a measured scar about contention producing a differently TIMED
  wrong answer. Concurrency stays 1 until gates declare what they hold.

  A self-audit caught this sentence resting on an accident. Raising the width DID
  break two tests, and both were about fail-fast ORDERING — neither mentioned
  concurrency, so the next person to see them go red would have been right to
  explain them away. `tests/unit/dev/verification-tier-runner.test.ts` now names
  the interlock and it bites in BOTH directions: raising the literal fails one
  arm, and a gate gaining `resources` fails the other, which is the promotion
  condition asserted rather than described. A third arm proves the `1` is
  load-bearing — the same two-gate graph overlaps at width 2 and does not at
  width 1 — so the serial behaviour cannot be mistaken for a scheduler that
  never overlaps anyway.
