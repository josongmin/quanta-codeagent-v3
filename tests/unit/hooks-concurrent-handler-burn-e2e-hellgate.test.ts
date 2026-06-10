/**
 * HELLGATE (V2) — concurrent / many-handler CPU-burn + cumulative backpressure
 * on the HookBus emit pipeline.
 *
 * The sibling `hooks-timeout-cap-hellgate.test.ts` proves the SINGLE slow
 * handler case (one handler exceeds its per-handler timeout → dropped + logged
 * + bus continues). It does NOT prove what happens when MANY handlers on the
 * SAME event are slow / burning at once: the bus runs handlers SEQUENTIALLY
 * (`for … await this.runHandler(…)` in `emit*`), so the worst-case wall time of
 * one emit is the SUM of every handler's timeout. This file seals that the
 * cumulative cost stays BOUNDED (each handler is independently raced — N slow
 * handlers cost N × timeout, never unbounded), that a hung / throwing handler
 * is ISOLATED from its siblings + the rest of the emit, and that the
 * MAX_HANDLERS_PER_EVENT cap puts a hard ceiling on N.
 *
 * SEAM DISCIPLINE (no wall-clock assertions — per MEMORY no-heuristics):
 *   We never assert on `Date.now()` elapsed. Instead handlers are backed by a
 *   MANUALLY-CONTROLLED deferred (a promise we resolve ONLY AFTER `emit`
 *   returns) raced against a tiny real `timeoutMs`. We assert on OBSERVABLE
 *   EFFECTS — `emit` resolved at all, `timeoutCount === N`, the late
 *   resolution was DROPPED, the next handler ran — not on milliseconds. The
 *   bus's own `Promise.race` + `setTimeout` is the unit under test; the test
 *   runner's own per-test timeout is the backstop that an UNBOUNDED emit would
 *   trip (red-on-injection).
 *
 * HONEST LIMITATION (sealed, not papered over): the per-handler timeout uses
 * `setTimeout`, which can only fire when the event loop is FREE. A handler that
 * spins SYNCHRONOUSLY (a tight `while(true){}` with no `await`) starves the
 * loop and the timer can NEVER fire — JS is single-threaded, there is no
 * pre-emption. We do NOT claim protection we do not have: we assert the timeout
 * works for an ASYNC-YIELDING burn (the realistic shape — a handler awaiting
 * I/O / `setImmediate` in a loop) and we leave the sync-spin case documented as
 * a known residual rather than writing a test that would hang forever.
 *
 * Reaches `@/agent/hooks` directly (not the `@/agent` barrel) to avoid the
 * WIP-protected re-export surface, mirroring the sibling hellgate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  HookBus,
  MAX_HANDLERS_PER_EVENT,
  PAYLOAD_TRUNCATE_MARKER,
  truncatePayload,
} from "@/agent/hooks"
import { StructuredLogger } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"

/** Hermetic env reset — no QUANTA_* knob may leak into a bus default. */
const cleanEnv = (): void => {
  delete process.env.QUANTA_HOOK_TIMEOUT_MS
  delete process.env.QUANTA_HOOK_MAX_HANDLERS
  delete process.env.QUANTA_HOOK_MAX_PAYLOAD_BYTES
  __resetRuntimeConfig()
}

beforeEach(cleanEnv)
afterEach(cleanEnv)

/** A controllable handler seam: a promise that NEVER resolves on its own.
 *  The bus's timeout race is what releases the emit; we resolve `release`
 *  only AFTER `emit` returns to prove the late resolution is dropped (and to
 *  let the orphaned promise settle so the test leaves no dangling work). */
const makeBlocker = (): { handler: () => Promise<unknown>; release: () => void } => {
  let release!: () => void
  const gate = new Promise<unknown>((res) => {
    release = () => res({ promptHook: { injectAfterSystem: "LATE_AND_DROPPED" } })
  })
  return { handler: () => gate, release }
}

describe("HookBus V2 hellgate — many concurrent slow handlers, cumulative backpressure", () => {
  test("N blocked handlers on one event each time out independently → emit converges, timeoutCount === N", async () => {
    // Adversarial: register a LARGE batch of handlers that all block forever.
    // If the bus did NOT cap each handler, this emit would never resolve and
    // the test-runner timeout would RED. It resolves because each handler is
    // raced against its own tiny timeout — the cost is N independent races,
    // which is BOUNDED, not an unbounded join.
    const N = 32
    const bus = new HookBus()
    const releases: Array<() => void> = []
    for (let i = 0; i < N; i++) {
      const b = makeBlocker()
      releases.push(b.release)
      bus.on("turn_start", b.handler, { timeoutMs: 1 })
    }
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    // Release the orphaned promises so nothing dangles past the test.
    for (const r of releases) r()
    // Every one of the N handlers hit its independent timeout.
    expect(result.timeoutCount).toBe(N)
    // None of the (late, dropped) promptHooks leaked into the result.
    expect(result.promptHook).toBeUndefined()
  })

  test("MAX_HANDLERS_PER_EVENT (64) blocked handlers still converge — the cap is the hard ceiling on cumulative cost", async () => {
    // Fill the event to its absolute cap with blockers. This is the WORST
    // legal case: the maximum number of slow handlers the bus will ever run on
    // a single emit. It must still resolve (bounded), and the cap forbids a
    // 65th — so cumulative backpressure can never exceed 64 × timeout.
    const bus = new HookBus()
    const releases: Array<() => void> = []
    for (let i = 0; i < MAX_HANDLERS_PER_EVENT; i++) {
      const b = makeBlocker()
      releases.push(b.release)
      bus.on("turn_start", b.handler, { timeoutMs: 1 })
    }
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    for (const r of releases) r()
    expect(result.timeoutCount).toBe(MAX_HANDLERS_PER_EVENT)
    // The ceiling is enforced: a 65th registration is refused, so N is bounded.
    expect(() => bus.on("turn_start", () => undefined)).toThrow()
  })

  test("a hung handler does NOT block a later FAST handler on the same event (isolation)", async () => {
    // Sequential execution means a hung handler precedes a fast one — the fast
    // handler must still run AFTER the hung one is timed out, never blocked
    // behind it.
    const bus = new HookBus()
    const b = makeBlocker()
    let fastRan = false
    bus.on("turn_start", b.handler, { timeoutMs: 1 })
    bus.on("turn_start", () => {
      fastRan = true
      return { promptHook: { injectAfterSystem: "fast-survived" } }
    })
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    b.release()
    expect(fastRan).toBe(true)
    // The surviving fast handler's contribution IS present (proves the chain
    // continued past the hung slot, not just that it didn't crash).
    expect(result.promptHook?.injectAfterSystem).toBe("fast-survived")
    expect(result.timeoutCount).toBe(1)
  })

  test("a THROWING handler interleaved among slow ones is isolated — siblings + emit unaffected", async () => {
    const bus = new HookBus()
    const b1 = makeBlocker()
    const b2 = makeBlocker()
    let afterThrowRan = false
    bus.on("turn_start", b1.handler, { timeoutMs: 1 })
    bus.on("turn_start", () => {
      throw new Error("hostile handler explodes")
    })
    bus.on("turn_start", b2.handler, { timeoutMs: 1 })
    bus.on("turn_start", () => {
      afterThrowRan = true
    })
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    b1.release()
    b2.release()
    // Throw was swallowed; the chain ran to completion; both blockers timed out.
    expect(afterThrowRan).toBe(true)
    expect(result.timeoutCount).toBe(2)
    expect(result.deny).toBeNull()
  })

  test("ASYNC-yielding CPU-burn handler is timed out (realistic burn shape)", async () => {
    // A burn loop that AWAITS each iteration yields the event loop, so the
    // bus's setTimeout can fire and reclaim the slot. This is the realistic
    // "handler hot-loops over async work" shape. (Contrast the sync-spin case
    // below, which is a documented hard limit, not a guarantee we fake.)
    const bus = new HookBus()
    let stop = false
    let iterations = 0
    bus.on(
      "turn_start",
      async () => {
        while (!stop) {
          iterations++
          await new Promise((r) => setImmediate(r))
        }
        return { promptHook: { injectAfterSystem: "burned-late" } }
      },
      { timeoutMs: 1 },
    )
    let secondRan = false
    bus.on("turn_start", () => {
      secondRan = true
    })
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    stop = true // let the orphaned burn loop exit
    expect(result.timeoutCount).toBe(1)
    expect(secondRan).toBe(true)
    // The burn handler's late return is dropped — its promptHook is absent.
    expect(result.promptHook).toBeUndefined()
    expect(iterations).toBeGreaterThan(0) // it actually started burning
  })

  test("the per-emit timeoutCount is the ONLY accumulator that grows — bounded result shape", async () => {
    // A many-timeout emit must not balloon the result into something unbounded
    // (e.g. one log/field per timed-out handler accumulating in the returned
    // object). The result carries a single integer count, nothing per-handler.
    const N = 16
    const bus = new HookBus()
    const releases: Array<() => void> = []
    for (let i = 0; i < N; i++) {
      const b = makeBlocker()
      releases.push(b.release)
      bus.on("post_tool_use", b.handler, { timeoutMs: 1 })
    }
    const result = await bus.emit({
      type: "post_tool_use",
      name: "x",
      input: {},
      ok: true,
      output: "",
    })
    for (const r of releases) r()
    expect(result.timeoutCount).toBe(N)
    // No promptHook / abort / toolOverride were produced (all handlers timed
    // out before returning anything) — the result is the lean legacy shape + count.
    expect(result.promptHook).toBeUndefined()
    expect(result.abort).toBeUndefined()
    expect(result.toolOverride).toBeUndefined()
  })
})

describe("HookBus V2 hellgate — red-on-injection (timeout / cap are load-bearing)", () => {
  test("INJECTION SIMULATION: a per-emit ceiling exists (no timeout ⇒ blockers hang forever)", async () => {
    // This documents WHAT the guard buys us. We construct the exact adversarial
    // shape (many never-resolving handlers) but WITHOUT a timeout, and prove it
    // would hang — by racing emit against a watchdog. The watchdog winning is
    // the proof that, absent the per-handler timeout, the emit is UNBOUNDED.
    // The PRESENCE of `timeoutMs` (exercised in every test above) is exactly
    // what flips this from "watchdog wins / hang" to "emit wins / converges".
    const bus = new HookBus()
    const releases: Array<() => void> = []
    for (let i = 0; i < 8; i++) {
      const b = makeBlocker()
      releases.push(b.release)
      // NB: NO timeoutMs, NO env knob ⇒ legacy unbounded path.
      bus.on("turn_start", b.handler)
    }
    const WATCHDOG = Symbol("watchdog")
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<typeof WATCHDOG>((res) => {
      timer = setTimeout(() => res(WATCHDOG), 50)
    })
    const winner = await Promise.race([
      bus.emit({ type: "turn_start", turn: 1 }).then(() => "emit" as const),
      watchdog,
    ])
    if (timer !== undefined) clearTimeout(timer)
    for (const r of releases) r() // unblock so the orphaned emit can settle
    // The watchdog WON — the unbounded emit never resolved on its own. This is
    // the RED state the per-handler timeout converts to GREEN.
    expect(winner).toBe(WATCHDOG)
  })

  test("with timeoutMs the SAME adversarial shape converges (GREEN counterpart)", async () => {
    // Byte-for-byte the prior test's shape, only difference = `timeoutMs`. It
    // converges — proving the timeout is the load-bearing flip, not an
    // incidental of the handler bodies.
    const bus = new HookBus()
    const releases: Array<() => void> = []
    for (let i = 0; i < 8; i++) {
      const b = makeBlocker()
      releases.push(b.release)
      bus.on("turn_start", b.handler, { timeoutMs: 1 })
    }
    const WATCHDOG = Symbol("watchdog")
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<typeof WATCHDOG>((res) => {
      timer = setTimeout(() => res(WATCHDOG), 1000)
    })
    const winner = await Promise.race([
      bus.emit({ type: "turn_start", turn: 1 }).then(() => "emit" as const),
      watchdog,
    ])
    if (timer !== undefined) clearTimeout(timer)
    for (const r of releases) r()
    // emit WON the race against a generous 1s watchdog — bounded convergence.
    expect(winner).toBe("emit")
  })
})

describe("HookBus V2 hellgate — payload truncation false-negative on a SECURITY hook seam", () => {
  // `permission_request` is a REAL security seam: the admissibility gate
  // (src/agent/admissibility-gate.ts:1738) emits it and a handler may return a
  // deny/allow/ask decision the gate honors BEFORE its policy stack. So a
  // truncated `input` reaching such a handler is a genuine false-NEGATIVE
  // surface: a dangerous suffix dropped past the per-field budget is hidden
  // from a handler that scans `input` for dangerous args.
  test("a dangerous arg PAST the per-field budget is dropped before the security handler sees it — marker is the ONLY signal", async () => {
    const bus = new HookBus(undefined, { maxPayloadBytes: 256 })
    let observed: { command?: string } | undefined
    bus.on("permission_request", (e) => {
      observed = e.input as { command?: string }
      return undefined
    })
    // The dangerous payload (`&& rm -rf /`) is buried AFTER a long pad that
    // overruns the per-field budget (maxBytes/4 ≈ 64 chars).
    const padded = `${"A".repeat(2000)} && rm -rf /`
    await bus.emit({
      type: "permission_request",
      name: "shell",
      input: { command: padded },
      tier: "always-confirm",
      cwd: "/",
    })
    const seenCmd = observed?.command ?? ""
    // The dangerous suffix is GONE (truncation dropped it) ...
    expect(seenCmd.includes("rm -rf /")).toBe(false)
    // ... and the marker is the ONLY breadcrumb a security handler has to know
    // data was lost. A handler that ignores the marker would false-ALLOW. This
    // test SEALS that the marker is present so a marker-aware handler can
    // fail-closed; if truncation ever became silent (marker removed) this REDs.
    expect(seenCmd.includes(PAYLOAD_TRUNCATE_MARKER)).toBe(true)
  })

  test("truncatePayload exposes truncation to the caller (truncated:true) so a seam CAN fail-closed", () => {
    // The lower-level contract the security seam relies on: truncation is never
    // silent at the helper boundary either — `{truncated:true}` is returned so
    // a caller that wants to deny-on-truncation has the signal.
    const padded = `${"A".repeat(2000)} && rm -rf /`
    const out = truncatePayload(
      { type: "permission_request", name: "shell", input: { command: padded }, tier: "x", cwd: "/" },
      256,
    )
    expect(out.truncated).toBe(true)
  })
})

describe("HookBus V2 hellgate — DEFAULT path is unaffected (no-burn baseline)", () => {
  test("a single fast handler with NO timeout is byte-identical legacy (no timeoutCount field)", async () => {
    const bus = new HookBus()
    let ran = false
    bus.on("turn_start", () => {
      ran = true
    })
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(ran).toBe(true)
    expect(result.timeoutCount).toBeUndefined()
    expect(result.deny).toBeNull()
  })

  test("several fast handlers all run, none counted as timed-out", async () => {
    const bus = new HookBus()
    let count = 0
    for (let i = 0; i < 8; i++) {
      bus.on("turn_start", () => {
        count++
      }, { timeoutMs: 1000 })
    }
    const result = await bus.emit({ type: "turn_start", turn: 1 })
    expect(count).toBe(8)
    expect(result.timeoutCount).toBeUndefined()
  })

  test("anti-leak holds under MANY timeouts — no payload in any warning line", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    const releases: Array<() => void> = []
    for (let i = 0; i < 8; i++) {
      const b = makeBlocker()
      releases.push(b.release)
      bus.on("pre_tool_use", b.handler, { timeoutMs: 1 })
    }
    await bus.emit({
      type: "pre_tool_use",
      name: "write",
      input: { secret: "TOP_SECRET_BURN_VALUE" },
    })
    for (const r of releases) r()
    const text = lines.join("\n")
    // Every timeout warning must omit the payload — even at 8× volume.
    expect(text).not.toContain("TOP_SECRET_BURN_VALUE")
    expect(text).not.toContain("secret")
    expect(lines.filter((l) => l.includes("hook.handler.timeout")).length).toBe(8)
  })
})
