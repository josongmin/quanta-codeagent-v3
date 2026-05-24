import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { installTurnCancel } from "../../../../src/apps/cli/repl/turn-cancel-install"
import type { StatusBar } from "../../../../src/apps/cli/status-bar"

// In-memory StatusBar stub — records every transient call so tests can
// assert paint order without needing a real TTY.
interface StubStatusBar extends StatusBar {
  readonly calls: Array<{ text: string; ms?: number }>
}
const stubStatusBar = (): StubStatusBar => {
  const calls: Array<{ text: string; ms?: number }> = []
  return {
    setDefault: () => undefined,
    transient: (text, ms) => calls.push({ text, ...(ms !== undefined ? { ms } : {}) }),
    clearTransient: () => undefined,
    teardown: () => undefined,
    calls,
  }
}

// In-memory stdin fake that supports the API surface installTurnCancel uses
// (including `emitKeypressEvents`, which probes `listenerCount("keypress")`
// before subscribing its byte-decoder — so the fake must satisfy that too).
type KeyListener = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => void
interface FakeStdin {
  isTTY: true
  isRaw: boolean
  setRawMode: (raw: boolean) => void
  resume: () => void
  pause: () => void
  on: (event: string, listener: KeyListener) => FakeStdin
  removeListener: (event: string, listener: KeyListener) => FakeStdin
  listenerCount: (event: string) => number
  emit: (key: { name?: string; ctrl?: boolean }) => void
}
const makeFakeStdin = (): FakeStdin => {
  const listeners: KeyListener[] = []
  return {
    isTTY: true,
    isRaw: false,
    setRawMode(raw) {
      this.isRaw = raw
    },
    resume: () => undefined,
    pause: () => undefined,
    on(event, listener) {
      if (event === "keypress") listeners.push(listener)
      return this
    },
    removeListener(event, listener) {
      if (event !== "keypress") return this
      const i = listeners.indexOf(listener)
      if (i >= 0) listeners.splice(i, 1)
      return this
    },
    listenerCount(event) {
      // emitKeypressEvents checks `listenerCount("keypress") === 0` to decide
      // whether to wire its byte-decoder. Returning >0 short-circuits that.
      if (event === "keypress") return listeners.length + 1
      return 0
    },
    emit(key) {
      for (const l of [...listeners]) l(undefined, key)
    },
  }
}

let originalStdin: NodeJS.ReadStream
let fakeStdin: FakeStdin

beforeEach(() => {
  originalStdin = process.stdin
  fakeStdin = makeFakeStdin()
  // biome-ignore lint/suspicious/noExplicitAny: testing — stdin swap requires any
  Object.defineProperty(process, "stdin", { value: fakeStdin as any, configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true })
})

describe("turn-cancel-install — FSM behavior", () => {
  test("non-TTY stdin returns a no-op dispose without subscribing", () => {
    Object.defineProperty(process, "stdin", {
      value: { isTTY: false } as Partial<NodeJS.ReadStream>,
      configurable: true,
    })
    const { dispose } = installTurnCancel({
      statusBar: stubStatusBar(),
      escWindowMs: 2000,
      onCancel: () => undefined,
      onAbort: () => undefined,
    })
    expect(typeof dispose).toBe("function")
    dispose() // must not throw
  })

  test("first Esc paints the 2 s hint but does NOT fire onCancel", () => {
    const status = stubStatusBar()
    const onCancel = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 2000,
      onCancel,
      onAbort: () => undefined,
    })
    fakeStdin.emit({ name: "escape" })
    expect(onCancel).not.toHaveBeenCalled()
    expect(status.calls).toEqual([
      { text: "Press Esc again within 2s to cancel · Ctrl+C to exit", ms: 2000 },
    ])
    dispose()
  })

  test("second Esc within window fires onCancel and paints cancellation transient", () => {
    const status = stubStatusBar()
    const onCancel = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 2000,
      onCancel,
      onAbort: () => undefined,
    })
    fakeStdin.emit({ name: "escape" })
    fakeStdin.emit({ name: "escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(status.calls).toEqual([
      { text: "Press Esc again within 2s to cancel · Ctrl+C to exit", ms: 2000 },
      { text: "⛔ turn cancelled", ms: 1500 },
    ])
    dispose()
  })

  test("second Esc OUTSIDE window resets — no cancel fired", async () => {
    const status = stubStatusBar()
    const onCancel = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 10, // 10 ms window so the test can wait it out
      onCancel,
      onAbort: () => undefined,
    })
    fakeStdin.emit({ name: "escape" })
    await new Promise((r) => setTimeout(r, 25))
    fakeStdin.emit({ name: "escape" })
    expect(onCancel).not.toHaveBeenCalled()
    // Two "press esc again" hints — the second Esc starts a fresh window.
    expect(status.calls.filter((c) => c.text.startsWith("Press Esc"))).toHaveLength(2)
    dispose()
  })

  test("Ctrl+C fires onAbort and paints the interrupt transient", () => {
    const status = stubStatusBar()
    const onAbort = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 2000,
      onCancel: () => undefined,
      onAbort,
    })
    fakeStdin.emit({ name: "c", ctrl: true })
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(status.calls).toEqual([{ text: "⛔ interrupted — exiting…", ms: 1500 }])
    dispose()
  })

  test("non-esc / non-ctrl-c key resets the FSM (a then esc then esc does NOT fire)", () => {
    const status = stubStatusBar()
    const onCancel = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 2000,
      onCancel,
      onAbort: () => undefined,
    })
    fakeStdin.emit({ name: "escape" })
    fakeStdin.emit({ name: "a" }) // resets
    fakeStdin.emit({ name: "escape" })
    expect(onCancel).not.toHaveBeenCalled()
    dispose()
  })

  test("undefined key event is ignored (defensive)", () => {
    const status = stubStatusBar()
    const onCancel = mock(() => undefined)
    const onAbort = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 2000,
      onCancel,
      onAbort,
    })
    // biome-ignore lint/suspicious/noExplicitAny: the path is the explicit defensive guard
    fakeStdin.emit(undefined as any)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onAbort).not.toHaveBeenCalled()
    expect(status.calls).toEqual([])
    dispose()
  })

  test("dispose() removes the keypress listener — subsequent emits do nothing", () => {
    const status = stubStatusBar()
    const onCancel = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 2000,
      onCancel,
      onAbort: () => undefined,
    })
    dispose()
    fakeStdin.emit({ name: "escape" })
    fakeStdin.emit({ name: "escape" })
    expect(onCancel).not.toHaveBeenCalled()
  })

  test("dispose() restores prior raw-mode state", () => {
    fakeStdin.isRaw = false
    const { dispose } = installTurnCancel({
      statusBar: stubStatusBar(),
      escWindowMs: 2000,
      onCancel: () => undefined,
      onAbort: () => undefined,
    })
    expect(fakeStdin.isRaw).toBe(true)
    dispose()
    expect(fakeStdin.isRaw).toBe(false)
  })

  test("dispose() restores prior raw-mode TRUE state (was already raw)", () => {
    fakeStdin.isRaw = true
    const { dispose } = installTurnCancel({
      statusBar: stubStatusBar(),
      escWindowMs: 2000,
      onCancel: () => undefined,
      onAbort: () => undefined,
    })
    dispose()
    expect(fakeStdin.isRaw).toBe(true)
  })

  test("Ctrl+C takes precedence — even after first Esc, Ctrl+C still aborts", () => {
    const status = stubStatusBar()
    const onCancel = mock(() => undefined)
    const onAbort = mock(() => undefined)
    const { dispose } = installTurnCancel({
      statusBar: status,
      escWindowMs: 2000,
      onCancel,
      onAbort,
    })
    fakeStdin.emit({ name: "escape" })
    fakeStdin.emit({ name: "c", ctrl: true })
    expect(onCancel).not.toHaveBeenCalled()
    expect(onAbort).toHaveBeenCalledTimes(1)
    dispose()
  })
})
