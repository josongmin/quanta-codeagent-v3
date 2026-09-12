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
(child). The child holds **608 open handles**:

| type | count |
|---|---:|
| DIR | 590 |
| unix | 8 |
| REG | 5 |
| KQUEUE | 3 |

The 590 directory handles cover the source tree — 360 under `src/`, 212 under
`node_modules/`, 10 under `tests/` — and every path appears **twice**. The count
is stable: measured at t+10s, t+20s and t+30s it was 608 each time, so this is
not an active leak but a set that is opened and never released.

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

## Next step for whoever picks this up

Find what opens two handles per source directory on a `--isolate` test worker.
Candidates worth eliminating in order: a preload (`tests/preload-clean-source-js.ts`,
`tests/setup.ts`), the module resolver's directory scan, and any `fs.watch` in
the tool surface. The reproduction is a full prepush campaign at low load; it hit
chunks 27 and 38 simultaneously on this run, and chunk 38 twice in three runs.
