/**
 * ★ HELLGATE — `quanta serve --stdio` per-session objective authority is
 * SESSION-STABLE (serve-stdio objective parity; same root as the web-daemon GAP,
 * a DIFFERENT composition door).
 *
 * THE GAP: `serveOverStdio` opened the served runtime via
 * `openHeadlessRuntimeSession` but NEVER threaded an objective authority. The
 * headless door builds the per-turn AgentConfig from `base` with NO turn
 * assembler (`buildAgentConfigFromBase` spreads `base.objective` straight), and
 * `buildServeStdioDeps` set no objective ⇒ `base.objective` was undefined ⇒ with
 * `QUANTA_OBJECTIVE_TOOLS=1` the model's `objective_*` tools had NO cross-turn
 * store (goal amnesia; the CLI mints ONE at boot via the compose seam, the web
 * daemon at its factory).
 *
 * FIX: `serveOverStdio` mints the ONE session-stable authority via
 * `resolveGatedObjectiveAuthority(env, {confirmationAvailable:false})` (headless /
 * no inline operator ⇒ fail-closed under QUANTA_PROPOSE_GOAL, the SAME posture as
 * web) and threads it through the headless `input.objective` → runtime overlay →
 * `base.objective` (`buildBootstrapBaseShape`'s new `...whenDefined("objective",
 * args.overlay?.objective)`). Ephemeral by design: the served session owns no
 * persistent store, so a FRESH mint is correct (no durable restore).
 *
 * RED-on-injection: drop the overlay `objective` spread in
 * `context-binding/base.ts` (`...whenDefined("objective", args.overlay?.objective)`)
 * ⇒ [SS-1]/[SS-2]/[SS-BRIDGE] flip (`base.objective` undefined ⇒ the two turns'
 * `cfg.objective` are BOTH undefined, not one stable port). Captured RED (see the
 * final report).
 *
 * Invariants proven — driving the REAL serve-stdio composition (`buildServeStdioDeps`
 * → `bootstrapSession` → `buildBaseFromBootstrap(overlay)` → `buildAgentConfigFromBase`):
 *   [SS-1]      TOOLS on ⇒ `base.objective` is a DEFINED port === the minted authority.
 *   [SS-2]      the REAL per-turn config builder ADOPTS the SAME instance across TWO
 *               turns (identity `toBe` — the actual amnesia bug), not a fresh re-mint.
 *   [SS-3]      TOOLS off ⇒ the resolver returns undefined ⇒ `base.objective` undefined
 *               (paired control, byte-identical default-OFF).
 *   [SS-BRIDGE] the REAL public headless door (`openHeadlessRuntimeSession`) threads
 *               `input.objective` all the way onto the session base (session-bridge
 *               overlay wire), proving the wire serve-stdio actually rides.
 */

import { describe, expect, test } from "bun:test"
import { buildServeStdioDeps, buildServeStdioRuntime } from "@/apps/cli/serve-stdio-cmd"
import { openHeadlessRuntimeSession, RecordingStream } from "@/apps/headless"
import { bootstrapSession } from "@/host/bootstrap"
import {
  buildAgentConfigFromBase,
  buildBaseFromBootstrap,
} from "@/host/runtime/internal/context-binding/base"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ObjectivePort } from "@/objective"

const CWD = "/tmp/quanta-serve-stdio-objective-hellgate"

/** Deterministic no-network LLM (a single `end_turn`) — the composition never
 *  calls it in these open-only assertions; it exists so the bootstrap has a real
 *  `LLMPort`. */
class StubLLM implements LLMPort {
  readonly model = "stub-model"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** A denying no-op confirm port (headless surfaces have no inline operator; the
 *  base builder requires a non-undefined `onConfirm`). `false` = deny. */
const denyConfirm = async (): Promise<boolean> => false

/** Drive the REAL serve-stdio deps → bootstrap → base path with the SAME
 *  objective mint + overlay thread `serveOverStdio` uses, and return the base +
 *  the minted authority so the test can assert single-instance identity. */
const buildServeStdioBaseWithObjective = async (
  env: Record<string, string | undefined>,
): Promise<{ base: unknown; objective: ObjectivePort | undefined }> => {
  const stream = new RecordingStream()
  const deps = buildServeStdioDeps(new StubLLM(), stream)
  const runtime = buildServeStdioRuntime(
    { cwd: CWD, model: undefined, permissionMode: "default" },
    "openai",
    "stub-model",
  )
  const boot = await bootstrapSession(deps, runtime, {})
  // The EXACT call serveOverStdio makes (headless ⇒ confirmationAvailable:false).
  const objective = resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })
  const base = buildBaseFromBootstrap({
    boot,
    stream,
    onConfirm: denyConfirm,
    // Mirrors the headless session-bridge overlay thread (input.objective → overlay).
    overlay: { ...(objective !== undefined ? { objective } : {}) },
  })
  return { base, objective }
}

const objectiveOf = (cfgOrBase: unknown): ObjectivePort | undefined =>
  (cfgOrBase as { objective?: ObjectivePort }).objective

describe("serve-stdio objective parity — per-session objective is session-stable", () => {
  test("[SS-1] OBJECTIVE_TOOLS on ⇒ base.objective is a DEFINED port === the minted authority (RED on unfixed: undefined)", async () => {
    const { base, objective } = await buildServeStdioBaseWithObjective({
      QUANTA_OBJECTIVE_TOOLS: "1",
    })
    expect(objective).toBeDefined()
    expect(objectiveOf(base)).toBeDefined()
    expect(objectiveOf(base)).toBe(objective)
  })

  test("[SS-2] the REAL per-turn config builder ADOPTS the SAME instance across TWO turns (no re-mint = no goal amnesia)", async () => {
    const env = { QUANTA_OBJECTIVE_TOOLS: "1" }
    const { base, objective } = await buildServeStdioBaseWithObjective(env)
    // `buildAgentConfigFromBase` is exactly what the headless runtime invokes per
    // turn (no turnAssembler on this door). Two turns → two configs.
    const cfgTurn1 = buildAgentConfigFromBase({ base: base as never, messages: [] })
    const cfgTurn2 = buildAgentConfigFromBase({ base: base as never, messages: [] })
    const obj1 = objectiveOf(cfgTurn1)
    const obj2 = objectiveOf(cfgTurn2)
    expect(obj1).toBeDefined()
    // IDENTITY, not deep-equal: the SAME authority every turn. On the unfixed base
    // (objective undefined) BOTH turns carry undefined ⇒ obj1 !== the port.
    expect(obj1).toBe(obj2)
    expect(obj1).toBe(objective)
  })

  test("[SS-3] OBJECTIVE_TOOLS off ⇒ resolver undefined ⇒ base.objective undefined (paired control, byte-identical default-OFF)", async () => {
    const { base, objective } = await buildServeStdioBaseWithObjective({})
    expect(objective).toBeUndefined()
    expect(objectiveOf(base)).toBeUndefined()
    const cfg = buildAgentConfigFromBase({ base: base as never, messages: [] })
    expect(objectiveOf(cfg)).toBeUndefined()
  })

  test("[SS-BRIDGE] the REAL public headless door threads input.objective all the way onto the session base", async () => {
    const stream = new RecordingStream()
    const deps = buildServeStdioDeps(new StubLLM(), stream)
    const runtime = buildServeStdioRuntime(
      { cwd: CWD, model: undefined, permissionMode: "default" },
      "openai",
      "stub-model",
    )
    const objective = resolveGatedObjectiveAuthority(
      { QUANTA_OBJECTIVE_TOOLS: "1" },
      { confirmationAvailable: false },
    )
    expect(objective).toBeDefined()
    const bridge = await openHeadlessRuntimeSession({
      input: {
        prompt: "",
        cwd: CWD,
        env: { QUANTA_OBJECTIVE_TOOLS: "1" },
        ...(objective !== undefined ? { objective } : {}),
      },
      deps,
      runtime,
      stream,
    })
    try {
      // The runtime-context snapshot surfaces `base.objective` (buildOptionalSnapshotFields).
      const snapshotObjective = (
        bridge.runtimeContext as unknown as { state: { snapshot: { objective?: ObjectivePort } } }
      ).state.snapshot.objective
      expect(snapshotObjective).toBe(objective)
    } finally {
      await bridge.session.close()
    }
  })
})
