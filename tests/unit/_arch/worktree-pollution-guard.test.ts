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

import { appearedDuring, parseUntracked } from "../../../tools/dev/worktree-pollution-guard"

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
