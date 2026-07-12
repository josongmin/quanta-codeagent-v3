# C5059-06 — Wall-clock awareness and durable wait

- **Priority:** Backlog
- **Class:** CONDITIONAL GAP
- **Effort:** M
- **Status:** NEED NOT PROVEN
- **Dependencies:** observed long-unattended agent run or deadline/polling failure

## Reopen triggers

At least one must exist in current trajectories:

1. an agent waits for an external event beyond a normal tool timeout;
2. absence of current time/elapsed time causes missed deadlines or wasteful polling;
3. execution must survive worker/process restart while waiting.

Shell-level campaign polling alone does not satisfy the trigger; that is supervisor-owned today.

## Required split

### Short bounded sleep

- Seconds-scale only.
- Injected `ClockPort` + `TimerPort`.
- Abort/new-input wakeup and actual elapsed duration in the typed result.
- Host-configured upper bound; no raw unbounded `setTimeout`.

### Durable wait

- Minutes-to-days or restart-surviving waits.
- Persist deadline, wake reason, session/run id, and checkpoint before releasing the worker.
- Resume from an event/timer receipt; do not hold an agent turn or process while asleep.
- Idempotency key required so resume/retry cannot duplicate side effects.

## Time reminder

- Keep monotonic elapsed time separate from wall-clock timestamp/timezone.
- Inject only for deadline/polling tasks and only after the configured interval.
- Use the existing dynamic reminder channel so the static prompt-cache prefix remains stable.
- Replay uses injected clock values; no hidden `Date.now()` in pure logic.

## Acceptance if reopened

- Fake-timer tests use zero real sleep.
- Short sleep wakes early on input/abort and returns measured elapsed time.
- Durable wait survives simulated worker termination and resumes once.
- Duplicate wake delivery is idempotent.
- Prompt-cache/static-prefix snapshot is unchanged.
- Finite-turn benchmark surfaces do not expose the tools by default.

## Kill rule

If all observed waiting remains supervisor-owned or within existing handle-await tools, close without implementation.

