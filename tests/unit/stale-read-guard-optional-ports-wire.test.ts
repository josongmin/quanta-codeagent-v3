/**
 * WIRING PROOF — the stale-read guard's state must be minted by the wire the
 * INTERACTIVE CLI actually runs.
 *
 * ADR-0474 is DEFAULT-ON, and it was still inert in the shipped CLI. The state
 * was minted only inside `assembleAgentConfig`'s capability registry, but the
 * CLI binds its runtime through `context-binding/base.ts`, which calls
 * `wireOptionalAgentPorts` and nothing else. Every existing test either built
 * `ReadFileState` by hand or drove the assembler, so all of them passed while
 * the product had no guard at all.
 *
 * These assertions are deliberately about the WIRE, not about guard behaviour
 * (that is covered by the state's own suites, and end-to-end through a real CLI
 * in `tests/e2e-pty/cli-stale-read-guard-e2e.test.ts`).
 */

import { describe, expect, test } from "bun:test"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import { ReadFileState } from "@/tool/stale-read-guard"

const base = () =>
  ({
    llm: { model: "m", stream: async function* () {} },
    signal: new AbortController().signal,
  }) as unknown as Parameters<typeof wireOptionalAgentPorts>[0]

describe("stale-read guard — wireOptionalAgentPorts (the CLI's wire)", () => {
  test("mints the per-session state by DEFAULT (no env set)", () => {
    const wired = wireOptionalAgentPorts(base(), {})
    expect(wired.readFileState).toBeInstanceOf(ReadFileState)
  })

  test("the EXACT strict kill-switch opts out", () => {
    const wired = wireOptionalAgentPorts(base(), { QUANTA_STALE_READ_GUARD: "off" })
    expect(wired.readFileState).toBeUndefined()
  })

  test("a stray falsy token does NOT disable it (strict gate, not truthiness)", () => {
    for (const v of ["0", "false", "no", ""]) {
      const wired = wireOptionalAgentPorts(base(), { QUANTA_STALE_READ_GUARD: v })
      expect(wired.readFileState).toBeInstanceOf(ReadFileState)
    }
  })

  test("caller-override-safe — an already-minted state is kept, never replaced", () => {
    const mine = new ReadFileState()
    const withState = { ...base(), readFileState: mine } as Parameters<
      typeof wireOptionalAgentPorts
    >[0]
    const wired = wireOptionalAgentPorts(withState, {})
    // Same INSTANCE: two wiring paths must not mint two states for one session,
    // or a read recorded through one is invisible to a write checked by the other.
    expect(wired.readFileState).toBe(mine)
  })
})
