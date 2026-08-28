/**
 * ★ HELLGATE — the session's model echo must follow a MID-SESSION switch (aug-28).
 *
 * `KernelSessionState.modelSlug` is captured ONCE, from `host.describe()` at
 * session creation, and it is the single source for four user-facing reports:
 *
 *   - `session.state.updated` → `SessionStateView.modelSlug` → the web `/state`
 *     readout's `model` row and the CLI attach pill (`[session · <model>]`);
 *   - `turn.completed.modelSlug` → the daemon's cumulative `/cost` fold, i.e. the
 *     model a session's whole spend is attributed to;
 *   - the SDK's `session.model` (`engine.ts` reads `box.state.modelSlug`).
 *
 * `/model` (CLI) and the `set_model` control frame (web) now really swap the model
 * per turn, and `describe()` reports the EFFECTIVE model (see
 * `@/agent/effective-model`). But nothing re-read `describe()` on the turn path, so
 * every one of those four kept naming the model the session STARTED with. Worse
 * than missing: `/cost` looks like data.
 *
 * The fix reconciles the model echo from the host at the turn boundary — "what
 * actually ran", which is the only claim these reports can honestly make.
 *
 * RED-on-injection: drop `modelSlug` from `reconcileSessionModelState` (or stop
 * calling it on the turn path) ⇒ cases 2 and 3 fail with the boot model.
 */

import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  type KernelSessionState,
  type SessionHost,
} from "@/kernel/session"
import type { Message } from "@/llm"
import type { CapabilityManifest } from "@/protocol/session"
import { capabilitiesFor } from "../../support/session-fixtures"

/** Through the SSOT fixture, per `tests/unit/_arch/capability-literal-ratchet`:
 *  an inline manifest literal drifts the moment a capability is added. */
const manifest: CapabilityManifest = capabilitiesFor()
const clock = { now: () => new Date("2026-08-28T00:00:00.000Z") }
const messagesOf = (text: string): readonly Message[] => [
  { role: "user", content: [{ type: "text", text }] },
]

/** A host whose `describe().modelSlug` FOLLOWS a live switch — exactly what the
 *  real one now does (`effectiveModelOf` reads the sticky slot the surface owns). */
const switchableHost = (sessionId: string, cell: { model: string }): SessionHost => ({
  describe: () => ({
    sessionId,
    permissionMode: "default" as const,
    capabilityManifest: manifest,
    modelSlug: cell.model,
  }),
  runTurn: async () => ({
    outcome: { reason: "completed", turns: 1, messages: messagesOf("pong") } as AgentOutcome,
    messages: messagesOf("pong"),
  }),
  close: async () => undefined,
})

/** `turn.run` requires a DRAFT (the reducer throws `empty_turn_input` otherwise),
 *  so seed one exactly as a client does before running the turn. */
const runTurn = async (
  seed: KernelSessionState,
  host: SessionHost,
  sessionId: string,
  commandId: string,
) => {
  const eventLog = new InMemorySessionEventLog()
  const appended = await dispatchSessionCommand(
    seed,
    {
      sessionId,
      commandId: `${commandId}-append`,
      issuedAt: clock.now().toISOString(),
      type: "input.append",
      text: "go",
    },
    { clock, eventLog, host },
  )
  return await dispatchSessionCommand(
    appended.state,
    {
      sessionId,
      commandId,
      issuedAt: clock.now().toISOString(),
      type: "turn.run",
    } as never,
    { clock, eventLog, host },
  )
}

describe("the session model echo follows a mid-session switch", () => {
  test("1. creation captures the host's model (the premise — an echo exists at all)", () => {
    const cell = { model: "boot-model" }
    const host = switchableHost("s1", cell)
    const state = createKernelSessionState(host.describe())
    expect(state.modelSlug).toBe("boot-model")
  })

  test("2. after a switch, the next turn's `turn.completed` names the NEW model", async () => {
    const sessionId = "s2"
    const cell = { model: "boot-model" }
    const host = switchableHost(sessionId, cell)
    let state = createKernelSessionState(host.describe())

    // The switch: `/model gpt-4o` or a `set_model` frame. The host now reports it.
    cell.model = "gpt-4o"

    const res = await runTurn(state, host, sessionId, "t1")
    state = res.state
    const completed = res.events.find((e) => e.type === "turn.completed")
    expect(completed).toBeDefined()
    expect((completed as { modelSlug?: string } | undefined)?.modelSlug).toBe("gpt-4o")
  })

  test("3. …and the state VIEW every readout renders is refreshed too", async () => {
    const sessionId = "s3"
    const cell = { model: "boot-model" }
    const host = switchableHost(sessionId, cell)
    const state = createKernelSessionState(host.describe())
    cell.model = "gpt-4o"

    const res = await runTurn(state, host, sessionId, "t1")
    expect(res.state.modelSlug).toBe("gpt-4o")
    // The LAST view, not the first: a dispatch emits one at `turn.started` (where
    // the pre-turn model is still correct) and one at the terminal. What the
    // readouts render is the latest.
    const updated = res.events.filter((e) => e.type === "session.state.updated").at(-1)
    expect((updated as { state?: { modelSlug?: string } } | undefined)?.state?.modelSlug).toBe(
      "gpt-4o",
    )
  })

  test("4. paired control — NO switch ⇒ the echo is unchanged (byte-identical)", async () => {
    const sessionId = "s4"
    const cell = { model: "boot-model" }
    const host = switchableHost(sessionId, cell)
    const state = createKernelSessionState(host.describe())
    const res = await runTurn(state, host, sessionId, "t1")
    expect(res.state.modelSlug).toBe("boot-model")
  })

  test("5. a host that reports NO model leaves the field absent (never a literal undefined)", async () => {
    const sessionId = "s5"
    const host: SessionHost = {
      describe: () => ({ sessionId, permissionMode: "default", capabilityManifest: manifest }),
      runTurn: async () => ({
        outcome: { reason: "completed", turns: 1, messages: messagesOf("pong") } as AgentOutcome,
        messages: messagesOf("pong"),
      }),
      close: async () => undefined,
    }
    const state = createKernelSessionState(host.describe())
    const res = await runTurn(state, host, sessionId, "t1")
    expect("modelSlug" in res.state).toBe(false)
  })
})
