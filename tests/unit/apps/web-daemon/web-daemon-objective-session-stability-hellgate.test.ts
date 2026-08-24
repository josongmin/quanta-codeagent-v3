/**
 * ★ HELLGATE — web-daemon per-session objective authority is SESSION-STABLE and
 * DECOUPLED from observability (RFC-03 H1 web-parity follow-on).
 *
 * THE GAP: on the web daemon the objective authority was minted INSIDE
 * `wireSessionObservability`, which EARLY-RETURNS when `QUANTA_OBSERVABILITY !==
 * "on"`. So with `QUANTA_OBJECTIVE_TOOLS=1` but observability UNSET, the mint
 * never ran ⇒ `base.objective` was undefined at boot ⇒ the per-turn assembler's
 * `maybeWireObjective` minted a FRESH `ObjectivePort` EVERY turn ⇒ cross-turn
 * goal amnesia, a silent no-op `session.objective.mutate`, and an empty
 * `webObjectiveSnapshot`. The CLI does it right: it mints ONE session-stable
 * authority at boot INDEPENDENT of observability. This closes that parity gap.
 *
 * FIX: the factory (`buildProductionRuntimeFactory`) mints the authority ONCE via
 * `resolveGatedObjectiveAuthority(env, {confirmationAvailable:false})` and threads
 * it onto `base.objective` through `buildAgentConfigBase`, INDEPENDENT of the
 * observability gate. The SAME instance is fed into `wireSessionObservability` for
 * approval-attribution (no double-mint / split-brain).
 *
 * RED-on-injection: drop the `objective` thread in `agent-config-base.ts`
 * (`...(objective !== undefined ? { objective } : {})`) ⇒ [OBJ-1] flips
 * (`base.objective` undefined) and [OBJ-2] flips (a fresh port is re-minted each
 * turn ⇒ the two turns' `cfg.objective` are DIFFERENT instances). Captured RED.
 *
 * Invariants proven:
 *   [OBJ-1] TOOLS on, OBSERVABILITY unset ⇒ `base.objective` is a defined port.
 *   [OBJ-2] the per-turn assembler ADOPTS the SAME instance across TWO turns
 *           (identity — the actual amnesia bug), not a fresh re-mint.
 *   [OBJ-3] TOOLS on + OBSERVABILITY on ⇒ `base.objective` and the obs wire's
 *           attribution authority are the SAME instance (single authority).
 *   [OBJ-4] TOOLS off ⇒ `base.objective` undefined (obs on AND obs off).
 */

import { describe, expect, test } from "bun:test"
import { createCanvasUsageSource } from "@/apps/web-daemon/canvas-usage-source"
import { buildAgentConfigBase } from "@/apps/web-daemon/runtime-factory/agent-config-base"
import { resolveWebLivePosture } from "@/apps/web-daemon/runtime-factory/session-collaborators"
import { wireSessionObservability } from "@/apps/web-daemon/runtime-factory/session-observability"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ObjectivePort } from "@/objective"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

const CWD = "/tmp/quanta-web-objective-hellgate"

class StubLLM implements LLMPort {
  readonly model = "stub-model"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Build the daemon base EXACTLY as `buildProductionRuntimeFactory` composes it:
 *  mint the session-stable objective ONCE (web has no `onConfirm` ⇒
 *  `confirmationAvailable:false`), feed the SAME instance into the obs wire AND
 *  thread it onto the base. Returns the base + the minted objective + the obs
 *  handle so the test can assert single-instance identity across all three. */
const buildDaemonBaseWithObjective = async (
  env: Record<string, string | undefined>,
): Promise<{
  readonly base: RuntimeAgentConfigBase
  readonly objective: ObjectivePort | undefined
  readonly observability: ReturnType<typeof wireSessionObservability>
}> => {
  const objective = resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })
  const observability = wireSessionObservability(env, CWD, objective)
  const { permission } = await resolveWebLivePosture(env)
  const base = await buildAgentConfigBase({
    env,
    llm: new StubLLM(),
    artifactRegistry: undefined,
    askUserTools: [],
    mcpTools: [],
    permission,
    cwd: CWD,
    abort: new AbortController(),
    subagent: undefined,
    skills: undefined,
    planStore: undefined,
    usageHolder: createCanvasUsageSource(),
    canvasToolDiff: undefined,
    agentState: undefined,
    subagentSource: undefined,
    userInput: undefined,
    controlRequest: undefined,
    follower: undefined,
    observability,
    ...(objective !== undefined ? { objective } : {}),
  })
  return { base, objective, observability }
}

describe("RFC-03 H1 (web parity) — per-session objective is session-stable + observability-decoupled", () => {
  test("[OBJ-1] OBJECTIVE_TOOLS on, OBSERVABILITY unset ⇒ base.objective is a DEFINED port (RED on unfixed: undefined)", async () => {
    const { base, objective } = await buildDaemonBaseWithObjective({ QUANTA_OBJECTIVE_TOOLS: "1" })
    expect(objective).toBeDefined()
    // The load-bearing assertion the old obs-coupling broke: the base carries a
    // real ObjectivePort even with observability OFF.
    expect((base as { objective?: ObjectivePort }).objective).toBeDefined()
    expect((base as { objective?: ObjectivePort }).objective).toBe(objective)
  })

  test("[OBJ-2] the per-turn assembler ADOPTS the SAME instance across TWO turns (no per-turn re-mint = no goal amnesia)", async () => {
    const env = { QUANTA_OBJECTIVE_TOOLS: "1" }
    const { base } = await buildDaemonBaseWithObjective(env)
    // Drive the REAL per-turn assembler (`assembleAgentConfig` → `maybeWireObjective`)
    // twice, exactly as the runtime invokes it once per turn. `turnDeps` is the base.
    const assemble = buildInteractiveTurnAssembler({}, env)
    const cfgTurn1 = assemble([], base as never)
    const cfgTurn2 = assemble([], base as never)
    const obj1 = (cfgTurn1 as { objective?: ObjectivePort }).objective
    const obj2 = (cfgTurn2 as { objective?: ObjectivePort }).objective
    expect(obj1).toBeDefined()
    // IDENTITY, not deep-equal: the SAME authority is threaded every turn (the
    // caller-override in `maybeWireObjective`). On the unfixed base (objective
    // undefined) each turn MINTS a fresh port ⇒ obj1 !== obj2 (the amnesia bug).
    expect(obj1).toBe(obj2)
    expect(obj1).toBe((base as { objective?: ObjectivePort }).objective)
  })

  test("[OBJ-3] OBJECTIVE_TOOLS on + OBSERVABILITY on ⇒ base.objective and the obs attribution authority are the SAME instance (no split-brain)", async () => {
    const { base, objective, observability } = await buildDaemonBaseWithObjective({
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_OBSERVABILITY: "on",
    })
    expect(objective).toBeDefined()
    // The obs wire attributes approvals against the SAME injected authority.
    expect(observability.handle.objective).toBe(objective)
    // The base carries that SAME instance (single authority end-to-end).
    expect((base as { objective?: ObjectivePort }).objective).toBe(objective)
    expect((base as { objective?: ObjectivePort }).objective).toBe(observability.handle.objective)
  })

  test("[OBJ-4] OBJECTIVE_TOOLS off ⇒ base.objective undefined (paired control: obs OFF)", async () => {
    const { base, objective } = await buildDaemonBaseWithObjective({})
    expect(objective).toBeUndefined()
    expect((base as { objective?: ObjectivePort }).objective).toBeUndefined()
  })

  test("[OBJ-4b] OBJECTIVE_TOOLS off + OBSERVABILITY on ⇒ base.objective STILL undefined (obs alone never leaks an authority)", async () => {
    const { base, objective, observability } = await buildDaemonBaseWithObjective({
      QUANTA_OBSERVABILITY: "on",
    })
    expect(objective).toBeUndefined()
    expect((base as { objective?: ObjectivePort }).objective).toBeUndefined()
    expect(observability.handle.objective).toBeUndefined()
  })
})
