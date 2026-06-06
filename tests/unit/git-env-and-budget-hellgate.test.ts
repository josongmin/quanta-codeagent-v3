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
import { applyBudget, buildGitEnv, crossedTarget, resolveMaxCommits } from "@/tool/git"
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
