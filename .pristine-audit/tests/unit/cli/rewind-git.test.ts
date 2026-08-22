import { describe, expect, test } from "bun:test"
import {
  createCliRewindGitPort,
  type GitExec,
  type GitExecResult,
  isCliRewindGitEnabled,
} from "../../../src/apps/cli/rewind-git"

/**
 * `createCliRewindGitPort` — the real-`git` backed {@link RewindGitPort} the
 * CLI surface injects for `/rewind --restore-files`.
 *
 * Every test injects a deterministic `exec` mock so no real `git` ever runs.
 * The factory is otherwise side-effect free at construction time.
 */

/* ------------------------------------------------------------------ */
/* mock-exec helpers                                                   */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  readonly args: readonly string[]
  readonly cwd: string
}

type ScriptStep = ((call: RecordedCall) => GitExecResult) | GitExecResult

const mkExec = (
  script: readonly ScriptStep[],
): { exec: GitExec; calls: RecordedCall[]; remaining: () => number } => {
  const calls: RecordedCall[] = []
  let i = 0
  const exec: GitExec = async (cmd, args, cwd) => {
    if (cmd !== "git") {
      return { code: 127, stdout: "", stderr: `unknown cmd: ${cmd}` }
    }
    const step = script[i]
    i += 1
    if (step === undefined) {
      throw new Error(`exec script exhausted at call #${i}: git ${args.join(" ")}`)
    }
    const call: RecordedCall = { args, cwd }
    calls.push(call)
    return typeof step === "function" ? step(call) : step
  }
  return { exec, calls, remaining: () => script.length - i }
}

const ok = (stdout = "", stderr = ""): GitExecResult => ({ code: 0, stdout, stderr })
const fail = (stderr: string, code = 1): GitExecResult => ({ code, stdout: "", stderr })

/* ------------------------------------------------------------------ */
/* isCliRewindGitEnabled (env-gate)                                    */
/* ------------------------------------------------------------------ */

describe("isCliRewindGitEnabled", () => {
  test("default OFF when env empty", () => {
    expect(isCliRewindGitEnabled({})).toBe(false)
  })
  test("default OFF when QUANTA_REWIND_GIT=0", () => {
    expect(isCliRewindGitEnabled({ QUANTA_REWIND_GIT: "0" })).toBe(false)
  })
  test("QUANTA_REWIND_GIT=1 enables", () => {
    expect(isCliRewindGitEnabled({ QUANTA_REWIND_GIT: "1" })).toBe(true)
  })
  test("alternative truthy values enable", () => {
    expect(isCliRewindGitEnabled({ QUANTA_REWIND_GIT: "true" })).toBe(true)
    expect(isCliRewindGitEnabled({ QUANTA_REWIND_GIT: "yes" })).toBe(true)
  })
  test("alternative falsy values disable", () => {
    expect(isCliRewindGitEnabled({ QUANTA_REWIND_GIT: "false" })).toBe(false)
    expect(isCliRewindGitEnabled({ QUANTA_REWIND_GIT: "off" })).toBe(false)
    expect(isCliRewindGitEnabled({ QUANTA_REWIND_GIT: "no" })).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* stash                                                               */
/* ------------------------------------------------------------------ */

describe("createCliRewindGitPort.stash", () => {
  test("dirty tree ⇒ stash push -u -m, returns stash label", async () => {
    const { exec, calls } = mkExec([
      ok(" M file.ts\n"), // git status --porcelain
      ok(""), // git stash push
    ])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec, stashLabel: "test-stash" })
    const ref = await port.stash("/tmp/wk")
    expect(typeof ref).toBe("string")
    expect((ref as string).startsWith("test-stash-")).toBe(true)
    expect(calls[0]?.args).toEqual(["status", "--porcelain"])
    expect(calls[1]?.args?.[0]).toBe("stash")
    expect(calls[1]?.args?.[1]).toBe("push")
    expect(calls[1]?.args?.[2]).toBe("-u")
    expect(calls[1]?.args?.[3]).toBe("-m")
    expect(calls[1]?.args?.[4]?.startsWith("test-stash-")).toBe(true)
  })

  test("clean tree ⇒ skip stash entirely, returns undefined", async () => {
    const { exec, calls } = mkExec([ok("")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    const ref = await port.stash("/tmp/wk")
    expect(ref).toBeUndefined()
    expect(calls.length).toBe(1) // ONLY status was called
  })

  test("status failure ⇒ throws with stderr", async () => {
    const { exec } = mkExec([fail("fatal: not a git repository", 128)])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(port.stash("/tmp/wk")).rejects.toThrow(/not a git repository/)
  })

  test("stash push failure ⇒ throws and surfaces stderr", async () => {
    const { exec } = mkExec([ok(" M file.ts\n"), fail("nothing to commit but untracked")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(port.stash("/tmp/wk")).rejects.toThrow(/git stash failed/)
  })

  test("uses factory cwd, not the wrapper-passed cwd (slice-isolation)", async () => {
    const { exec, calls } = mkExec([ok(" M f\n"), ok("")])
    const port = createCliRewindGitPort({ cwd: "/factory/cwd", exec })
    await port.stash("/wrong/cwd")
    expect(calls[0]?.cwd).toBe("/factory/cwd")
    expect(calls[1]?.cwd).toBe("/factory/cwd")
  })
})

/* ------------------------------------------------------------------ */
/* resetHard                                                           */
/* ------------------------------------------------------------------ */

describe("createCliRewindGitPort.resetHard", () => {
  test("verifies sha, then git reset --hard", async () => {
    const { exec, calls } = mkExec([
      ok("abc123\n"), // rev-parse --verify
      ok(""), // reset --hard
    ])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    await port.resetHard("/tmp/wk", "abc123")
    expect(calls[0]?.args).toEqual(["rev-parse", "--verify", "abc123^{commit}"])
    expect(calls[1]?.args).toEqual(["reset", "--hard", "abc123"])
  })

  test("unsafe sha (shell metas) ⇒ throws without invoking exec", async () => {
    const { exec, calls } = mkExec([])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(port.resetHard("/tmp/wk", "abc; rm -rf /")).rejects.toThrow(/unsafe sha/)
    expect(calls.length).toBe(0)
  })

  test("rev-parse failure ⇒ throws with stderr (no destructive reset)", async () => {
    const { exec, calls } = mkExec([fail("fatal: bad revision 'deadbeef'")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(port.resetHard("/tmp/wk", "deadbeef")).rejects.toThrow(/rev-parse failed/)
    expect(calls.length).toBe(1) // reset --hard NEVER ran
  })

  test("reset failure ⇒ throws with stderr (caller surfaces stash-recovery note)", async () => {
    const { exec } = mkExec([
      ok("abc123\n"),
      fail("error: Your local changes would be overwritten"),
    ])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(port.resetHard("/tmp/wk", "abc123")).rejects.toThrow(/git reset --hard failed/)
  })
})

/* ------------------------------------------------------------------ */
/* read-only helpers                                                   */
/* ------------------------------------------------------------------ */

describe("createCliRewindGitPort.currentSha + isCleanWorkingTree", () => {
  test("currentSha returns rev-parse HEAD output, trimmed", async () => {
    const { exec } = mkExec([ok("abc123def\n")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(await port.currentSha()).toBe("abc123def")
  })

  test("currentSha returns undefined on failure (not a repo / etc.)", async () => {
    const { exec } = mkExec([fail("fatal: not a git repository", 128)])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(await port.currentSha()).toBeUndefined()
  })

  test("isCleanWorkingTree empty status ⇒ true", async () => {
    const { exec } = mkExec([ok("")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(await port.isCleanWorkingTree()).toBe(true)
  })

  test("isCleanWorkingTree dirty status ⇒ false", async () => {
    const { exec } = mkExec([ok(" M file.ts\n")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(await port.isCleanWorkingTree()).toBe(false)
  })

  test("isCleanWorkingTree status failure ⇒ false (defensive default)", async () => {
    const { exec } = mkExec([fail("fatal")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(await port.isCleanWorkingTree()).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* restoreStash                                                        */
/* ------------------------------------------------------------------ */

describe("createCliRewindGitPort.restoreStash", () => {
  test("finds matching stash by message and pops it", async () => {
    const { exec, calls } = mkExec([
      ok("stash@{0}: On main: quanta-rewind-12345\nstash@{1}: WIP\n"),
      ok(""),
    ])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    await port.restoreStash("quanta-rewind-12345")
    expect(calls[0]?.args).toEqual(["stash", "list"])
    expect(calls[1]?.args).toEqual(["stash", "pop", "stash@{0}"])
  })

  test("picks the right index when stash is not at position 0", async () => {
    const { exec, calls } = mkExec([
      ok(
        "stash@{0}: On main: WIP\nstash@{1}: On main: quanta-rewind-99\nstash@{2}: On main: other\n",
      ),
      ok(""),
    ])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    await port.restoreStash("quanta-rewind-99")
    expect(calls[1]?.args).toEqual(["stash", "pop", "stash@{1}"])
  })

  test("stash not found ⇒ throws", async () => {
    const { exec } = mkExec([ok("stash@{0}: On main: other-thing\n")])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(port.restoreStash("quanta-rewind-missing")).rejects.toThrow(/stash not found/)
  })

  test("unsafe stash ref ⇒ throws without invoking exec", async () => {
    const { exec, calls } = mkExec([])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    expect(port.restoreStash("foo; rm -rf /")).rejects.toThrow(/unsafe stash ref/)
    expect(calls.length).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* end-to-end sequence: stash → resetHard                              */
/* ------------------------------------------------------------------ */

describe("stash + resetHard sequence (the rewind --restore-files flow)", () => {
  test("dirty tree → stash → reset → port returns successfully", async () => {
    const { exec, calls } = mkExec([
      ok(" M file.ts\n"), // status
      ok(""), // stash push
      ok("abc123\n"), // rev-parse --verify
      ok(""), // reset --hard
    ])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    const stashed = await port.stash("/tmp/wk")
    expect(typeof stashed).toBe("string")
    await port.resetHard("/tmp/wk", "abc123")
    expect(calls.length).toBe(4)
    expect(calls.map((c) => c.args[0])).toEqual(["status", "stash", "rev-parse", "reset"])
  })

  test("clean tree → no stash → reset directly", async () => {
    const { exec, calls } = mkExec([
      ok(""), // status: clean
      ok("abc123\n"), // rev-parse --verify
      ok(""), // reset --hard
    ])
    const port = createCliRewindGitPort({ cwd: "/tmp/wk", exec })
    const stashed = await port.stash("/tmp/wk")
    expect(stashed).toBeUndefined()
    await port.resetHard("/tmp/wk", "abc123")
    expect(calls.length).toBe(3)
  })
})
