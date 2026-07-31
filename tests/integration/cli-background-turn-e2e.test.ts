/**
 * TRUE end-to-end for the Ctrl+B "background-turn" portal (ticket-18 / feature
 * `cli-background-turn`), driven by a FAKE LLM through a REAL `runAgent` turn
 * body flowing through the REAL `runOneTurn` per-turn wrapper into a REAL
 * `createBackgroundTurnPortal`.
 *
 * The existing hellgates cover the layers in isolation:
 *   - `background-turn-portal.hellgate` — portal registry with SYNTHETIC
 *     `Promise.resolve/reject` bodies (never a real turn).
 *   - `background-ctrlb-turn-runner.hellgate` — `runOneTurn` with a
 *     never-resolving `() => new Promise(() => {})` body (never a real turn),
 *     and the portal is not on the other side of the handoff.
 *
 * NEITHER exercises the load-bearing seam this feature is flagged HIGHEST-RISK
 * for: a LIVE `runAgent` turn body + its turn-scoped AbortController handed over
 * to the portal mid-flight, then rejoined/collected. This file closes that gap:
 *
 *   fake LLM (paused mid-stream) drives a real runAgent turn
 *     → runOneTurn starts the body, installs the Ctrl+B FSM
 *       → synthetic Ctrl+B keypress mid-turn
 *         → onMovedToBackground hands the LIVE body promise + turnAbort to the portal
 *           → portal.detach registers a 'running' entry (NO re-await, NO abort)
 *             → the real body is released and runs to completion
 *               → portal's NO-THROW observer flips 'running' → terminal state
 *                 → reattach/collect yields the COMPLETED runAgent result
 *
 * Layer covered: the portal + the real `runOneTurn` wrapper + a real `runAgent`
 * body — i.e. everything BELOW the raw interactive PTY. The one seam this does
 * NOT drive is the physical terminal keypress delivery (node:readline raw mode);
 * that is pinned by the FSM hellgate's synthetic-key technique, reused here.
 *
 * Assertions (the three invariants the ticket flags as fragile):
 *   (a) clean handover — the detached body promise + AbortController are handed
 *       over with NO throw into a terminal state and NO unhandled rejection;
 *   (b) rejoin/collect — after the real body settles, the portal captures the
 *       COMPLETED runAgent result and reattach() surfaces it;
 *   (c) cleanup — the turn indicator is stopped (stdin released for the next
 *       prompt), the body was NOT cancelled by the handover, and cancel() cleanly
 *       unwinds a still-running background body via its signal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig, AgentOutcome } from "@/agent"
import { runAgent } from "@/agent"
import { createBackgroundTurnPortal } from "@/apps/cli/repl/background-turn-portal"
import { runOneTurn } from "@/apps/cli/repl/turn-runner"
import type { StatusBar } from "@/apps/cli/status-bar"
import type { TurnIndicator } from "@/apps/cli/turn-indicator"
import type { TurnSummaryCollector } from "@/apps/cli/turn-summary"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { cfg, RecordingStream, withTimeout } from "./_harness"

// ── fake-stdin plumbing (mirrors background-ctrlb-turn-runner.hellgate) ──────

type Key = { name?: string; ctrl?: boolean }
type KeyListener = (str: string | undefined, key: Key | undefined) => void

/** A fake raw-mode TTY stdin capturing the `keypress` listener `installTurnCancel`
 *  registers, so the test can drive synthetic keys — the SAME technique the FSM
 *  hellgate uses (the ONE layer below this we cannot exercise without a real PTY). */
const makeFakeStdin = (): { stdin: NodeJS.ReadStream; press: (key: Key) => void } => {
  let listener: KeyListener | undefined
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    listenerCount: () => 0,
    on: (event: string, cb: KeyListener) => {
      if (event === "keypress") listener = cb
      return stdin
    },
    addListener: (event: string, cb: KeyListener) => {
      if (event === "keypress") listener = cb
      return stdin
    },
    removeListener: () => stdin,
  } as unknown as NodeJS.ReadStream
  return { stdin, press: (key: Key) => listener?.(undefined, key) }
}

const withFakeStdin = <T>(fake: ReturnType<typeof makeFakeStdin>, fn: () => T): T => {
  const orig = Object.getOwnPropertyDescriptor(process, "stdin")
  Object.defineProperty(process, "stdin", { value: fake.stdin, configurable: true })
  try {
    return fn()
  } finally {
    if (orig !== undefined) Object.defineProperty(process, "stdin", orig)
  }
}

const fakeStatusBar = (): StatusBar => ({ transient: () => {} }) as unknown as StatusBar

const fakeIndicator = (): {
  ind: TurnIndicator
  started: () => number
  stopped: () => number
} => {
  let starts = 0
  let stops = 0
  const ind = {
    start: () => {
      starts += 1
    },
    stop: () => {
      stops += 1
    },
  } as unknown as TurnIndicator
  return { ind, started: () => starts, stopped: () => stops }
}

const fakeSummary = (): TurnSummaryCollector =>
  ({ reset: () => {} }) as unknown as TurnSummaryCollector

// ── a REAL runAgent body that pauses mid-stream until released ───────────────

/** A gate the test opens to let a paused LLM stream proceed. */
const makeGate = (): { wait: Promise<void>; open: () => void } => {
  let open: () => void = () => {}
  const wait = new Promise<void>((r) => {
    open = r
  })
  return { wait, open }
}

/**
 * An LLM whose FIRST turn blocks inside `stream()` until `gate` opens (so the
 * real `runAgent` turn is genuinely mid-flight when Ctrl+B fires), then emits a
 * finishing text. Cooperatively honors `input.signal` so a cancel unwinds the
 * body via its abort signal (surfacing the real cancellation path — not a synthetic
 * `Promise.reject(AbortError)`). Records how many times it was entered.
 */
class PausingLLM implements LLMPort {
  readonly model = "pausing-test-model"
  calls = 0
  aborted = false
  constructor(
    private readonly gate: { wait: Promise<void>; open: () => void },
    private readonly finalText: string,
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    // Block until the test releases the gate OR the turn signal aborts.
    await new Promise<void>((resolve, reject) => {
      const sig = input.signal
      if (sig?.aborted) {
        reject(abortError())
        return
      }
      const onAbort = (): void => {
        this.aborted = true
        reject(abortError())
      }
      sig?.addEventListener("abort", onAbort, { once: true })
      this.gate.wait.then(() => {
        sig?.removeEventListener("abort", onAbort)
        resolve()
      })
    })
    const events: StreamEvent[] = [
      { type: "text_delta", delta: this.finalText },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    for (const e of events) yield e
  }
}

const abortError = (): Error => {
  const e = new Error("aborted")
  e.name = "AbortError"
  return e
}

/** Build the `runOneTurn` body that runs a REAL `runAgent` with the turn signal
 *  threaded into the agent config (so a turn-scoped abort propagates into the
 *  live LLM stream — the real cancellation path). */
const realAgentBody =
  (llm: LLMPort, over: Partial<AgentConfig> = {}) =>
  (turnSignal: AbortSignal): Promise<AgentOutcome> =>
    runAgent(
      cfg({
        llm,
        stream: new RecordingStream(),
        messages: [{ role: "user", content: [{ type: "text", text: "GO" }] }],
        maxTurns: 4,
        signal: turnSignal,
        ...over,
      }),
    )

// ── the e2e ──────────────────────────────────────────────────────────────────

describe("cli-background-turn — real runAgent body detached→rejoined through the portal", () => {
  beforeEach(() => __resetRuntimeConfig())
  afterEach(() => __resetRuntimeConfig())

  test("(a+b+c) Ctrl+B mid-turn hands a LIVE runAgent body to the portal; release ⇒ completed result rejoined; cleanup done", async () => {
    const portal = createBackgroundTurnPortal()
    const gate = makeGate()
    const llm = new PausingLLM(gate, "BG-DONE final answer")
    const fake = makeFakeStdin()
    const outer = new AbortController()
    const ind = fakeIndicator()

    let detachedId: string | undefined
    let handedBody: Promise<AgentOutcome> | undefined
    let handedAbort: AbortController | undefined

    const runP = withFakeStdin(fake, () =>
      runOneTurn<AgentOutcome>(
        {
          outerAbort: outer,
          statusBar: fakeStatusBar(),
          turnIndicator: ind.ind,
          turnSummary: fakeSummary(),
          escWindowMs: 2000,
          body: realAgentBody(llm),
          onMovedToBackground: (h) => {
            handedBody = h.body
            handedAbort = h.turnAbort
            // The portal takes the SAME live promise + the turn's controller.
            detachedId = portal.detach<AgentOutcome>({
              label: "investigate the flake",
              promise: h.body,
              abort: h.turnAbort,
            })
          },
        },
        {},
      ),
    )

    // Let the runner start the body + install the FSM, then press Ctrl+B while
    // the real runAgent turn is BLOCKED inside the (paused) LLM stream.
    await new Promise((r) => setTimeout(r, 10))
    expect(llm.calls).toBeGreaterThanOrEqual(1) // the real turn actually started
    fake.press({ ctrl: true, name: "b" })

    const turnOut = await withTimeout(runP, 10_000, "runOneTurn-background")

    // (a) CLEAN HANDOVER — the turn resolved via the background branch, NOT a
    //     throw into a terminal error. result is undefined, body NOT aborted.
    expect(turnOut.backgrounded).toBe(true)
    expect(turnOut.result).toBeUndefined()
    expect(handedBody).toBeInstanceOf(Promise)
    expect(handedAbort?.signal.aborted).toBe(false) // handover did NOT cancel it
    expect(detachedId).toBeDefined()
    if (detachedId === undefined) return

    // The portal registered a LIVE 'running' entry (before the body settled).
    const running = portal.get(detachedId)
    expect(running?.state).toBe("running")
    expect(running?.label).toBe("investigate the flake")

    // (c) CLEANUP — the indicator was stopped so the next prompt re-attaches stdin.
    expect(ind.stopped()).toBeGreaterThanOrEqual(1)

    // The real body is STILL running (paused in the LLM stream) — release it.
    gate.open()

    // (b) REJOIN/COLLECT — once the real runAgent turn completes, the portal's
    //     NO-THROW observer flips 'running' → 'done' and captures the COMPLETED
    //     runAgent outcome (reachable via reattach — the read-only collect path).
    await withTimeout(
      (async () => {
        for (let i = 0; i < 200; i++) {
          if (portal.get(detachedId)?.state !== "running") return
          await new Promise((r) => setTimeout(r, 2))
        }
      })(),
      10_000,
      "portal-settle",
    )

    const settled = portal.get(detachedId)
    expect(settled?.state).toBe("done")
    const result = settled?.result as AgentOutcome | undefined
    expect(result?.reason).toBe("completed") // the REAL agent outcome, collected
    expect(handedAbort?.signal.aborted).toBe(false) // still never cancelled

    // reattach() (the /background read-only collect) surfaces the completed result.
    const re = portal.reattach(detachedId)
    expect(re?.running).toBe(false)
    expect(re?.state).toBe("done")
    expect((re?.result as AgentOutcome | undefined)?.reason).toBe("completed")

    // No unhandled rejection escaped (the whole test would crash on one). Also
    // await the handed body directly to prove it settled cleanly (idempotent).
    const direct = await withTimeout(handedBody as Promise<AgentOutcome>, 5_000, "handed-body")
    expect(direct.reason).toBe("completed")
  })

  test("(c) cancel() on a backgrounded LIVE runAgent body unwinds it via its signal — no throw into a lost terminal state", async () => {
    const portal = createBackgroundTurnPortal()
    const gate = makeGate() // never opened: only a cancel can settle the body
    const llm = new PausingLLM(gate, "SHOULD-NOT-REACH")
    const fake = makeFakeStdin()
    const ind = fakeIndicator()

    let detachedId: string | undefined
    const runP = withFakeStdin(fake, () =>
      runOneTurn<AgentOutcome>(
        {
          outerAbort: new AbortController(),
          statusBar: fakeStatusBar(),
          turnIndicator: ind.ind,
          turnSummary: fakeSummary(),
          escWindowMs: 2000,
          body: realAgentBody(llm),
          onMovedToBackground: (h) => {
            detachedId = portal.detach<AgentOutcome>({
              label: "long task",
              promise: h.body,
              abort: h.turnAbort,
            })
          },
        },
        {},
      ),
    )

    await new Promise((r) => setTimeout(r, 10))
    fake.press({ ctrl: true, name: "b" })
    await withTimeout(runP, 10_000, "runOneTurn-background-cancel")
    expect(detachedId).toBeDefined()
    if (detachedId === undefined) return
    expect(portal.get(detachedId)?.state).toBe("running")

    // Cancel the backgrounded turn: fires the turn's AbortController, which
    // propagates through the composite turn-signal into the live LLM stream.
    portal.cancel(detachedId)
    expect(portal.get(detachedId)?.abort.signal.aborted).toBe(true)
    expect(llm.aborted).toBe(true) // the real body observed the abort

    // The body must reach a terminal state cleanly — NOT hang, NOT throw an
    // unhandled rejection. `runAgent` resolves `reason:"aborted"` on signal abort
    // (it does NOT reject), so the portal's `.then` records state 'done' with an
    // aborted outcome. Either way it must LEAVE 'running' with no escape.
    await withTimeout(
      (async () => {
        for (let i = 0; i < 200; i++) {
          if (portal.get(detachedId)?.state !== "running") return
          await new Promise((r) => setTimeout(r, 2))
        }
      })(),
      10_000,
      "portal-cancel-settle",
    )

    const settled = portal.get(detachedId)
    expect(settled?.state).not.toBe("running") // reached a terminal state
    // runAgent swallows the abort into a resolved outcome ⇒ 'done' + aborted reason.
    expect(settled?.state).toBe("done")
    expect((settled?.result as AgentOutcome | undefined)?.reason).toBe("aborted")

    // cancel() is idempotent + NO-THROW on the already-aborted controller.
    expect(() => portal.cancel(detachedId as string)).not.toThrow()
  })
})
