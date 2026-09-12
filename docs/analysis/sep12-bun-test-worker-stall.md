# The `bun test` worker stall, observed and measured

2026-09-12. Captured live, from two workers stalled simultaneously during a
prepush campaign at load 7.

This defect is recorded in this repository's memory as **unresolved after 12
failed reproduction attempts outside a campaign**. It is still unresolved. What
follows is evidence, not a fix — written down because every previous encounter
ended with the process killed and nothing kept.

## What a stall looks like from outside

```
[test:shards] PROGRESS chunk=38/44 class=pure elapsed=540s spool_bytes=3664
[test:shards] TIMEOUT  chunk=38/44 inactive: nothing written for 720701ms
              (ceiling 720000ms); killing worker process tree.
```

The spool stops growing and never grows again. Every prior sample is identical,
which is what made "is it slow or is it hung" unanswerable before the watchdog.

## The main thread is parked, not spinning

`sample` over 2 seconds, 1607 samples, every one in the same frame:

```
1607 Thread … DispatchQueue_1: com.apple.main-thread  (serial)
  1607 start (in dyld) → … → 1607 kevent64 (in libsystem_kernel.dylib)
```

`kevent64` with the process's own kqueues reporting `count=0, state=0x12`. The
event loop has nothing queued and nothing pending will deliver. This is not a
busy loop, a deadlocked mutex, or a slow test — it is a loop waiting for an
event that does not exist.

## What keeps the process alive

The worker pair is `bun test` (parent) and `bun test --test-worker --isolate`
(child). The child held **608 open handles**, of which these types were
tabulated at the time:

| type | count |
|---|---:|
| DIR | 590 |
| unix | 8 |
| REG | 5 |
| KQUEUE | 3 |

> **These breakdowns are PARTIAL, and an audit caught them being presented as
> complete.** They sum to 606 of 608; the directory split below sums to 582 of
> 590. No `lsof` output was retained, so the missing 2 handles and 8 directories
> cannot be re-derived — the rows above are what was transcribed, not the whole
> table. Keeping the raw output was the thing to do and was not done.
>
> The load-bearing observation does not depend on the exact totals: an isolated
> worker holding **~590 open directories** after its files have finished is the
> anomaly, and it is two orders of magnitude past what any test in the set opens.
> The precise count is what a fix would be measured against, and that number
> will have to be re-taken.

The directory handles cover the source tree — 360 under `src/`, 212 under
`node_modules/`, 10 under `tests/` — and every path appears **twice**. The count
was stable: read at t+10s, t+20s and t+30s it was 608 each time, so this is not
an active leak but a set that is opened and never released.

Three of the unix sockets are the child's stdin/stdout/stderr, connected to the
parent. The child ALSO holds the same two socket peers at fds 578 and 215 — the
same endpoint open three times.

## What this rules in and out

- **Not a test that runs forever.** No CPU, no progress, and the last spooled
  lines are ordinary completed files.
- **Not the watchdog misreading a slow chunk.** `spool_bytes` is byte-identical
  across twelve consecutive 60-second samples.
- **Consistent with a loop kept alive by registered handles after the work is
  done** — the shape a directory watcher or an unclosed pair produces. 590 open
  directories on a `--isolate` worker is the anomaly to explain.

## What the campaign changed

Nothing about the stall. What changed is that it is now BOUNDED and ATTRIBUTED:
a 12-minute inactivity ceiling ends it, the kill names which bound fired, and
the campaign reports a timeout rather than hanging until someone notices. The
720,701ms figure above is the first time that bound has ended anything.

## REPRODUCED outside a campaign

Memory records 12 failed reproduction attempts. This one works, and it is
`docs/analysis/sep12-stall-repro-set.txt` — 39 files, bisected down from chunk
38's 158:

```
bun test $(cat docs/analysis/sep12-stall-repro-set.txt | tr '\n' ' ') \
  --timeout=120000 --parallel=8 --isolate --preload ./tests/setup.ts
```

### What the bisection found

| set | width | isolate | result |
|---|---|---|---|
| 158 (chunk 38) | 8 | yes | stalls |
| first 79 | 8 | yes | 1008 pass |
| last 79 | 8 | yes | stalls |
| first 39 of those | 8 | yes | **stalls** |
| first 19 of the 39 | 8 | yes | 467 pass |
| last 20 of the 39 | 8 | yes | 467 pass |

**Neither half of the 39 stalls alone.** It is not one bad file: it is a
COMBINATION, which is why single-file reproduction attempts have always failed.

### The two dimensions that decide it

| configuration | result |
|---|---|
| `--parallel=8 --isolate` | stalls |
| `--parallel=1 --isolate` | 467 pass |
| `--parallel=8` (no isolate) | 467 pass |

Both are required. A serial run of the same files passes, and a parallel run
without worker isolation passes.

### Rate — OBSERVED, not established

One stall was observed across six consecutive runs of the same 39 files at
`--parallel=8 --isolate`. That is the observation; it is **not** a rate, and an
audit was right to say so:

- No run log, timing or artifact was retained, so the six runs cannot be
  re-counted from anything but this sentence.
- Runs at `--parallel=2`, `4` and `8` happened in the same session — one stall at
  width 2 — so the denominator for any single configuration is not recorded.
- Every row in the bisection table above is a SINGLE observation. If the true
  rate is near one in six, a single pass has roughly an 83% chance even for a
  configuration that does stall. So "neither half of the 39 stalls alone" and
  "both dimensions are required" are stated with more confidence than one
  observation each can carry.

What the evidence does support: the combination stalls at least sometimes, a
serial run of the same files completed, and the failure is not a slow test (see
the kqueue evidence above, which is a direct observation of one stalled process).

What would settle it: N runs per configuration with each run's exit status,
duration and `lsof`/`sample` output retained, on a QUIET box. This box has not
been quiet — measured load average 29.4 with another session's `bun test`
campaign running in a worktree while this note was being corrected — and a
stall-rate measurement taken under foreign load would be its own false number.
That is the same rule this campaign applies to performance ABBA, applied to a
failure rate.

The honest reason this was not reproduced for twelve attempts remains: those
attempts used single files, and the combination is what matters.

## Next step for whoever picks this up

The handle evidence and the race evidence point the same way: an isolated worker
finishing its files while a peer is mid-flight. Find what opens two handles per
source directory on a `--isolate` worker and whether the last worker to finish is
the one that cannot exit. Candidates in order: the module resolver's directory
scan, `fs.watch` in the tool surface, and the worker teardown path in Bun
itself.
