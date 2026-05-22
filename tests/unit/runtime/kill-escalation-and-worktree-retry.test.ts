import { describe, expect, test } from "bun:test"
import type { ShellResult } from "@/runtime"
import {
  escalatingKill,
  isTransientWorktreeLockError,
  KILL_GRACE_MS,
  MAX_WORKTREE_LOCK_RETRIES,
  runWorktreeAddWithRetry,
} from "@/runtime"

describe("escalatingKill — SIGTERM→SIGKILL escalation", () => {
  test(
    "(a) a child that traps/ignores SIGTERM is SIGKILLed after the grace window",
    async () => {
      // `trap '' TERM` makes the child ignore SIGTERM entirely, then it sleeps
      // far longer than the test budget. Without escalation it would survive
      // the polite kill and run to natural completion.
      const proc = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 30"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      const startedAlive = proc.killed === false
      expect(startedAlive).toBe(true)

      const { kill, disarm } = escalatingKill(proc)
      kill() // sends SIGTERM now, arms SIGKILL after KILL_GRACE_MS

      // The polite SIGTERM is ignored, so the child is still running shortly
      // after we asked it to stop — proving plain `proc.kill()` is insufficient.
      await Bun.sleep(Math.floor(KILL_GRACE_MS / 4))
      expect(proc.exitCode).toBeNull() // still alive: TERM was trapped

      // After the grace window the escalated SIGKILL reaps it. Bun resolves
      // `proc.exited` once the child is gone; await that with a generous margin.
      const exitCode = await proc.exited
      // SIGKILL is not catchable, so the child is definitively gone.
      expect(typeof exitCode === "number").toBe(true)
      expect(proc.killed).toBe(true)
      disarm()
    },
    KILL_GRACE_MS + 10_000,
  )

  test("a well-behaved child exits on SIGTERM before the grace fires (no SIGKILL, timing unchanged)", async () => {
    // Default disposition: SIGTERM terminates this child immediately.
    const proc = Bun.spawn(["bash", "-c", "sleep 30"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    const { kill, disarm } = escalatingKill(proc)
    const t0 = Date.now()
    kill()
    await proc.exited
    const elapsed = Date.now() - t0
    // It died on the polite TERM, well before the 2s grace would have fired —
    // escalation never changes well-behaved-child timing.
    expect(elapsed).toBeLessThan(KILL_GRACE_MS)
    disarm()
  })

  test("disarm cancels the pending SIGKILL timer (no leak after the child exits)", async () => {
    // A child that exits on its own; we still arm the grace timer via kill().
    const proc = Bun.spawn(["bash", "-c", "sleep 30"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    const { kill, disarm } = escalatingKill(proc)
    kill()
    await proc.exited
    // disarm() is idempotent and safe after exit; the proc.exited handler also
    // clears the timer, so this must not throw or double-clear.
    expect(() => {
      disarm()
      disarm()
    }).not.toThrow()
  })
})

describe("isTransientWorktreeLockError — transient-only matcher", () => {
  test("matches the git lock-contention strings", () => {
    for (const s of [
      "fatal: Unable to create '/repo/.git/index.lock': File exists.",
      "fatal: '/repo/.git/worktrees/agent-x/locked' is already locked",
      "error: cannot lock ref 'refs/heads/foo'",
      "Unable to create '/repo/.git/worktrees/abc/HEAD.lock': File exists",
    ]) {
      expect(isTransientWorktreeLockError(s)).toBe(true)
    }
  })

  test("does NOT match genuine (non-lock) failures", () => {
    for (const s of [
      "fatal: invalid reference: nope",
      "fatal: 'foo' is already checked out at '/elsewhere'",
      "fatal: not a git repository",
      "error: No space left on device",
    ]) {
      expect(isTransientWorktreeLockError(s)).toBe(false)
    }
  })
})

describe("runWorktreeAddWithRetry — bounded retry on transient lock errors", () => {
  const ok: ShellResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false }
  const lockFail: ShellResult = {
    stdout: "",
    stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    exitCode: 128,
    timedOut: false,
  }
  const hardFail: ShellResult = {
    stdout: "",
    stderr: "fatal: invalid reference: deadbeef",
    exitCode: 128,
    timedOut: false,
  }

  /** Build a fake `git` runner that returns scripted results per call, and
   *  records every command it saw. */
  const fakeGit = (script: ShellResult[]) => {
    const calls: string[] = []
    let addIdx = 0
    const git = async (_repo: string, args: string): Promise<ShellResult> => {
      calls.push(args)
      // `worktree prune` (idempotency cleanup) always "succeeds"; only the
      // `worktree add` calls consume the scripted sequence.
      if (!args.startsWith("worktree add")) return ok
      return script[addIdx++] ?? ok
    }
    return { git, calls }
  }

  test("(b) retries on a simulated lock error, then succeeds", async () => {
    const { git, calls } = fakeGit([lockFail, lockFail, ok])
    const r = await runWorktreeAddWithRetry(git, "/repo", "worktree add x", "/repo/x")
    expect(r.exitCode).toBe(0)
    const addCalls = calls.filter((c) => c.startsWith("worktree add")).length
    expect(addCalls).toBe(3) // failed twice, succeeded on the third
    // Idempotency cleanup ran between attempts.
    expect(calls).toContain("worktree prune")
  })

  test("a NON-lock failure is NOT retried — fails immediately", async () => {
    const { git, calls } = fakeGit([hardFail, ok, ok])
    const r = await runWorktreeAddWithRetry(git, "/repo", "worktree add x", "/repo/x")
    expect(r.exitCode).toBe(128) // returned the hard failure as-is
    const addCalls = calls.filter((c) => c.startsWith("worktree add")).length
    expect(addCalls).toBe(1) // exactly one attempt, no retry
    expect(calls).not.toContain("worktree prune")
  })

  test("retries are bounded by MAX_WORKTREE_LOCK_RETRIES on persistent lock contention", async () => {
    // Every attempt loses the lock — must give up after the bound, not loop.
    const { git, calls } = fakeGit(Array(20).fill(lockFail))
    const r = await runWorktreeAddWithRetry(git, "/repo", "worktree add x", "/repo/x")
    expect(r.exitCode).toBe(128) // exhausted; last failure returned
    const addCalls = calls.filter((c) => c.startsWith("worktree add")).length
    expect(addCalls).toBe(MAX_WORKTREE_LOCK_RETRIES)
  })

  test("happy path: first attempt succeeds, no retry, no prune", async () => {
    const { git, calls } = fakeGit([ok])
    const r = await runWorktreeAddWithRetry(git, "/repo", "worktree add x", "/repo/x")
    expect(r.exitCode).toBe(0)
    expect(calls).toEqual(["worktree add x"])
  })
})
