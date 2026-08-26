# The ProMax lane's defect classes: one missing test class, five faces

**Status: A, B, C, E structurally closed with ratchets. D closed per-instance
only. Two items deliberately out of scope, named at the end.**

Eleven fixes landed in one audit pass. Treating them as eleven bugs would mean
auditing again next time. Grouped by what the failing code had in common, they
are five generating classes — and four of the five are the same shape.

## The symptom that started it

`image-provenance.ts` quoted a Python program with `JSON.stringify`. The source
reached the box as one double-quoted line with literal `\n`, the interpreter
raised a `SyntaxError`, and the pipeline still exited 0. Empty stdout made every
assigned instance an image fault, which REFUSES the grade. Every ProMax grade
since `7fa0263e7` was discarded for a reason that was ours.

It had tests. They asserted the STRING the builder returned.

## The classes

### A — the string was read, never run

`image-provenance` (above); the grader-container probe passing when docker was
ABSENT, because `test -z "$(docker …)"` discards the child's status; two `sh -c`
steps interpolating their paths unquoted.

All three read correctly as text. All three were wrong the instant a shell
parsed them. These commands' correctness lives on the far side of a process
boundary — ssh, shell, python, docker — and every test lived on the near side.

The gap was total, not partial. The ANSWER-KEY ABSENCE PROBE, the one command
the entire gold boundary rests on, had never been executed by anything; its
tests drove fake ssh functions that answered whatever the fixture said.

**Closed by** `_bootstrap-exec-harness.ts` + `promax-bootstrap-steps-execute.test.ts`:
render with the real renderer, execute under a real bash, plus two properties
over the whole plan (every declared argv round-trips unmangled; a campaign root
named `$(…)` is carried as data) and a classification guard derived from the
live plan, so a new step cannot land unclassified.

### B — declared statically, and the runtime that runs never enforces it

- `} as Parameters<typeof buildProMaxOfficialGradeReceipt>[0])` in `promax.ts`
  made a port mismatch compile: image digests were captured, given the power to
  FAIL a run, and dropped on the floor.
- `process.on("exit", …)` cleanup in nine test files — bun test never fires it.
  790 leaked directories from one file.
- `const shape: keyof RelaunchOutcome = "errored"; expect(shape).toBe("errored")`
  — `bun test` does not typecheck, so the annotation carrying the whole claim
  was never evaluated by anything that ran.

**Closed by** `promax-port-contract-unsuppressed.test.ts` (no type suppression
inside the port-contract directory) and `test-fixtures-do-not-leak-tmp.test.ts`
(no exit-hook cleanup in any test file).

### C — the rail is asserted where it is DEFINED, not where it is USED

The SSOT-mirror skip tested the predicate, not the transport. The receipt's
digest was compared against the constant the code reads. The receipt was never
checked to reach a file.

And one that was still live when the RCA found it: `prepareBoxGradePredictions`
had a thorough port test and no consumer test. Changing the consumer to write
`predictionsText` instead of `prepare(predictionsText)` — handing the pinned
evaluator exactly the JSONL the port exists to eliminate — left all 916 tests in
the directory green.

**Closed by** consumer-side proofs: real transport + real sink for the mirror,
a non-snapshot digest driven through the plan, the persist seam extracted and
its written file read back, and the predictions bytes read off the wire.

### D — the message asserts a cause or a count the code does not have

"survived being ended" without giving the process time to die. "exhausted 2
attempt(s)" when one ran. `LOST N (box-loss)` for a configuration refusal, one
line after the log that said it was not box loss.

**Closed per-instance only.** No mechanical guard was built: the honest form of
"a claim must be licensed by what was measured" is not something a regex knows,
and a guard that pretended otherwise would be worse than none.

### E — the fixture's match is broader than the thing it models

`if (cmd.includes("$HOME"))` was written for the home probe and also matched
`"$HOME"/.local/bin/uv venv …`. Seven files had copied it, so a grader phase
that stopped building its interpreter environment reddened nothing anywhere.

The duplication is the mechanism: five to twelve `includes` branches per file,
copied, so a single modelling error was replicated rather than caught.

**Closed by** `_fake-box.ts` — the branches once, as an ordered table, each row
matching the one command it models. All seven files migrated.

## The second-order cause

Every class above is a boundary the tests stopped short of. The only thing that
ever crossed those boundaries was a paid EC2 run, so the cheapest feedback loop
available for this lane's correctness was also the most expensive one that
exists. That is why the signature is eight live runs each surfacing exactly one
boundary defect.

## What is measured, not claimed

Every fix above was verified by red-on-injection, and the audit rounds recorded
their own failures:

- per-step behavioural scenarios missed unquoted-path and mangled-flag
  injections outright — a tame `mkdtemp` path cannot tell a quoted step from an
  unquoted one. That is what the two plan-wide properties are for.
- the execution ledger proves "a shell ran this step", NOT "its effect is
  asserted": deleting a scenario stays green, because the round-trip property
  spawns every step anyway. The comment in that file says so rather than the
  flattering reading.
- `df -Pk`'s `-P` is DECLARED, not executed. What POSIX mode buys is one row for
  a long device name and no local filesystem produces one; dropping the flag left
  every execution assertion green.

## Deliberately out of scope

- **The bench post-completion hang.** The kill ladder is a workaround: the agent
  finishes its work, writes its artifacts, and then spins (measured on a real
  box — PID 4826, `Rl`, 69.7% CPU, no children, `run.exit` absent, twenty
  minutes in). Root cause is outside this lane.
- **The repo-root fixture leak** (`src/x.ts`, `rel.txt`, `round.txt`). Same
  containment-not-attribution shape as the `/tmp` leak closed here, and already
  investigated in `aug-24-repo-root-fixture-leak-investigation.md`. Its stated
  blocker — the sandbox runner dropping bun's flags — was removed by another
  session while this pass was running, and that lane is theirs.

---

# Corrections (round 3 of the adversarial audit)

The third round checked the falsifiable claims in this document and in every
commit message of the campaign, by re-running them. Nine did not survive. Two
were live defects and are fixed; the rest are wording, corrected here because
commit messages are immutable and a wrong number in one is worse than none.

**Live, and fixed.**

1. `stripComments` was described as "shared by both" guards. It was not — there
   were two copies, the leak guard got the quoting-aware scanner and the
   port-contract guard kept the two-regex version. So the very evasion that
   commit claimed to close still worked: three lines in the port directory (a
   string holding a comment opener, an `as any`, a string holding a closer) left
   the guard green. There is now ONE scanner, in `tests/unit/_shared/`, and both
   import it.
2. "Now: every registration spelling" was false for bracket form —
   `process["prependListener"]("exit", …)` passed. Widened, and the
   anti-vacuity cases now name each spelling.

**Wording, corrected.**

3. "corrected to ninety" (the port-guard scope figure) — that edit was never
   made; the paragraph still said "nine". Measured with the file's own detector
   it is 258 of 3319 non-test files. The paragraph now says so, and says the
   rationale rests on what those sites are, not on how few.
4. "Both were zero before this campaign" (venv-step and gold-probe injections) —
   they were 4 and 6, not 0. The improvement is real; the baseline was not zero.
5. "left 920 tests green" — the directory held 940 at that commit. 920 was the
   count two commits earlier.
6. "Three `if (… === undefined) return` guards removed" — two were; the third
   survived until `cb3f986f0`, which is the one that commit reports fixing.
7. "Every assertion is against the SERIALIZED document, never a value in
   memory" — the refusal cases assert on the in-memory build result, which is
   correct (a refused build produces no document) but is not what the sentence
   says.
8. "the consult runs at line 597, the gate at 612" — the gate call is 611.

**Class B is downgraded.** This document called it "structurally closed with
ratchets". Round 3 defeated both of its guards, and correction 1 is why. Closed
now, on the evidence above — but the claim was ahead of the evidence when it was
written, which is the same defect class the document names in section D.
