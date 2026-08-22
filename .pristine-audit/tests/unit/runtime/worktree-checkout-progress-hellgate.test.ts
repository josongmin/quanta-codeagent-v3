import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunShellEvent, ShellResult } from "@/runtime"
import { createPersistentWorktree, runShell, runWorktreeAddWithRetry } from "@/runtime"
import {
  type CheckoutProgress,
  checkoutProgressObserver,
  createCheckoutProgressReader,
  parseCheckoutProgressLine,
} from "@/runtime/worktree-progress"

/* RFC-04 D2 — REAL git checkout progress. The load-bearing anti-fabrication
 * contract: a percentage is surfaced ONLY when git's OWN
 * `Updating files: N% (x/y)` grammar is present; anything else is
 * `indeterminate` — NEVER a guessed / timer-driven / fabricated number. */

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe("parseCheckoutProgressLine — git's own grammar only", () => {
  test("parses the REAL git line captured from `git checkout -f --progress` (2.50.1)", () => {
    // Verbatim from a live run: `Updating files:  81% (9742/12000)`.
    const p = parseCheckoutProgressLine("Updating files:  81% (9742/12000)")
    expect(p.kind).toBe("ratio")
    if (p.kind === "ratio") {
      expect(p.completed).toBe(9742)
      expect(p.total).toBe(12000)
      expect(p.percent).toBe(81)
    }
  })

  test("parses the terminal `, done.` variant", () => {
    const p = parseCheckoutProgressLine("Updating files: 100% (12000/12000), done.")
    expect(p).toEqual({ kind: "ratio", completed: 12000, total: 12000, percent: 100 })
  })

  test("parses the older `Checking out files:` wording", () => {
    const p = parseCheckoutProgressLine("Checking out files:  50% (5/10)")
    expect(p).toEqual({ kind: "ratio", completed: 5, total: 10, percent: 50 })
  })

  // --- red-on-injection: garbage / fabricated lines must NEVER yield a % ---
  test.each([
    ["", "empty"],
    ["Preparing worktree (new branch 'forkx')", "worktree-prep line"],
    ["Cloning into 'repo'...", "clone line"],
    ["50% (1/2)", "percent+ratio with NO git label"],
    ["fabricated 50% (1/2)", "arbitrary text carrying a %"],
    ["Updating files: abc% (1/2)", "non-numeric percent"],
    ["Updating files: 50% (5/0)", "zero total (division trap)"],
    ["Updating files: 50% (10/5)", "completed > total (impossible)"],
    ["Updating files: 50%", "no (x/y) group"],
  ])("garbage stays indeterminate — %s", (line) => {
    expect(parseCheckoutProgressLine(line)).toEqual({ kind: "indeterminate" })
  })
})

describe("createCheckoutProgressReader — chunk boundaries + monotonicity", () => {
  test("reassembles a CR-delimited progress stream split across chunk boundaries", () => {
    const r = createCheckoutProgressReader()
    // git overwrites in place with \r; a chunk can split a line mid-token.
    r.push("Updating files:  10% (1/10)\rUpdating files:  20% (2/1")
    const mid = r.push("0)\rUpdating files:  30% (3/10)\r")
    expect(mid).toEqual({ kind: "ratio", completed: 3, total: 10, percent: 30 })
    expect(r.latest()).toEqual({ kind: "ratio", completed: 3, total: 10, percent: 30 })
  })

  test("a partial trailing segment is NOT parsed until completed", () => {
    const r = createCheckoutProgressReader()
    // No CR/LF terminator yet ⇒ nothing determinate.
    expect(r.push("Updating files:  40% (4/10")).toEqual({ kind: "indeterminate" })
    expect(r.push(")\r")).toEqual({ kind: "ratio", completed: 4, total: 10, percent: 40 })
  })

  test("a regressing count (same total, lower completed) is ignored — never goes backward", () => {
    const r = createCheckoutProgressReader()
    r.push("Updating files:  80% (8/10)\r")
    // A backward line would be a fabrication/parse artifact — the reader keeps
    // the last real value rather than reporting a regression.
    const after = r.push("Updating files:  30% (3/10)\r")
    expect(after).toEqual({ kind: "ratio", completed: 8, total: 10, percent: 80 })
  })

  test("interleaved garbage does not disturb the latest real ratio", () => {
    const r = createCheckoutProgressReader()
    r.push("Updating files:  25% (1/4)\r")
    r.push("Preparing worktree (new branch 'x')\n")
    r.push("some unrelated stderr noise\n")
    expect(r.latest()).toEqual({ kind: "ratio", completed: 1, total: 4, percent: 25 })
  })
})

describe("checkoutProgressObserver — RunShellEvent → progress adapter", () => {
  test("decodes stderr chunks and reports each real ratio, ignores stdout", () => {
    const seen: CheckoutProgress[] = []
    const obs = checkoutProgressObserver((p) => seen.push(p))
    obs({ kind: "start", pid: 1, command: "git", cwd: "/", startedAt: 0 })
    // stdout must never contribute a ratio.
    obs({ kind: "stdout", chunk: enc("Updating files:  99% (99/100)\r"), offset: 0 })
    obs({ kind: "stderr", chunk: enc("Updating files:  50% (5/10)\r"), offset: 0 })
    obs({ kind: "stderr", chunk: enc("Updating files: 100% (10/10)\r"), offset: 0 })
    obs({ kind: "exit", code: 0, signal: null, exitedAt: 1 })
    expect(seen).toEqual([
      { kind: "ratio", completed: 5, total: 10, percent: 50 },
      { kind: "ratio", completed: 10, total: 10, percent: 100 },
    ])
  })

  test("never emits for a stderr stream that carries no git progress grammar", () => {
    const seen: CheckoutProgress[] = []
    const obs = checkoutProgressObserver((p) => seen.push(p))
    obs({ kind: "stderr", chunk: enc("Preparing worktree (new branch 'x')\n"), offset: 0 })
    obs({ kind: "exit", code: 0, signal: null, exitedAt: 1 })
    expect(seen).toEqual([])
  })
})

describe("runWorktreeAddWithRetry — observer seam is byte-identical on the arg string", () => {
  const ok: ShellResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false }

  /** fakeGit records the (args, hasObserver) of every call. */
  const fakeGit = () => {
    const calls: Array<{ args: string; hasObserver: boolean }> = []
    const git = async (
      _repo: string,
      args: string,
      onShellEvent?: (e: RunShellEvent) => void,
    ): Promise<ShellResult> => {
      calls.push({ args, hasObserver: onShellEvent !== undefined })
      return ok
    }
    return { git, calls }
  }

  const ADD = "worktree add --no-track -B fk -- /repo/wt HEAD"

  test("the `worktree add` arg string is IDENTICAL with and without an observer (no --progress smuggled in)", async () => {
    const noObs = fakeGit()
    await runWorktreeAddWithRetry(noObs.git, "/repo", ADD, "/repo/wt")
    const withObs = fakeGit()
    await runWorktreeAddWithRetry(withObs.git, "/repo", ADD, "/repo/wt", () => {})
    expect(noObs.calls[0]?.args).toBe(ADD)
    expect(withObs.calls[0]?.args).toBe(ADD) // byte-identical: NOT `... --progress`
    expect(noObs.calls[0]?.args).toBe(withObs.calls[0]?.args)
  })

  test("the observer is forwarded to the `add` call when supplied, and absent otherwise", async () => {
    const noObs = fakeGit()
    await runWorktreeAddWithRetry(noObs.git, "/repo", ADD, "/repo/wt")
    expect(noObs.calls[0]?.hasObserver).toBe(false)

    const withObs = fakeGit()
    await runWorktreeAddWithRetry(withObs.git, "/repo", ADD, "/repo/wt", () => {})
    expect(withObs.calls[0]?.hasObserver).toBe(true)
  })
})

// ---- REAL git end-to-end (no fabrication; tied to git's actual stderr) ----

const gitAvailable = async (): Promise<boolean> => {
  try {
    return (await runShell("git --version")).exitCode === 0
  } catch {
    return false
  }
}
const HAS_GIT = await gitAvailable()
const GIT_TIMEOUT = 60_000

const makeBulkyRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "wt-prog-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  // Many small files so a forced checkout has visible progress work.
  await sh(
    "mkdir -p a && for i in $(seq 1 14000); do echo x$i > a/f$i.txt; done && git add -A && git commit -q -m init",
  )
  return dir
}

describe("REAL git — checkout progress surfaces git's OWN ratio, never fabricated", () => {
  test.skipIf(!HAS_GIT)(
    "checkoutProgressObserver over runShell.onShellEvent yields real ratios iff git emitted progress",
    async () => {
      const repo = await makeBulkyRepo()
      try {
        // Make an empty-worktree, then force a progress-bearing populate. This is
        // the ONLY git incantation that emits `Updating files: N% (x/y)` to a
        // PIPE (worktree add itself has no --progress flag — see report).
        await runShell(`git worktree add --no-track --no-checkout -B fk -- "${repo}/wt" HEAD`, {
          cwd: repo,
        })
        rmSync(`${repo}/wt/a`, { recursive: true, force: true })

        const seen: CheckoutProgress[] = []
        const res = await runShell("git checkout -f --progress", {
          cwd: `${repo}/wt`,
          onShellEvent: checkoutProgressObserver((p) => seen.push(p)),
        })
        expect(res.exitCode).toBe(0)

        // Ground-truth tie: assert against git's ACTUAL stderr, not timing luck.
        const emittedProgress = /Updating files:\s+\d+% \(\d+\/\d+\)/.test(res.stderr)
        if (emittedProgress) {
          expect(seen.length).toBeGreaterThan(0) // the wire actually fired
        }
        // Whether or not progress fired, EVERY surfaced value is a real ratio
        // whose total is git's own file count — no fabricated numbers.
        for (const p of seen) {
          expect(p.kind).toBe("ratio")
          if (p.kind === "ratio") {
            expect(p.total).toBe(14000)
            expect(p.completed).toBeLessThanOrEqual(p.total)
          }
        }
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "createPersistentWorktree forwards onShellEvent (start + real stderr) AND builds the same worktree",
    async () => {
      const repo = await makeBulkyRepo()
      try {
        const events: RunShellEvent[] = []
        const wt = await createPersistentWorktree("obs1", repo, {
          onShellEvent: (e) => events.push(e),
        })
        // The worktree is created exactly as before (observer changes nothing).
        expect(existsSync(wt.worktreePath)).toBe(true)
        expect(wt.branch).toBe("fork-obs1")
        // The git() helper genuinely threaded onShellEvent: a start event fired
        // and git's real `Preparing worktree` line was streamed on stderr.
        expect(events.some((e) => e.kind === "start")).toBe(true)
        const stderrText = events
          .filter((e): e is Extract<RunShellEvent, { kind: "stderr" }> => e.kind === "stderr")
          .map((e) => new TextDecoder().decode(e.chunk))
          .join("")
        expect(stderrText).toContain("Preparing worktree")
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "createPersistentWorktree WITHOUT an observer is behavior-identical (byte-identical seam)",
    async () => {
      const repo = await makeBulkyRepo()
      try {
        const wt = await createPersistentWorktree("noobs1", repo)
        expect(existsSync(wt.worktreePath)).toBe(true)
        expect(existsSync(join(wt.worktreePath, "a/f1.txt"))).toBe(true)
        expect(wt.branch).toBe("fork-noobs1")
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    GIT_TIMEOUT,
  )
})
