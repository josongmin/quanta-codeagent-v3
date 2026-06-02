/**
 * RFC-08 / ADR-0443 hellgate — permission/agent mode-cycle + shift+tab.
 *
 * Two layers:
 *   A. PURE module (mode-cycle.ts): cycle order + wrap, store mutation, meta
 *      formatting, env gate. No IO.
 *   B. raw-line-reader shift+tab integration: the keypress advances via the
 *      injected `onCycleMode` hook and repaints; plain Tab is NOT consumed by
 *      the guard; absent hook ⇒ shift+tab is an ignored no-op (byte-identical).
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  createModeCycleStore,
  DEFAULT_POSTURE,
  formatPostureMeta,
  MODE_CYCLE,
  modeCycleEnabled,
  nextPosture,
  postureByKey,
} from "../mode-cycle"
import { type ReadLineTestIO, readLine } from "../raw-line-reader"

interface KeyEvent {
  readonly name?: string
  readonly ctrl?: boolean
  readonly shift?: boolean
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

// ── A. pure module ────────────────────────────────────────────────────────

describe("mode-cycle — pure cycle/store (§4.1)", () => {
  test("A1 — cycle has the 4 claude-cli postures in fixed order", () => {
    expect(MODE_CYCLE.map((p) => p.key)).toEqual(["default", "acceptEdits", "plan", "bypass"])
  })

  test("A2 — nextPosture advances and WRAPS", () => {
    expect(nextPosture("default").key).toBe("acceptEdits")
    expect(nextPosture("acceptEdits").key).toBe("plan")
    expect(nextPosture("plan").key).toBe("bypass")
    expect(nextPosture("bypass").key).toBe("default") // wrap
  })

  test("A3 — every posture projects onto an EXISTING PermissionMode (no invented mode)", () => {
    const valid = new Set(["default", "acceptEdits", "bypass", "auto"])
    for (const p of MODE_CYCLE) expect(valid.has(p.permissionMode)).toBe(true)
    // plan rung is the read-only AgentMode projection, permission stays default
    const plan = postureByKey("plan")
    expect(plan.agentMode).toBe("plan")
    expect(plan.permissionMode).toBe("default")
  })

  test("A4 — store seeds at DEFAULT and cycle() mutates + returns the new posture", () => {
    const s = createModeCycleStore()
    expect(s.current().key).toBe("default")
    expect(s.cycle().key).toBe("acceptEdits")
    expect(s.current().key).toBe("acceptEdits") // persisted
    s.cycle()
    s.cycle()
    expect(s.current().key).toBe("bypass")
    expect(s.cycle().key).toBe("default") // wrap persisted
  })

  test("A5 — formatPostureMeta renders the label + desc + affordance", () => {
    const meta = formatPostureMeta(postureByKey("bypass"))
    expect(meta).toContain("BYPASS")
    expect(meta).toContain("runs without asking")
    expect(meta).toContain("shift+tab")
  })

  test("A6 — env gate: only QUANTA_MODE_CYCLE=1 enables", () => {
    expect(modeCycleEnabled({ QUANTA_MODE_CYCLE: "1" })).toBe(true)
    expect(modeCycleEnabled({ QUANTA_MODE_CYCLE: "0" })).toBe(false)
    expect(modeCycleEnabled({})).toBe(false)
  })

  test("A7 — postureByKey unknown ⇒ DEFAULT (never throws)", () => {
    expect(postureByKey("nope")).toBe(DEFAULT_POSTURE)
  })
})

// ── B. raw-line-reader shift+tab integration ──────────────────────────────

describe("mode-cycle — raw-line-reader shift+tab (§4.2)", () => {
  test("B1 — shift+tab invokes onCycleMode and does NOT submit", async () => {
    const { io, stdin } = makeIO()
    let cycles = 0
    const p = readLine(
      {
        prompt: "› ",
        meta: "initial",
        onCycleMode: () => {
          cycles += 1
          return { meta: `cycle-${cycles}` }
        },
      },
      io,
    )
    // shift+tab twice, then type + Enter — the line still submits the typed buf.
    stdin.key(undefined, { name: "tab", shift: true })
    stdin.key(undefined, { name: "tab", shift: true })
    stdin.key("h", { name: "h", sequence: "h" })
    stdin.key("i", { name: "i", sequence: "i" })
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("hi")
    expect(cycles).toBe(2) // both shift+tabs cycled; neither submitted
  })

  test("B2 — backtab CSI Z sequence also cycles", async () => {
    const { io, stdin } = makeIO()
    let cycled = false
    const p = readLine(
      {
        prompt: "› ",
        meta: "m",
        onCycleMode: () => {
          cycled = true
        },
      },
      io,
    )
    stdin.key(undefined, { sequence: "\x1b[Z" }) // CSI Z = backtab
    stdin.key(undefined, { name: "return" })
    await p
    expect(cycled).toBe(true)
  })

  test("B3 — plain Tab is NOT consumed by the cycle guard (no onCycleMode call)", async () => {
    const { io, stdin } = makeIO()
    let cycles = 0
    const p = readLine(
      {
        prompt: "› ",
        meta: "m",
        completer: () => [], // no completion candidates ⇒ Tab is inert
        onCycleMode: () => {
          cycles += 1
        },
      },
      io,
    )
    stdin.key(undefined, { name: "tab" }) // plain Tab, shift falsy
    stdin.key("x", { name: "x", sequence: "x" })
    stdin.key(undefined, { name: "return" })
    expect(await p).toBe("x")
    expect(cycles).toBe(0) // the cycle guard never fired for plain Tab
  })

  test("B4 — absent onCycleMode ⇒ shift+tab is an ignored no-op", async () => {
    const run = async (withShiftTab: boolean): Promise<string> => {
      const { io, stdin } = makeIO()
      const p = readLine({ prompt: "› ", meta: "m" }, io)
      if (withShiftTab) stdin.key(undefined, { name: "tab", shift: true })
      stdin.key("o", { name: "o", sequence: "o" })
      stdin.key(undefined, { name: "return" })
      return p
    }
    expect(await run(true)).toBe("o")
    expect(await run(false)).toBe("o")
  })
})
