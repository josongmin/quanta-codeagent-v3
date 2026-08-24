/**
 * ★ HELLGATE — web-daemon posture FRONT-DOOR wire (RFC-05 E4/E5, E4b web-posture).
 *
 * THE GAP: the WebSocket daemon composes its session via `buildProductionRuntimeFactory`
 * → `buildAgentConfigBase`, BYPASSING `bootstrap-session.ts` (the CLI/stdio door
 * that unconditionally threads `postureControl` + `questionGuard`). So a wire
 * `session.posture.set` carrying a RICH patch (sandboxPolicy / askOutsidePlan /
 * approvalPolicy / reviewer) reached `applyHostPostureMutation` with
 * `control === undefined` ⇒ it applied ONLY `patch.mode` and returned `{ok:true}`,
 * SILENTLY DROPPING every rich field — a false success WORSE than RFC-05's
 * sanctioned "return unsupported" degrade.
 *
 * FIX (Option A — full wire): the daemon reuses the SAME `buildLivePostureRuntime`
 * seam (ONE authority; no second posture authority) via `resolveWebLivePosture`,
 * GATED on `QUANTA_POSTURE_SELECTOR`, and threads `postureControl` + `questionGuard`
 * onto the config base. So the host `session.posture.set` applies the FULL lossless
 * patch through the live authority the next turn's gate + the E5 guard read.
 *
 * RED-on-injection: drop the `postureControl` thread in `agent-config-base.ts` (or
 * make `resolveWebLivePosture` return no control) ⇒ [E4B-1] flips (askOutsidePlan
 * stays `true`, sandbox stays default — the rich field is DROPPED) while the host
 * still answers `{ok:true}` — the exact silent-drop this hellgate closes.
 *
 * Invariants proven:
 *   [E4B-1] selector ON ⇒ a wire `session.posture.set` with a RICH patch APPLIES
 *           the full field through the daemon's live authority (control.describe()
 *           reflects it) AND the E5 questionGuard reads the SAME authority.
 *   [E4B-2] selector OFF ⇒ NO postureControl/questionGuard on the base (mode-only
 *           compat, byte-identical legacy web) — the documented degrade.
 *   [E4B-3] the mode axis still lands on the SAME live cell under selector ON
 *           (the control-request / `session.permission.set` path is unaffected).
 */
import { describe, expect, test } from "bun:test"
import { createCanvasUsageSource } from "@/apps/web-daemon/canvas-usage-source"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import { buildAgentConfigBase } from "@/apps/web-daemon/runtime-factory/agent-config-base"
import {
  resolveWebLivePosture,
  type WebLivePosture,
} from "@/apps/web-daemon/runtime-factory/session-collaborators"
import { wireSessionObservability } from "@/apps/web-daemon/runtime-factory/session-observability"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import type { SessionHost } from "@/kernel/session"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PostureControl } from "@/permission/posture/control"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

const CWD = "/tmp/quanta-web-posture-hellgate"

class StubLLM implements LLMPort {
  readonly model = "stub-model"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Build the daemon config base EXACTLY as `buildProductionRuntimeFactory` does
 *  (same `buildAgentConfigBase` seam), threading the live-posture slice the
 *  factory resolves. Returns the base + the control/guard so the test can assert
 *  the SAME authority the host mutates. */
const buildDaemonBase = async (
  live: WebLivePosture,
  env: Record<string, string | undefined>,
): Promise<RuntimeAgentConfigBase> =>
  await buildAgentConfigBase({
    env,
    llm: new StubLLM(),
    artifactRegistry: undefined,
    askUserTools: [],
    mcpTools: [],
    permission: live.permission,
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
    observability: wireSessionObservability({}, CWD),
    ...(live.postureControl !== undefined ? { postureControl: live.postureControl } : {}),
    ...(live.questionGuard !== undefined ? { questionGuard: live.questionGuard } : {}),
  })

/** Stand up the REAL SessionHost from the daemon base (the exact projection the
 *  wire `session.posture.set` hits: `applyHostPostureMutation(base, …)`). */
const sessionHostFrom = async (base: RuntimeAgentConfigBase): Promise<SessionHost> => {
  const binding = createRuntimeContextBindingFromAgentConfigBase({
    base,
    turnAssembler: buildInteractiveTurnAssembler(),
  })
  const host = binding.createRuntimeHost({
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  return await host.createSessionHost({ cwd: CWD, permissionMode: "default" })
}

describe("RFC-05 E4b — web-daemon posture front-door applies the FULL patch (no silent drop)", () => {
  test("[E4B-1] selector ON ⇒ a wire session.posture.set with a RICH patch APPLIES the field through the live authority", async () => {
    const env = { QUANTA_POSTURE_SELECTOR: "1" }
    const live = resolveWebLivePosture(env)
    // The daemon actually BUILT a control + guard (the wiring the daemon lacked).
    expect(live.postureControl).toBeDefined()
    expect(live.questionGuard).toBeDefined()
    const control = live.postureControl as PostureControl

    const base = await buildDaemonBase(live, env)
    expect(base.postureControl).toBe(control)

    // Baseline: the current-behavior default is ask-outside-plan ON.
    expect(control.describe().effective.askOutsidePlan).toBe(true)
    expect(live.questionGuard?.askOutsidePlan()).toBe(true)

    const host = await sessionHostFrom(base)
    // The RICH field the mode-only degrade would DROP.
    const outcome = await host.setPosture?.({
      patch: { askOutsidePlan: false, sandboxPolicy: { type: "danger-full-access" } },
      scope: "current",
    })

    expect(outcome).toEqual({ ok: true })
    // LOAD-BEARING: the daemon's OWN live authority now reflects the rich fields —
    // NOT silently dropped. (RED-on-injection: unthread postureControl ⇒ these stay
    // at the default while setPosture still answers {ok:true}.)
    const eff = control.describe().effective
    expect(eff.askOutsidePlan).toBe(false)
    expect(eff.threadPermission.sandboxPolicy.type).toBe("danger-full-access")
    // E5 — the question guard reads the SAME authority a `/posture ask off` mutated.
    expect(live.questionGuard?.askOutsidePlan()).toBe(false)

    await host.close()
  })

  test("[E4B-2] selector OFF ⇒ NO postureControl/questionGuard on the base (mode-only compat, byte-identical)", async () => {
    const env = {}
    const live = resolveWebLivePosture(env)
    expect(live.postureControl).toBeUndefined()
    expect(live.questionGuard).toBeUndefined()

    const base = await buildDaemonBase(live, env)
    expect(base.postureControl).toBeUndefined()
    expect(base.questionGuard).toBeUndefined()

    // The mode-only compat fallback: a rich patch cannot be honored (no control),
    // and the legacy behavior answers {ok:true} for the mode-only axis. This is
    // the DOCUMENTED degrade the selector-OFF path preserves.
    const host = await sessionHostFrom(base)
    const outcome = await host.setPosture?.({
      patch: { mode: "acceptEdits" },
      scope: "current",
    })
    expect(outcome).toEqual({ ok: true })
    // Mode-only landed on the live cell (the compat write).
    expect(base.permission.mode).toBe("acceptEdits")
    await host.close()
  })

  test("[E4B-3] selector ON ⇒ the mode axis still lands on the SAME live authority cell (control-request path unaffected)", async () => {
    const env = { QUANTA_POSTURE_SELECTOR: "1" }
    const live = resolveWebLivePosture(env)
    const base = await buildDaemonBase(live, env)
    const host = await sessionHostFrom(base)

    await host.setPosture?.({ patch: { mode: "bypass" }, scope: "current" })
    // The live authority-backed permission cell (the SAME one mintInboundPorts /
    // the per-turn gate read) reflects the mode change.
    expect(base.permission.mode).toBe("bypass")
    expect(live.permission.mode).toBe("bypass")
    await host.close()
  })
})
