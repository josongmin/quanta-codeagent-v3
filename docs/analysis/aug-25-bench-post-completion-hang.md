# The bench process finishes its work and then spins forever

**Status:** measured, NOT fixed. Outside the ProMax lane; recorded so the evidence
is not lost with the box that produced it.

## What was observed

While the first end-to-end ProMax box grade was blocked, I ssh'd into the live
box rather than inferring from the log:

```
PID 4826  Rl  19:48 elapsed  69.7% CPU  (no children)
~/run.exit                  : No such file or directory
~/report.json, ~/preds.jsonl: both written
run.log tail                : "passed 0/0 (7 degraded)"
                              "tokens 10801042 in + 48853 out | est. cost $6.5207 | 7/7 instances"
                              "failures: grader_invalid=7"
```

So the run COMPLETED — every instance graded, artifacts written, final summary
printed — and the process then spun at ~70% CPU with no children, twenty minutes
in. `STAT=Rl` and an empty `WCHAN` say it is running, not blocked on I/O.

The box's wrapper is `setsid bash -c "<benchCmd> > run.log 2>&1; echo $? > run.exit"`,
so `run.exit` lands only when the bench returns. It never did.

## Why it matters beyond ProMax

`detached-poll.ts`'s completion probe accepts EITHER `run.exit` OR a fallback —
"report.json parses AND preds.jsonl is non-empty":

```
if [ -s run.exit ]; then cat run.exit;
elif <report parses> && <preds non-empty>; then echo 0; fi
```

That fallback exists BECAUSE of this hang. It is a workaround, and it has a real
cost: on that branch the run's exit status is never established, so a caller
cannot tell "finished cleanly" from "finished and wedged". ProMax cares because
its grader phase must not materialize the answer key beside a live agent; other
callers care because the exit code is simply lost.

It is NOT deterministic: a later run on the same code exited on its own within
seconds. So it is a race in the shutdown path, not a constant.

## What was NOT done

No fix. The cause is in the run's own shutdown — a non-daemon timer, an
unresolved promise, or a spinning flush keeping the loop alive after the last
instance — and finding it means instrumenting the bench's teardown, which is a
different subsystem from the lane this work was building.

ProMax no longer depends on the exit happening: after a short grace it ENDS the
process and re-verifies it is gone before materializing anything
(`box-session/family-box-grade.ts`). That is a containment, not a repair.

## Where to start

- `src/apps/bench/remote/box-session/detached-poll.ts` — the fallback and why.
- The bench's own teardown after the last instance: trace/OTel export flush,
  sandbox cleanup, any interval or keep-alive that outlives the run.
- Reproduce with 7 instances (it did not appear on smaller local runs), and read
  the live process rather than the log: `ps -o pid,stat,wchan -p <pid>` plus a
  stack sample is what separated "blocked" from "spinning" here.
