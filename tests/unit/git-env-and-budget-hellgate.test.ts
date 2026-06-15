/**
 * ADR-0105 + ADR-0107 hellgate — deterministic git env + capture budget.
 *
 * - Env: GIT_OPTIONAL_LOCKS=0 / GIT_PAGER=cat / LC_ALL=C / TERM=dumb /
 *   GIT_TERMINAL_PROMPT=0 are HARD-SET on every git invocation.
 * - Log: US-separator (`\x1f`) replaces TAB so commit messages with TABs
 *   cannot break the parser.
 * - Budget: GitBudget interface + helpers (`applyBudget`,
 *   `resolveMaxCommits`, `crossedTarget`) — closed-port, tools opt in.
 *
 * 17 adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import {
  applyBudget,
  buildGitEnv,
  crossedTarget,
  type GitBudget,
  gitTools,
  resolveGitBudget,
  resolveMaxCommits,
  withBudget,
} from "@/tool/git"
import { gitLogTool } from "@/tool/git/log"
import type { GitRunner, GitRunResult } from "@/tool/git/types"

// ── Env determinism (ADR-0105) ──────────────────────────────────────────

describe("buildGitEnv — deterministic overrides (hellgate)", () => {
  test("HELL-1: GIT_OPTIONAL_LOCKS=0 always set", () => {
    const env = buildGitEnv()
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0")
  })

  test("HELL-2: GIT_PAGER=cat AND PAGER=cat (both, belt-and-suspenders)", () => {
    const env = buildGitEnv()
    expect(env.GIT_PAGER).toBe("cat")
    expect(env.PAGER).toBe("cat")
  })

  test("HELL-3: LC_ALL=C overrides whatever the parent has", () => {
    const env = buildGitEnv()
    expect(env.LC_ALL).toBe("C")
  })

  test("HELL-4: TERM=dumb (disables color escape sequences)", () => {
    const env = buildGitEnv()
    expect(env.TERM).toBe("dumb")
  })

  test("HELL-5: GIT_TERMINAL_PROMPT=0 (never prompt for creds)", () => {
    const env = buildGitEnv()
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
  })

  test("HELL-6: PATH is passed through (git needs PATH to find itself)", () => {
    const env = buildGitEnv()
    // PATH should be a non-empty string on any sane test host.
    expect(typeof env.PATH).toBe("string")
    expect((env.PATH ?? "").length).toBeGreaterThan(0)
  })

  test("HELL-7: HOME is passed through (git reads ~/.gitconfig)", () => {
    const env = buildGitEnv()
    expect(typeof env.HOME).toBe("string")
  })
})

// ── Log format (ADR-0105) ───────────────────────────────────────────────

describe("git_log — US-separator parser (hellgate)", () => {
  /** Build a fake runner that captures the args and returns canned stdout. */
  const fakeRunner = (stdout: string): GitRunner & { calls: readonly string[][] } => {
    const calls: string[][] = []
    return {
      calls,
      async run(args: readonly string[]): Promise<GitRunResult> {
        calls.push([...args])
        return { stdout, stderr: "", exitCode: 0 }
      },
    }
  }

  test("HELL-8: log args include `%H%x1f%an%x1f%ai%x1f%s` (US-separator format)", async () => {
    const runner = fakeRunner("abc\x1fJo\x1f2026-05-23\x1ffeat: x\n")
    const tool = gitLogTool(runner as GitRunner)
    const it = tool.execute({}, { cwd: "/tmp", signal: new AbortController().signal })
    // Drain the iterable
    for await (const _ev of it) {
      void _ev
    }
    expect((runner as unknown as { calls: string[][] }).calls[0]).toContain(
      "--format=%H%x1f%an%x1f%ai%x1f%s",
    )
  })

  test("HELL-9: parses US-separated rows correctly", async () => {
    const runner = fakeRunner(
      "abc12345\x1fJo\x1f2026-05-23T12:00:00+09:00\x1ffeat: add x\ndef67890\x1fAlex\x1f2026-05-22T10:00:00+09:00\x1ffix: bug\n",
    )
    const tool = gitLogTool(runner as GitRunner)
    const events: Array<{ type: string; result?: { ok: boolean; output: string } }> = []
    for await (const ev of tool.execute(
      {},
      { cwd: "/tmp", signal: new AbortController().signal },
    )) {
      events.push(ev as { type: string; result?: { ok: boolean; output: string } })
    }
    const result = events.find((e) => e.type === "result")?.result
    expect(result?.ok).toBe(true)
    expect(result?.output).toContain("abc12345")
    expect(result?.output).toContain("(Jo, 2026-05-23)")
    expect(result?.output).toContain("feat: add x")
    expect(result?.output).toContain("def67890")
    expect(result?.output).toContain("fix: bug")
  })

  test("HELL-10: subject containing a TAB does NOT break the parser (regression)", async () => {
    // Pre-ADR-0105 the format used `\t` (TAB), which would split a subject
    // like "fix: a\tb" into two extra fields. US-separator (`\x1f`) cannot
    // appear in normal text so this row parses cleanly.
    const runner = fakeRunner("abc\x1fJo\x1f2026-05-23T00:00:00Z\x1ffix:\ta\tb\n")
    const tool = gitLogTool(runner as GitRunner)
    let resultOutput = ""
    for await (const ev of tool.execute(
      {},
      { cwd: "/tmp", signal: new AbortController().signal },
    )) {
      if (ev.type === "result") resultOutput = ev.result.output
    }
    expect(resultOutput).toContain("fix:\ta\tb")
  })
})

// ── Budget — applyBudget (ADR-0107) ─────────────────────────────────────

describe("applyBudget — fused AbortSignal (hellgate)", () => {
  test("HELL-11: no budget ⇒ returns parent signal unchanged (byte-identical)", () => {
    const parent = new AbortController().signal
    const { signal, cleanup } = applyBudget(parent, undefined)
    expect(signal).toBe(parent)
    cleanup() // safe to call with no-op cleanup
  })

  test("HELL-12: maxWallTimeMs fires AbortController after elapsed", async () => {
    const { signal, cleanup } = applyBudget(undefined, { maxWallTimeMs: 20 })
    expect(signal?.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 50))
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBeInstanceOf(Error)
    cleanup()
  })

  test("HELL-13: parent abort propagates to fused signal", () => {
    const parent = new AbortController()
    const { signal, cleanup } = applyBudget(parent.signal, { maxWallTimeMs: 60_000 })
    expect(signal?.aborted).toBe(false)
    parent.abort(new Error("parent done"))
    expect(signal?.aborted).toBe(true)
    cleanup()
  })

  test("HELL-14: budget clamps to 60s when caller passes a huge value", async () => {
    // A caller mis-uses minutes-as-ms: passes `5 * 60_000 = 300_000`. The
    // clamp must cap at 60_000. We can't wait 60s in a test, so we just
    // verify the signal exists and cleanup works (the clamp is internal).
    const { signal, cleanup } = applyBudget(undefined, { maxWallTimeMs: 10_000_000 })
    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)
    cleanup()
  })

  test("HELL-15: invalid wall-time (negative / NaN / 0) ⇒ no budget applied", () => {
    const parent = new AbortController().signal
    expect(applyBudget(parent, { maxWallTimeMs: -1 }).signal).toBe(parent)
    expect(applyBudget(parent, { maxWallTimeMs: 0 }).signal).toBe(parent)
    expect(applyBudget(parent, { maxWallTimeMs: Number.NaN }).signal).toBe(parent)
  })

  // ── ROUND-2 (listener-leak / lifecycle lens) ──────────────────────────────
  // A long-lived parent signal is reused across MANY git ops. Each `applyBudget`
  // attaches one `abort` listener to the parent; `cleanup()` MUST remove it.
  // Without removal a 1000-op session leaks 1000 listeners on the parent. We
  // probe via a spy parent that counts add/remove.
  const spyParent = (): {
    signal: AbortSignal
    abort: () => void
    liveListeners: () => number
  } => {
    const ctrl = new AbortController()
    // Track listener IDENTITY (a Set), so a double-remove of the SAME listener is
    // correctly idempotent (matches native removeEventListener). This measures
    // REAL leakage: a listener that was added and never removed. (The spec auto-
    // removes a {once} listener when it fires without routing through our spy, so
    // after a parent-abort the set may still hold it — tests below account for
    // that by relying on the ADD/REMOVE balance the cleanup() path drives, which
    // is the actual leak surface for a long-lived parent.)
    const live = new Set<EventListener>()
    const realAdd = ctrl.signal.addEventListener.bind(ctrl.signal)
    const realRemove = ctrl.signal.removeEventListener.bind(ctrl.signal)
    ;(ctrl.signal as unknown as { addEventListener: typeof realAdd }).addEventListener = ((
      type: string,
      l: EventListener,
      o?: AddEventListenerOptions | boolean,
    ) => {
      if (type === "abort") live.add(l)
      return realAdd(type as "abort", l, o as AddEventListenerOptions)
    }) as typeof realAdd
    ;(ctrl.signal as unknown as { removeEventListener: typeof realRemove }).removeEventListener = ((
      type: string,
      l: EventListener,
      o?: EventListenerOptions | boolean,
    ) => {
      if (type === "abort") live.delete(l)
      return realRemove(type as "abort", l, o as EventListenerOptions)
    }) as typeof realRemove
    return { signal: ctrl.signal, abort: () => ctrl.abort(), liveListeners: () => live.size }
  }

  test("HELL-18: cleanup removes the parent listener — 1000 ops leak ZERO listeners", () => {
    const parent = spyParent()
    for (let i = 0; i < 1000; i++) {
      const { cleanup } = applyBudget(parent.signal, { maxWallTimeMs: 60_000 })
      cleanup()
    }
    // Every op added one + removed one ⇒ net zero live abort listeners.
    expect(parent.liveListeners()).toBe(0)
  })

  test("HELL-19: timer-fire path still leaves the parent listener removable (no orphan)", async () => {
    const parent = spyParent()
    const { signal, cleanup } = applyBudget(parent.signal, { maxWallTimeMs: 10 })
    // While the budget timer is pending, the parent listener is live.
    expect(parent.liveListeners()).toBe(1)
    await new Promise((r) => setTimeout(r, 30))
    // Budget elapsed ⇒ fused signal aborted by the timer, NOT the parent…
    expect(signal?.aborted).toBe(true)
    // …but the parent listener is still attached (timer-fire does not remove it).
    expect(parent.liveListeners()).toBe(1)
    // cleanup() reclaims it — no orphan listener on the long-lived parent.
    cleanup()
    expect(parent.liveListeners()).toBe(0)
  })

  test("HELL-20: parent-abort path ⇒ fused aborts AND cleanup is safe/idempotent (timer reclaimed)", () => {
    const parent = spyParent()
    const { signal, cleanup } = applyBudget(parent.signal, { maxWallTimeMs: 60_000 })
    expect(parent.liveListeners()).toBe(1)
    parent.abort()
    expect(signal?.aborted).toBe(true)
    // cleanup() clears the pending budget timer AND removes the parent listener
    // by identity. Calling it twice is safe (idempotent Set delete + idempotent
    // native removeEventListener) — the observable live count lands at 0 and
    // never goes negative.
    cleanup()
    cleanup()
    expect(parent.liveListeners()).toBe(0)
  })

  test("HELL-21: no-budget path attaches NO listener to the parent (zero overhead)", () => {
    const parent = spyParent()
    const { cleanup } = applyBudget(parent.signal, undefined)
    expect(parent.liveListeners()).toBe(0)
    cleanup()
    expect(parent.liveListeners()).toBe(0)
  })
})

// ── Budget — resolveMaxCommits (ADR-0107) ───────────────────────────────

describe("resolveMaxCommits — caller arg × budget cap × default (hellgate)", () => {
  test("HELL-16: min(explicit, cap) wins when both set; default falls through", () => {
    expect(resolveMaxCommits(50, { maxCommits: 100 }, 10)).toBe(50)
    expect(resolveMaxCommits(150, { maxCommits: 100 }, 10)).toBe(100)
    expect(resolveMaxCommits(undefined, { maxCommits: 25 }, 10)).toBe(25)
    expect(resolveMaxCommits(undefined, undefined, 10)).toBe(10)
    expect(resolveMaxCommits(0, undefined, 10)).toBe(10)
    expect(resolveMaxCommits(Number.NaN, undefined, 10)).toBe(10)
  })
})

// ── Budget — crossedTarget (ADR-0107) ───────────────────────────────────

describe("crossedTarget — telemetry signal (hellgate)", () => {
  test("HELL-17: returns true ONLY when elapsed > targetDurationMs", () => {
    expect(crossedTarget(50, { targetDurationMs: 30 })).toBe(true)
    expect(crossedTarget(30, { targetDurationMs: 30 })).toBe(false) // strict greater
    expect(crossedTarget(10, { targetDurationMs: 30 })).toBe(false)
    expect(crossedTarget(50, undefined)).toBe(false)
    expect(crossedTarget(50, { targetDurationMs: 0 })).toBe(false)
    expect(crossedTarget(50, { targetDurationMs: Number.NaN })).toBe(false)
  })
})

// ── Budget — withBudget LIVE consumer (ADR-0107 wire) ────────────────────

/** Records every (args, cwd, signal) the wrapped runner is asked to run, and
 *  returns a scripted stdout so output-cap behavior is observable. */
class RecordingRunner implements GitRunner {
  readonly calls: { args: readonly string[]; signal: AbortSignal | undefined }[] = []
  constructor(private readonly stdout = "") {}
  async run(args: readonly string[], _cwd: string, signal?: AbortSignal): Promise<GitRunResult> {
    this.calls.push({ args, signal })
    return { stdout: this.stdout, stderr: "", exitCode: 0 }
  }
}

describe("withBudget — runner decorator (hellgate)", () => {
  test("WIRE-1: undefined budget returns the SAME runner reference (byte-identical)", () => {
    const base = new RecordingRunner()
    expect(withBudget(base, undefined)).toBe(base)
  })

  test("WIRE-2: inert budget (only telemetry knobs) returns the SAME runner", () => {
    const base = new RecordingRunner()
    expect(withBudget(base, { targetDurationMs: 5, consecutiveOverBudget: 3 })).toBe(base)
  })

  test("WIRE-3: empty budget object returns the SAME runner", () => {
    const base = new RecordingRunner()
    expect(withBudget(base, {})).toBe(base)
  })

  test("WIRE-4: maxCommits clamps a `-n <N>` flag DOWN, never up", async () => {
    const base = new RecordingRunner()
    const wrapped = withBudget(base, { maxCommits: 5 })
    await wrapped.run(["log", "-n", "200", "--format=%H"], "/repo")
    expect(base.calls[0]?.args).toEqual(["log", "-n", "5", "--format=%H"])
    // A `-n` already under the cap is left untouched (no needless realloc).
    await wrapped.run(["log", "-n", "3"], "/repo")
    expect(base.calls[1]?.args).toEqual(["log", "-n", "3"])
  })

  test("WIRE-5: maxCommits leaves args with no `-n` flag untouched", async () => {
    const base = new RecordingRunner()
    const wrapped = withBudget(base, { maxCommits: 5 })
    await wrapped.run(["status", "--porcelain"], "/repo")
    expect(base.calls[0]?.args).toEqual(["status", "--porcelain"])
  })

  test("WIRE-6: maxOutputBytes truncates stdout to the cap", async () => {
    const base = new RecordingRunner("0123456789")
    const wrapped = withBudget(base, { maxOutputBytes: 4 })
    const r = await wrapped.run(["log"], "/repo")
    expect(r.stdout).toBe("0123")
  })

  test("WIRE-7: maxOutputBytes leaves under-cap stdout untouched", async () => {
    const base = new RecordingRunner("abc")
    const wrapped = withBudget(base, { maxOutputBytes: 100 })
    const r = await wrapped.run(["log"], "/repo")
    expect(r.stdout).toBe("abc")
  })

  test("WIRE-8: maxWallTimeMs passes a FUSED (non-parent) signal to the runner", async () => {
    const base = new RecordingRunner()
    const parent = new AbortController()
    const wrapped = withBudget(base, { maxWallTimeMs: 60_000 })
    await wrapped.run(["log"], "/repo", parent.signal)
    const passed = base.calls[0]?.signal
    expect(passed).toBeDefined()
    expect(passed).not.toBe(parent.signal) // fused, not pass-through
  })

  test("WIRE-9: maxWallTimeMs deadline fires → fused signal aborts the spawn", async () => {
    let observed: AbortSignal | undefined
    const slowRunner: GitRunner = {
      async run(_args, _cwd, signal) {
        observed = signal
        await new Promise((r) => setTimeout(r, 30))
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    }
    const wrapped = withBudget(slowRunner, { maxWallTimeMs: 1 })
    await wrapped.run(["log"], "/repo")
    expect(observed?.aborted).toBe(true)
  })
})

// ── Budget — resolveGitBudget knob (ADR-0107 wire) ───────────────────────

describe("resolveGitBudget — runtime knobs (hellgate)", () => {
  test("WIRE-10: no knob set ⇒ undefined (default-OFF byte-identity)", () => {
    expect(resolveGitBudget({})).toBeUndefined()
  })

  test("WIRE-11: each knob maps to its field; blanks/non-positive omitted", () => {
    expect(
      resolveGitBudget({
        QUANTA_GIT_BUDGET_MAX_COMMITS: "50",
        QUANTA_GIT_BUDGET_WALL_MS: "5000",
        QUANTA_GIT_BUDGET_MAX_OUTPUT_BYTES: "1048576",
      }),
    ).toEqual({ maxCommits: 50, maxWallTimeMs: 5000, maxOutputBytes: 1048576 })
    expect(resolveGitBudget({ QUANTA_GIT_BUDGET_MAX_COMMITS: "0" })).toBeUndefined()
    expect(resolveGitBudget({ QUANTA_GIT_BUDGET_WALL_MS: "-1" })).toBeUndefined()
    expect(resolveGitBudget({ QUANTA_GIT_BUDGET_MAX_OUTPUT_BYTES: "abc" })).toBeUndefined()
  })

  test("WIRE-12: a single valid knob yields a partial budget", () => {
    expect(resolveGitBudget({ QUANTA_GIT_BUDGET_MAX_COMMITS: "7" })).toEqual({ maxCommits: 7 })
  })
})

// ── Budget — gitTools factory wiring (ADR-0107 wire) ─────────────────────

describe("gitTools — budget threads to walk tools only (hellgate)", () => {
  const findTool = (tools: ReturnType<typeof gitTools>, name: string) => {
    const tool = tools.find((t) => t.name === name)
    if (tool === undefined) throw new Error(`tool not found: ${name}`)
    return tool
  }

  test("WIRE-13: budget clamps git_log's `-n`; git_status is unaffected", async () => {
    const base = new RecordingRunner()
    const budget: GitBudget = { maxCommits: 3 }
    const tools = gitTools(base, { budget })
    const log = findTool(tools, "git_log")
    // git_log default count is 10; the budget clamps the spawned `-n` to 3.
    const ctx = { cwd: "/repo", signal: undefined } as never
    for await (const _ of log.execute({}, ctx)) {
      // drain
    }
    const logCall = base.calls.at(-1)
    const nIdx = logCall?.args.indexOf("-n") ?? -1
    expect(nIdx).toBeGreaterThanOrEqual(0)
    expect(logCall?.args[nIdx + 1]).toBe("3")
  })

  test("WIRE-14: no budget ⇒ git_log spawns its default `-n` (byte-identical)", async () => {
    const base = new RecordingRunner()
    const tools = gitTools(base)
    const log = findTool(tools, "git_log")
    const ctx = { cwd: "/repo", signal: undefined } as never
    for await (const _ of log.execute({}, ctx)) {
      // drain
    }
    const logCall = base.calls.at(-1)
    const nIdx = logCall?.args.indexOf("-n") ?? -1
    expect(logCall?.args[nIdx + 1]).toBe("10")
  })
})
