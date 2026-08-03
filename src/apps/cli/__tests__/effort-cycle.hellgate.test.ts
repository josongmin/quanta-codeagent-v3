/**
 * RFC-08 BUILD-1 hellgate — bindable `effort-cycle` key action.
 *
 * Two layers (mirrors the mode-cycle hellgate split):
 *   A. PURE leaf (`effort-cycle.ts`): `nextSupportedEffort` cycle table — wrap,
 *      sparse order, unsupported→defaultEffort recovery, non-reasoning fixpoint,
 *      unknown-metadata canonical five-tier fallback. No IO.
 *   B. raw-line-reader integration: a CONFIGURED chord bound to `effort-cycle`
 *      invokes the injected `onCycleEffort` hook exactly ONCE, does NOT submit,
 *      and leaves the draft buffer unchanged; an UNCONFIGURED action and an
 *      ABSENT hook fire the callback ZERO times (byte-identical gate-OFF).
 *
 * RED-on-injection: the reader B-tests fail if the `action === "effort-cycle"`
 * dispatch branch in `keymap.ts` is removed (an enum-only add is vacuous). The
 * A-tests are the pure contract; the B-tests are the live-handler proof.
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { EffortLevel } from "@/agent"
import type { ModelEffortSupport } from "@/llm/provider-metadata"
import { nextSupportedEffort } from "../effort-cycle"
import { ACTION_SET } from "../keybindings/types"
import { type ReadLineTestIO, readLine } from "../raw-line-reader"

// ── shared fake IO (same shape as mode-cycle.hellgate) ─────────────────────
interface KeyEvent {
  readonly name?: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly sequence?: string
}
class FakeStdin extends EventEmitter {
  readonly isTTY = false
  resume(): void {}
  pause(): void {}
  key(str: string | undefined, key: KeyEvent = {}): void {
    this.emit("keypress", str, key)
  }
}
class FakeStdout {
  chunks: string[] = []
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
  get bytes(): string {
    return this.chunks.join("")
  }
}
const makeIO = (): { io: ReadLineTestIO; stdin: FakeStdin; stdout: FakeStdout } => {
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  return {
    io: {
      stdin: stdin as unknown as ReadLineTestIO["stdin"],
      stdout,
      skipKeypressSetup: true,
    },
    stdin,
    stdout,
  }
}

const FIVE_TIER: ModelEffortSupport = {
  supportedEfforts: ["default", "low", "medium", "high", "max"],
  defaultEffort: "default",
  reasoning: true,
}
const NON_REASONING: ModelEffortSupport = {
  supportedEfforts: ["default"],
  defaultEffort: "default",
  reasoning: false,
}
const SPARSE: ModelEffortSupport = {
  // Deliberately out of canonical intensity order to prove the cycle follows
  // the DECLARED order, not the canonical vocabulary order.
  supportedEfforts: ["low", "high", "default"],
  defaultEffort: "low",
  reasoning: true,
}

// ── A. pure cycle leaf ─────────────────────────────────────────────────────
describe("effort-cycle — pure nextSupportedEffort", () => {
  test("A1 — five-tier wraps default→low→medium→high→max→default", () => {
    const order: EffortLevel[] = ["default", "low", "medium", "high", "max"]
    for (let i = 0; i < order.length; i++) {
      const expected = order[(i + 1) % order.length]
      expect(nextSupportedEffort(order[i], FIVE_TIER)).toBe(expected)
    }
    // Explicit wrap witness.
    expect(nextSupportedEffort("max", FIVE_TIER)).toBe("default")
  })

  test("A2 — sparse supported list advances in DECLARED order + wraps", () => {
    expect(nextSupportedEffort("low", SPARSE)).toBe("high")
    expect(nextSupportedEffort("high", SPARSE)).toBe("default")
    expect(nextSupportedEffort("default", SPARSE)).toBe("low") // wrap
  })

  test("A3 — unsupported current tier recovers to model defaultEffort (NOT next)", () => {
    // `medium` is not in SPARSE.supportedEfforts ⇒ recover to defaultEffort=low.
    expect(nextSupportedEffort("medium", SPARSE)).toBe("low")
    // `high` is unsupported by a non-reasoning model ⇒ recover to default.
    expect(nextSupportedEffort("high", NON_REASONING)).toBe("default")
  })

  test("A4 — non-reasoning ['default'] is a fixpoint", () => {
    expect(nextSupportedEffort("default", NON_REASONING)).toBe("default")
  })

  test("A5 — unknown metadata (undefined) cycles the canonical five tiers", () => {
    expect(nextSupportedEffort("default", undefined)).toBe("low")
    expect(nextSupportedEffort("low", undefined)).toBe("medium")
    expect(nextSupportedEffort("high", undefined)).toBe("max")
    expect(nextSupportedEffort("max", undefined)).toBe("default") // wrap
  })

  test("A6 — 'effort-cycle' is a valid bindable action in the closed enum", () => {
    expect(ACTION_SET.has("effort-cycle")).toBe(true)
  })
})

// ── B. raw-line-reader CONFIGURED-chord integration ────────────────────────
describe("effort-cycle — raw-line-reader configured chord", () => {
  test("B1 — a chord bound to effort-cycle fires onCycleEffort once, no submit, buffer unchanged", async () => {
    const { io, stdin } = makeIO()
    // `alt+e` — a chord `keyOf` can project (shift is NOT projected onto letter
    // keys, so `alt+shift+e` would never match; `alt+e` is the real bindable form).
    const keybindings = new Map([["alt+e", "effort-cycle" as const]])
    let cycles = 0
    const p = readLine(
      {
        prompt: "› ",
        keybindings,
        onCycleEffort: () => {
          cycles += 1
        },
      },
      io,
    )
    // Type "ab", press the bound chord twice, then Enter. The chord must NOT
    // submit and must NOT alter the draft buffer.
    stdin.key("a", { name: "a", sequence: "a" })
    stdin.key("b", { name: "b", sequence: "b" })
    stdin.key(undefined, { name: "e", meta: true, sequence: "\x1be" })
    stdin.key(undefined, { name: "e", meta: true, sequence: "\x1be" })
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("ab") // buffer preserved; the chord never inserted / submitted
    expect(cycles).toBe(2) // both presses cycled
  })

  test("B2 — an UNCONFIGURED action (no chord mapped) never fires the callback", async () => {
    const { io, stdin } = makeIO()
    // keybindings present, but NO chord maps to effort-cycle.
    const keybindings = new Map([["ctrl+r", "reverse-search" as const]])
    let cycles = 0
    const p = readLine(
      {
        prompt: "› ",
        keybindings,
        onCycleEffort: () => {
          cycles += 1
        },
      },
      io,
    )
    stdin.key(undefined, { name: "e", meta: true, sequence: "\x1be" })
    stdin.key("z", { name: "z", sequence: "z" })
    stdin.key(undefined, { name: "return" })
    await p
    expect(cycles).toBe(0) // no chord bound ⇒ callback never invoked
  })

  test("B3 — ABSENT onCycleEffort ⇒ a bound chord is an inert no-op (byte-identical)", async () => {
    const run = async (withHook: boolean): Promise<string> => {
      const { io, stdin } = makeIO()
      // `alt+e` — a chord `keyOf` can project (shift is NOT projected onto letter
      // keys, so `alt+shift+e` would never match; `alt+e` is the real bindable form).
      const keybindings = new Map([["alt+e", "effort-cycle" as const]])
      const p = readLine(
        {
          prompt: "› ",
          keybindings,
          // hook present only in the `withHook` arm.
          ...(withHook ? { onCycleEffort: () => {} } : {}),
        },
        io,
      )
      stdin.key(undefined, { name: "e", meta: true, sequence: "\x1be" })
      stdin.key("q", { name: "q", sequence: "q" })
      stdin.key(undefined, { name: "return" })
      return p
    }
    // With no hook wired the chord is consumed but does nothing; the draft is
    // just the typed "q" either way (the chord itself never inserts a char).
    expect(await run(false)).toBe("q")
    expect(await run(true)).toBe("q")
  })
})
