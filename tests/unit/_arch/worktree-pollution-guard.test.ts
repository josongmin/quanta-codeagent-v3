/**
 * Architecture ratchet — the pure half of the worktree-pollution guard.
 *
 * The guard itself (`tools/dev/worktree-pollution-guard.ts`) can only be
 * exercised end-to-end by running a real command, which is what CI does. What
 * this file pins is the part that decides WHETHER something leaked, driven over
 * synthetic inputs so the matcher cannot be hollowed out without a red test.
 *
 * That pairing is the house rule for repo-level guards (see
 * `_arch/repo-index-hygiene`): a check that only ever asserts "the repo is
 * clean" passes for free the moment the repo IS clean, and then silently
 * survives any later weakening of its own predicate.
 *
 * The incident this guards against is recorded in the tool's header: five test
 * fixtures (`rel.txt`, `a.txt`, `b.txt`, `round.txt`, `src/x.ts`) written into
 * the REPO ROOT by tests that passed a bare relative path to a write API. They
 * failed `typecheck:all`, `lint`, `lint:debt` and `storage.test.ts` at once,
 * from files no commit contains.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  appearedDuring,
  describeStatusFailure,
  parseUntracked,
} from "../../../tools/dev/worktree-pollution-guard"

/** `git status --porcelain=v1 -uall -z` output: NUL-separated, no trailing newline. */
const porcelain = (...entries: readonly string[]): string => `${entries.join("\0")}\0`

describe("worktree-pollution guard — parseUntracked", () => {
  test("takes untracked entries and ONLY untracked entries", () => {
    const got = parseUntracked(
      porcelain(
        "?? rel.txt",
        " M src/agent/loop.ts", // tracked, modified — not this guard's business
        "?? src/x.ts",
        "A  tests/new.test.ts", // staged add — already known to git
        "?? docs/scratch/notes.md",
      ),
    )
    expect([...got].sort()).toEqual(["docs/scratch/notes.md", "rel.txt", "src/x.ts"])
  })

  test("a path containing spaces survives intact", () => {
    // The `-z` form is what makes this true: without it git quotes and escapes
    // such a path, and the quoted form would not compare equal across snapshots,
    // so the same file would read as "appeared" on every run.
    const got = parseUntracked(porcelain("?? docs/my notes.md"))
    expect([...got]).toEqual(["docs/my notes.md"])
  })

  test("empty output ⇒ empty set (a clean tree is not an error)", () => {
    expect(parseUntracked("").size).toBe(0)
  })
})

describe("worktree-pollution guard — appearedDuring", () => {
  const before = new Set(["docs/scratch/notes.md", ".seedmap-tmp.ts"])

  test("names exactly the paths the run created", () => {
    const after = new Set([...before, "rel.txt", "src/x.ts"])
    expect(appearedDuring(before, after)).toEqual(["rel.txt", "src/x.ts"])
  })

  test("a scratch file that already existed is INVISIBLE to the guard", () => {
    // This is the whole reason the guard measures a delta instead of asserting
    // the tree is clean: on this repo the tree is never clean, and a
    // developer's scratch file must never fail CI.
    expect(appearedDuring(before, new Set(before))).toEqual([])
  })

  test("a path the run DELETED is not reported (cleanup is the success case)", () => {
    const after = new Set(["docs/scratch/notes.md"])
    expect(appearedDuring(before, after)).toEqual([])
  })

  test("output is sorted, so the failure message is stable across runs", () => {
    const after = new Set([...before, "z.txt", "a.txt", "m.txt"])
    expect(appearedDuring(before, after)).toEqual(["a.txt", "m.txt", "z.txt"])
  })

  test("red-on-injection: re-leaking the exact aug-23 fixtures is caught", () => {
    const after = new Set([...before, "rel.txt", "a.txt", "b.txt", "round.txt", "src/x.ts"])
    const leaked = appearedDuring(before, after)
    expect(leaked).toEqual(["a.txt", "b.txt", "rel.txt", "round.txt", "src/x.ts"])
    // And the guard's verdict is driven by emptiness, not by any of the names —
    // so a NEW fixture nobody has seen yet is caught by the same code path.
    expect(leaked.length > 0).toBe(true)
  })
})

/**
 * A hung `git status` is not the same as a clean tree.
 *
 * The baseline snapshot was an unbounded `Bun.spawnSync(["git","status",…])`.
 * `git status` is normally milliseconds, but it blocks on `.git/index.lock`
 * while another process holds it — and this repository is routinely worked by
 * concurrent sessions; a contended lock was observed during this campaign. An
 * unbounded sync spawn there wedges the guard, and with it the gate it wraps,
 * producing no output at all.
 *
 * The failure is now typed, because a timeout and a non-zero exit need different
 * messages: one says git is broken here, the other says something else is
 * holding the lock. Both still fail CLOSED — without a baseline the guard cannot
 * tell "nothing leaked" from "we never looked".
 */
describe("baseline git status is bounded", () => {
  test("a timeout and a failure are different messages, and neither is a pass", () => {
    const timedOut = describeStatusFailure({ kind: "timeout", timeoutMs: 60_000 })
    const failed = describeStatusFailure({ kind: "exit", code: 128, stderr: "not a repository" })
    expect(timedOut).toContain("index.lock")
    expect(timedOut).toContain("no baseline is not the same as no pollution")
    expect(failed).toContain("exit 128")
    expect(failed).toContain("not a repository")
    // Distinguishable, or the typing bought nothing.
    expect(timedOut).not.toBe(failed)
  })

  test("the guard passes a timeout to the spawn and reads the timed-out shape", () => {
    // Structural, because the defect is the ABSENCE of an option: a test that
    // only called `describeStatusFailure` would pass over an unbounded spawn.
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "tools", "dev", "worktree-pollution-guard.ts"),
      "utf8",
    )
    // The ceiling must be INSIDE the spawn's own argument list.
    //
    // The previous version of this arm looked for `timeoutMs: STATUS_TIMEOUT_MS`
    // anywhere in the file, and the error-message builder four lines below the
    // spawn contains exactly that text — so deleting the option from the spawn
    // left this test green. MEASURED: with the option removed, `timeoutMs`
    // occurrences went 4 -> 3 and the suite still passed.
    //
    // Brace-matched, so a nested object in the argument list cannot truncate the
    // slice the way a lazy regex would.
    const at = source.indexOf("runBoundedCapture(")
    expect(at).toBeGreaterThan(0)
    let depth = 0
    let end = at + "runBoundedCapture".length
    for (; end < source.length; end += 1) {
      const char = source[end]
      if (char === "(" || char === "{") depth += 1
      else if (char === ")" || char === "}") {
        depth -= 1
        if (depth === 0) break
      }
    }
    const call = source.slice(at, end + 1)
    // ANTI-VACUITY: an empty or truncated slice would satisfy nothing below,
    // but a slice that swallowed the whole file would satisfy everything.
    expect(call.length).toBeGreaterThan(40)
    expect(call.length).toBeLessThan(400)
    const absentFromCall = ['command: ["git", "status"', "timeoutMs: STATUS_TIMEOUT_MS"].filter(
      (marker) => !call.includes(marker),
    )
    expect(absentFromCall).toEqual([])

    // ...and the timed-out shape is READ, not assumed. A timed-out capture
    // reports `exitCode: null`, which the old `!== 0` check blamed on git.
    // Measured on this Bun: `timeout: 600` against `sleep 3` -> exitCode null,
    // SIGTERM, 605ms.
    expect(source).toContain("proc.exitCode === null")
    // ANTI-VACUITY: the file must really have been read.
    expect(source.length).toBeGreaterThan(2_000)
  })

  test("the timed-out spawn shape this relies on is what Bun actually produces", () => {
    // Executed, not asserted from a comment: the whole fix keys on `exitCode`
    // being null rather than a number when a spawn is killed by its timeout.
    const started = Date.now()
    const proc = Bun.spawnSync(["sh", "-c", "sleep 5"], {
      timeout: 400,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBeNull()
    expect(proc.signalCode).toBe("SIGTERM")
    expect(Date.now() - started).toBeLessThan(4_000)
  })
})
