/**
 * ★ HELLGATE — Ticket 18 (V1): Ctrl+B detach at the turn-cancel FSM + turn-runner.
 *
 * Two seams under test:
 *
 *  (A) turn-cancel-install FSM — a synthetic Ctrl+B keypress fires `onBackground`
 *      (and ONLY that), above the Esc branch, below Ctrl+C (abort always wins).
 *      RED-ON-INJECTION: with `onBackground` UNDEFINED, Ctrl+B is a NO-OP and the
 *      FSM is byte-identical (neither onCancel nor onAbort fire).
 *
 *  (B) turn-runner race — a body that never resolves + a fired Ctrl+B ⇒
 *      `runOneTurn` resolves `{ backgrounded:true, result:undefined }`,
 *      `onAfterResult` is NOT called, `turnAbort.signal.aborted === false`
 *      (the body is NOT cancelled — it keeps running, owned by the portal), and
 *      `onMovedToBackground` receives the LIVE body promise + the turn's
 *      AbortController.
 *
 *  (C) DEFAULT-OFF byte-identity — with NO `onMovedToBackground` wired, a
 *      resolving body funnels through the legacy path: `backgrounded` is
 *      absent/false, `onAfterResult` fires, result is preserved.
 *
 * The FSM is exercised by intercepting the stdin `keypress` listener
 * `installTurnCancel` registers (raw-mode TTY path), then invoking it with
 * synthetic key objects — the SAME technique the keybindings hellgate uses.
 */

import { describe, expect, mock, test } from "bun:test"
import type { StatusBar } from "../status-bar"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"
import { createBackgroundTurnPortal } from "../repl/background-turn-portal"
import type { ConversationActionSurface } from "../repl/conversation-action-surface"
import { shouldWireBackground } from "../repl/session-loop"
import { installTurnCancel } from "../repl/turn-cancel-install"
import { runOneTurn } from "../repl/turn-runner"

type Key = { name?: string; ctrl?: boolean }
type KeyListener = (str: string | undefined, key: Key | undefined) => void

/** A fake raw-mode TTY stdin that captures the `keypress` listener so a test can
 *  drive synthetic keys. Mirrors the node:readline keypress contract the FSM
 *  binds to. */
const makeFakeStdin = (): {
  stdin: NodeJS.ReadStream
  press: (key: Key) => void
} => {
  let listener: KeyListener | undefined
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    // `emitKeypressEvents` probes `listenerCount("keypress")` before binding its
    // internal data→keypress decoder; report 0 so it installs cleanly.
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
  return {
    stdin,
    press: (key: Key) => listener?.(undefined, key),
  }
}

const fakeStatusBar = (): StatusBar =>
  ({ transient: () => {} }) as unknown as StatusBar

/** Run the FSM against an injected stdin by temporarily swapping process.stdin. */
const withFakeStdin = <T>(
  fake: ReturnType<typeof makeFakeStdin>,
  fn: () => T,
): T => {
  const orig = Object.getOwnPropertyDescriptor(process, "stdin")
  Object.defineProperty(process, "stdin", { value: fake.stdin, configurable: true })
  try {
    return fn()
  } finally {
    if (orig !== undefined) Object.defineProperty(process, "stdin", orig)
  }
}

describe("(A) turn-cancel FSM — Ctrl+B fires onBackground only", () => {
  test("synthetic ctrl+b ⇒ onBackground called; onCancel/onAbort NOT", () => {
    const fake = makeFakeStdin()
    const onCancel = mock(() => {})
    const onAbort = mock(() => {})
    const onBackground = mock(() => {})
    const handle = withFakeStdin(fake, () =>
      installTurnCancel({
        statusBar: fakeStatusBar(),
        escWindowMs: 2000,
        onCancel,
        onAbort,
        onBackground,
      }),
    )
    fake.press({ ctrl: true, name: "b" })
    expect(onBackground).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onAbort).not.toHaveBeenCalled()
    handle.dispose()
  })

  test("ctrl+c still wins above ctrl+b (abort precedence preserved)", () => {
    const fake = makeFakeStdin()
    const onAbort = mock(() => {})
    const onBackground = mock(() => {})
    const handle = withFakeStdin(fake, () =>
      installTurnCancel({
        statusBar: fakeStatusBar(),
        escWindowMs: 2000,
        onCancel: () => {},
        onAbort,
        onBackground,
      }),
    )
    fake.press({ ctrl: true, name: "c" })
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onBackground).not.toHaveBeenCalled()
    handle.dispose()
  })

  test("RED-ON-INJECTION: onBackground UNDEFINED ⇒ ctrl+b is a no-op (byte-identical FSM)", () => {
    const fake = makeFakeStdin()
    const onCancel = mock(() => {})
    const onAbort = mock(() => {})
    const handle = withFakeStdin(fake, () =>
      installTurnCancel({
        statusBar: fakeStatusBar(),
        escWindowMs: 2000,
        onCancel,
        onAbort,
        // onBackground intentionally absent
      }),
    )
    fake.press({ ctrl: true, name: "b" })
    expect(onCancel).not.toHaveBeenCalled()
    expect(onAbort).not.toHaveBeenCalled()
    // The FSM must still process a subsequent Esc-Esc exactly as before.
    fake.press({ name: "escape" })
    fake.press({ name: "escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
    handle.dispose()
  })
})

const fakeIndicator = (): { ind: TurnIndicator; started: () => number; stopped: () => number } => {
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

describe("(B) turn-runner — Ctrl+B backgrounds a never-resolving body", () => {
  test("fired onBackground ⇒ {backgrounded:true, result:undefined}, body NOT cancelled", async () => {
    const fake = makeFakeStdin()
    const outer = new AbortController()
    const onAfterResult = mock(() => {})
    let movedBody: Promise<unknown> | undefined
    let movedAbort: AbortController | undefined

    // The body NEVER resolves — only a Ctrl+B can settle the turn.
    const body = (_sig: AbortSignal): Promise<{ ok: true }> =>
      new Promise<{ ok: true }>(() => {})

    const ind = fakeIndicator()
    const runP = withFakeStdin(fake, () =>
      runOneTurn<{ ok: true }>(
        {
          outerAbort: outer,
          statusBar: fakeStatusBar(),
          turnIndicator: ind.ind,
          turnSummary: fakeSummary(),
          escWindowMs: 2000,
          body,
          onMovedToBackground: (h) => {
            movedBody = h.body
            movedAbort = h.turnAbort
          },
        },
        { onAfterResult },
      ),
    )
    // Let the runner install the FSM + start the body, then press Ctrl+B.
    await new Promise((r) => setTimeout(r, 5))
    fake.press({ ctrl: true, name: "b" })
    const out = await runP

    expect(out.backgrounded).toBe(true)
    expect(out.result).toBeUndefined()
    expect(onAfterResult).not.toHaveBeenCalled()
    // The body is NOT cancelled — it keeps running, owned by the portal.
    expect(movedAbort?.signal.aborted).toBe(false)
    // onMovedToBackground received the LIVE body promise.
    expect(movedBody).toBeInstanceOf(Promise)
    // The indicator was stopped (stdin released) so the next prompt can re-attach.
    expect(ind.stopped()).toBeGreaterThanOrEqual(1)
  })
})

describe("(C) DEFAULT-OFF byte-identity — no onMovedToBackground wired", () => {
  test("resolving body ⇒ legacy path: backgrounded absent/false, onAfterResult fires, result preserved", async () => {
    const onAfterResult = mock(() => {})
    const ind = fakeIndicator()
    const out = await runOneTurn<{ value: number }>(
      {
        outerAbort: new AbortController(),
        statusBar: fakeStatusBar(),
        turnIndicator: ind.ind,
        turnSummary: fakeSummary(),
        escWindowMs: 2000,
        body: async () => ({ value: 7 }),
        // onMovedToBackground intentionally absent ⇒ default-OFF.
      },
      { onAfterResult },
    )
    expect(out.result).toEqual({ value: 7 })
    expect(out.backgrounded ?? false).toBe(false)
    expect(onAfterResult).toHaveBeenCalledTimes(1)
  })
})

const idleConvActions = (interrupted: boolean): ConversationActionSurface =>
  ({
    activeTurnRef: { current: { currentTurn: null, isInterrupted: interrupted } },
  }) as unknown as ConversationActionSurface

describe("(D) WEAVE guard — shouldWireBackground", () => {
  test("portal present + queue mode + no conv actions ⇒ WIRED", () => {
    const portal = createBackgroundTurnPortal()
    expect(
      shouldWireBackground({
        portal,
        inboundMode: { current: "queue" },
        conversationActions: undefined,
      }),
    ).toBe(true)
  })

  test("inboundMode 'weave' ⇒ NOT wired (background disabled in weave mode)", () => {
    const portal = createBackgroundTurnPortal()
    expect(
      shouldWireBackground({
        portal,
        inboundMode: { current: "weave" },
        conversationActions: undefined,
      }),
    ).toBe(false)
  })

  test("inboundMode 'queue' ⇒ WIRED even with an idle conversation-action surface", () => {
    const portal = createBackgroundTurnPortal()
    expect(
      shouldWireBackground({
        portal,
        inboundMode: { current: "queue" },
        conversationActions: idleConvActions(false),
      }),
    ).toBe(true)
  })

  test("mid-interrupt conversation-action surface ⇒ NOT wired", () => {
    const portal = createBackgroundTurnPortal()
    expect(
      shouldWireBackground({
        portal,
        inboundMode: { current: "queue" },
        conversationActions: idleConvActions(true),
      }),
    ).toBe(false)
  })

  test("portal absent ⇒ NOT wired (default-OFF)", () => {
    expect(
      shouldWireBackground({
        portal: undefined,
        inboundMode: { current: "queue" },
        conversationActions: undefined,
      }),
    ).toBe(false)
  })
})
