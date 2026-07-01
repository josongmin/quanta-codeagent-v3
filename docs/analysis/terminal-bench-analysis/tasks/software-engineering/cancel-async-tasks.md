---
task: cancel-async-tasks
category: software-engineering
difficulty: hard
tags: [async, concurrency, python]
expert_min: 120
junior_min: 600
skill_class: CODE-AUTHOR
terminal_native: low
docker_image: alexgshaw/cancel-async-tasks:20251031
---

# cancel-async-tasks

**Goal** — Implement `async run_tasks(tasks, max_concurrent)` in `/app/run.py` that runs async jobs with a concurrency cap AND, on KeyboardInterrupt (SIGINT), still lets each *started* task's cleanup (finally) code run before exiting.

**Solution shape** — Tiny (~18-line) `run.py`. Uses an `asyncio.Semaphore(max_concurrent)` to bound concurrency and an `asyncio.TaskGroup` to schedule all tasks; a helper acquires the semaphore then awaits the task. The TaskGroup is the crux — it propagates cancellation correctly to running tasks (unlike `asyncio.gather`, which the tests specifically call out as a gotcha) so `finally`/cleanup blocks execute on interrupt.

**Verifier** — pytest driving `test.py` (each task sleeps 2s, cleans up 1s): checks concurrency (2 tasks/2 concurrent finish within 5s), the cap (2 tasks/1 concurrent takes >=6s), and four SIGINT-mid-run cases (below/at/above max_concurrent) where only the *started* tasks run and every started task must print "Cleaned up." — i.e. cancellation must not skip cleanup. reward binary 0/1.

**Difficulty drivers** — Subtle asyncio semantics: correct concurrency limiting *and* correct cancellation-with-cleanup under SIGINT. The common traps (raw `gather` leaving queued tasks, ThreadPoolExecutor not propagating cancellation, tasks above the cap starting anyway) are exactly what the tests probe. Timing assertions and signal handling make it easy to pass some cases and fail others.

**quanta attack points** — Pure authoring task: `container_exec` to write `run.py` and run pytest; no interactivity. Main failure risk: choosing a primitive (gather/threads) that doesn't propagate cancellation, so cleanup is skipped on interrupt, or getting the semaphore/TaskGroup interaction wrong so extra tasks start. The exit-code loop is a strong fit — the multi-case timed test suite gives crisp pass/fail per scenario, letting the agent iterate toward the TaskGroup+semaphore shape the tests demand.
