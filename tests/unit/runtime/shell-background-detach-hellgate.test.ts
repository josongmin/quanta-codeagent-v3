/**
 * ADR-0296 auto-background — `runShell({ background })` detach-on-deadline
 * hellgate. Real `bash` children (POSIX only).
 *
 * The `background` seam makes the deadline DETACH the still-running child
 * (handing it to the registry via `adopt`) instead of killing it. The whole
 * point of doing it in `runShell` (vs the legacy registry re-spawn) is that the
 * SAME foreground spawn — sandbox/env/wrap and all — is what gets detached, so
 * a command that COMPLETES before its deadline is byte-identical to the legacy
 * result.
 *
 * Axes:
 *  1. FAST COMPLETION — a command that finishes before the deadline resolves a
 *     normal `ShellResult` (no `detached`), the seam is NEVER consulted, and the
 *     output is byte-identical to the same run WITHOUT the background seam.
 *  2. DETACH — a command still running at the deadline resolves
 *     `{ detached: { shellId } }`; `adopt` is called exactly once with the live
 *     command/buffers/child handles; pre-detach output is captured.
 *  3. ABORT-BEFORE-DEADLINE — an explicit abort kills the child (the user asked
 *     to stop); it is NOT detached.
 */

import { describe, expect, test } from "bun:test"
import type { BackgroundDetachSeam } from "@/runtime"
import { runShell } from "@/runtime"

const POSIX = process.platform !== "win32"

/** A recording fake detach seam — never spawns; just captures the adopt args
 *  and returns a fixed id. The caller (`runShell`) owns the real child. */
const recordingSeam = (id = "bg-test-1") => {
  const calls: Array<Parameters<BackgroundDetachSeam["adopt"]>[0]> = []
  const seam: BackgroundDetachSeam = {
    adopt: async (args) => {
      calls.push(args)
      return { id }
    },
  }
  return { seam, calls }
}

describe.if(POSIX)("runShell({ background }) — fast completion is byte-identical", () => {
  test("a command that finishes before the deadline resolves normally; seam untouched", async () => {
    const { seam, calls } = recordingSeam()
    const r = await runShell("printf 'hello\\nworld\\n'", { background: seam, timeoutMs: 10_000 })

    expect(r.detached).toBeUndefined() // completed, not detached
    expect(calls.length).toBe(0) // the deadline never fired ⇒ no adopt
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("hello\nworld\n")

    // Byte-identical to the same run WITHOUT the background seam.
    const legacy = await runShell("printf 'hello\\nworld\\n'", { timeoutMs: 10_000 })
    expect(r.stdout).toBe(legacy.stdout)
    expect(r.stderr).toBe(legacy.stderr)
    expect(r.exitCode).toBe(legacy.exitCode)
  })

  test("a nonzero fast exit is preserved (no detach, exit code surfaced)", async () => {
    const { seam, calls } = recordingSeam()
    const r = await runShell("printf oops 1>&2; exit 3", { background: seam, timeoutMs: 10_000 })
    expect(r.detached).toBeUndefined()
    expect(calls.length).toBe(0)
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toContain("oops")
  })
})

describe.if(POSIX)("runShell({ background }) — detach on deadline", () => {
  test("a still-running command at the deadline detaches via adopt (called once) with live handles", async () => {
    const { seam, calls } = recordingSeam("bg-detached-42")
    // Emits some output, THEN sleeps past the (tiny) deadline.
    const r = await runShell("printf 'partial-out\\n'; sleep 5", {
      background: seam,
      timeoutMs: 120,
    })

    expect(r.detached?.shellId).toBe("bg-detached-42")
    expect(calls.length).toBe(1) // adopt called EXACTLY once
    const args = calls[0]
    expect(args?.command).toContain("sleep 5")
    expect(args?.cwd.length).toBeGreaterThan(0)
    // Pre-detach output is captured in the returned head + handed to the registry.
    expect(r.stdout).toContain("partial-out")
    expect(args?.stdout.value()).toContain("partial-out")
    expect(typeof args?.kill).toBe("function")
    expect(typeof args?.disarm).toBe("function")

    // Clean up the still-running detached child (the registry would normally own
    // it; here the fake seam just recorded the handles).
    args?.kill()
    await args?.exited.catch(() => 0)
  })

  test("post-detach streaming output reaches the adopted buffer (drain switched to it)", async () => {
    const { seam, calls } = recordingSeam()
    // Stalls (no output) until after the deadline, then prints once detached.
    const r = await runShell("sleep 0.3; printf 'after-detach\\n'; sleep 5", {
      background: seam,
      timeoutMs: 80,
    })
    expect(r.detached).toBeDefined()
    const buf = calls[0]?.stdout
    expect(buf).toBeDefined()
    // The "after-detach" line is written AFTER the detach moment; the switched
    // drain must land it in the adopted buffer. Poll on WALL-CLOCK (not zero-tick
    // spins, which under parallel load elapse before the `sleep 0.3; printf`).
    for (let i = 0; i < 400 && !(buf?.value().includes("after-detach") ?? false); i++) {
      await new Promise<void>((res) => setTimeout(res, 10))
    }
    expect(buf?.value()).toContain("after-detach")
    calls[0]?.kill()
    await calls[0]?.exited.catch(() => 0)
  })
})

describe.if(POSIX)("runShell({ background, confirm }) — PROMPT consent gate", () => {
  test("confirm APPROVES at the deadline ⇒ detach (adopt called)", async () => {
    const { seam, calls } = recordingSeam("bg-approved")
    let asked = 0
    const r = await runShell("printf 'pre\\n'; sleep 5", {
      background: { ...seam, confirm: async () => (asked++, true) },
      timeoutMs: 120,
    })
    expect(asked).toBe(1) // consent was requested exactly once
    expect(r.detached?.shellId).toBe("bg-approved")
    expect(calls.length).toBe(1) // approved ⇒ adopted
    calls[0]?.kill()
    await calls[0]?.exited.catch(() => 0)
  })

  test("confirm DECLINES at the deadline ⇒ kill (legacy timeout, no detach)", async () => {
    const { seam, calls } = recordingSeam()
    let asked = 0
    const r = await runShell("printf 'pre\\n'; sleep 1", {
      background: { ...seam, confirm: async () => (asked++, false) },
      timeoutMs: 120,
    })
    expect(asked).toBe(1)
    expect(r.detached).toBeUndefined() // declined ⇒ NOT detached
    expect(r.timedOut).toBe(true) // surfaced as a legacy timeout
    expect(calls.length).toBe(0) // adopt never consulted
  }, 15_000)

  test("a THROWING confirm is a conservative decline ⇒ kill, not detach", async () => {
    const { seam, calls } = recordingSeam()
    const r = await runShell("sleep 1", {
      background: {
        ...seam,
        confirm: async () => {
          throw new Error("prompt surface crashed")
        },
      },
      timeoutMs: 120,
    })
    expect(r.detached).toBeUndefined()
    expect(r.timedOut).toBe(true)
    expect(calls.length).toBe(0)
  }, 15_000)

  test("command COMPLETES while the user is deciding ⇒ no detach, no kill", async () => {
    const { seam, calls } = recordingSeam()
    // Fast command finishes ~immediately; confirm stalls 300ms before replying.
    const r = await runShell("printf 'quick-done\\n'", {
      background: {
        ...seam,
        confirm: () => new Promise<boolean>((res) => setTimeout(() => res(true), 300)),
      },
      timeoutMs: 30,
    })
    expect(r.detached).toBeUndefined() // already completed when consent resolved
    expect(r.timedOut).toBe(false)
    expect(r.stdout).toContain("quick-done")
    expect(calls.length).toBe(0)
  })
})

describe.if(POSIX)("runShell({ background }) — onShellEvent observer contract holds", () => {
  test("fast completion emits start ≺ stdout chunks ≺ exactly-one exit terminal", async () => {
    const { seam } = recordingSeam()
    const events: Array<{ kind: string }> = []
    const r = await runShell("printf 'streamed\\n'", {
      background: seam,
      timeoutMs: 10_000,
      onShellEvent: (e) => events.push(e),
    })
    expect(r.detached).toBeUndefined()
    const kinds = events.map((e) => e.kind)
    expect(kinds[0]).toBe("start")
    expect(kinds).toContain("stdout")
    // Exactly ONE terminal, and it is `exit` (not aborted) for a clean finish.
    const terminals = kinds.filter((k) => k === "exit" || k === "aborted")
    expect(terminals).toEqual(["exit"])
  })

  test("DETACH still emits a terminal (detached) — observer is never left open", async () => {
    const { seam, calls } = recordingSeam()
    const events: Array<{ kind: string; reason?: string }> = []
    const r = await runShell("printf 'pre\\n'; sleep 5", {
      background: seam,
      timeoutMs: 120,
      onShellEvent: (e) => events.push(e as { kind: string; reason?: string }),
    })
    expect(r.detached).toBeDefined()
    const kinds = events.map((e) => e.kind)
    expect(kinds[0]).toBe("start")
    expect(kinds).toContain("stdout") // pre-detach chunk forwarded
    // Exactly one terminal, and it is `detached{auto}` (WS-H / UUX-6-05: the
    // deadline elapsed and the registry owns the LIVE child from here — an
    // intentional handoff, not an abort). No leaked-open observer stream.
    const terminals = events.filter(
      (e) => e.kind === "exit" || e.kind === "aborted" || e.kind === "detached",
    )
    expect(terminals.length).toBe(1)
    expect(terminals[0]?.kind).toBe("detached")
    expect(terminals[0]?.reason).toBe("auto")
    // ORDERING contract: start ≺ all stdout chunks ≺ the single terminal (the
    // terminal must be LAST, not emitted before the pre-detach output).
    const lastStdout = kinds.lastIndexOf("stdout")
    const terminalIdx = kinds.findIndex((k) => k === "exit" || k === "aborted" || k === "detached")
    expect(terminalIdx).toBeGreaterThan(lastStdout)
    expect(terminalIdx).toBe(kinds.length - 1) // nothing after the terminal
    calls[0]?.kill()
    await calls[0]?.exited.catch(() => 0)
  })
})

describe.if(POSIX)(
  "runShell({ background }) — abort before the deadline kills, not detaches",
  () => {
    test("an explicit abort kills the child and resolves WITHOUT a detach", async () => {
      const { seam, calls } = recordingSeam()
      const ac = new AbortController()
      const p = runShell("sleep 5", { background: seam, timeoutMs: 10_000, signal: ac.signal })
      setTimeout(() => ac.abort(), 60)
      const r = await p
      expect(r.detached).toBeUndefined() // aborted ⇒ killed, never detached
      expect(calls.length).toBe(0) // adopt never consulted
    })
  },
)
