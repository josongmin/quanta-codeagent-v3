import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { bunPtyFactory } from "../pty-backend"

/**
 * host-casts — `bunPtyFactory().open` constructs `Bun.Terminal` with the
 * data/exit callbacks as CONSTRUCTOR OPTIONS (Bun 1.3.14 API), not methods.
 *
 * The construction site previously cast the options literal through
 * `as unknown as { cols; rows }`, which DISCARDED the callback contract: a future
 * edit that dropped/renamed `data`/`exit` would compile cleanly yet leave the
 * ring buffer permanently empty at runtime. The fix declares the real
 * `BunTerminalOptions` (cols/rows/data/exit) so construction is type-checked.
 *
 * This wiring-proof stubs `Bun.Terminal` and asserts the ctor RECEIVES the
 * data/exit callbacks AND that invoking them drives `open`'s `onData`/`onExit`.
 * Removing either callback from the construction site (the gap the old cast
 * hid) makes these assertions RED.
 */

interface RecordedOpts {
  cols: number
  rows: number
  data?: (terminal: unknown, bytes: Uint8Array) => void
  exit?: (terminal: unknown, code: number) => void
}

const bunGlobal = Bun as unknown as { Terminal?: unknown }
let originalTerminal: unknown
let recorded: RecordedOpts | undefined

beforeEach(() => {
  originalTerminal = bunGlobal.Terminal
  recorded = undefined
  // Fake ctor that records the options literal it was constructed with.
  bunGlobal.Terminal = class FakeTerminal {
    constructor(opts: RecordedOpts) {
      recorded = opts
    }
    write(_data: string | Uint8Array): number {
      return 0
    }
    resize(_cols: number, _rows: number): void {}
  }
})

afterEach(() => {
  bunGlobal.Terminal = originalTerminal
})

describe("bunPtyFactory.open — Bun.Terminal ctor option contract", () => {
  test("passes cols/rows AND data/exit callbacks as constructor options", () => {
    const factory = bunPtyFactory("/tmp/jail-root")
    factory.open({ cols: 80, rows: 24, onData: () => {}, onExit: () => {} })

    expect(recorded).toBeDefined()
    expect(recorded?.cols).toBe(80)
    expect(recorded?.rows).toBe(24)
    // The callback contract the old `as unknown` cast discarded — both MUST be
    // wired as constructor options (Bun.Terminal exposes no onData/onExit methods).
    expect(typeof recorded?.data).toBe("function")
    expect(typeof recorded?.exit).toBe("function")
  })

  test("the ctor `data` callback routes bytes to open's onData", () => {
    const seen: Uint8Array[] = []
    const factory = bunPtyFactory("/tmp/jail-root")
    factory.open({ cols: 80, rows: 24, onData: (b) => seen.push(b), onExit: () => {} })

    const payload = new Uint8Array([1, 2, 3])
    recorded?.data?.(undefined, payload)
    expect(seen).toEqual([payload])
  })

  test("the ctor `exit` callback drives open's onExit", () => {
    let exited = false
    const factory = bunPtyFactory("/tmp/jail-root")
    factory.open({ cols: 80, rows: 24, onData: () => {}, onExit: () => (exited = true) })

    recorded?.exit?.(undefined, 0)
    expect(exited).toBe(true)
  })
})
